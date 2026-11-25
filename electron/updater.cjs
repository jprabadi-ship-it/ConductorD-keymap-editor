// Self-update for the packaged Mac app.
//
// electron-updater (Squirrel.Mac) wants a zip target plus update metadata
// that this project does not publish; the releases only carry a notarized
// DMG. So this does the same job by hand: ask, download the DMG, copy the
// app out of it and verify it, then hand over to a detached shell script
// that waits for this process to exit, swaps the bundle and starts it again.
const { app, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const execFileAsync = promisify(execFile)

const RELEASES_API = 'https://api.github.com/repos/jprabadi-ship-it/ConductorD-keymap-editor/releases/latest'
const DMG_NAME_RE = /^ConductorD-Studio-(\d+\.\d+\.\d+)-mac-arm64\.dmg$/
// What a genuine build is signed as; anything else is refused before it can
// replace the installed app.
const TEAM_ID = '3HCG7Y94FX'
const BUNDLE_ID = 'com.jprabadi.conductor-keymap-editor'

// Lets an automated run exercise the whole flow without a person to click
// the dialogs: the prompt is taken as accepted and errors go to the log.
const UNATTENDED = process.env.CONDUCTOR_UPDATE_UNATTENDED === '1'

const stageDir = () => path.join(app.getPath('userData'), 'update-staging')
const logFile = () => path.join(app.getPath('userData'), 'update.log')

// idle | checking | downloading | preparing | installing
const state = { phase: 'idle', percent: 0, version: null }

function isNewer(latest, current) {
  const a = latest.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d !== 0) return d > 0
  }
  return false
}

// The .app this process runs from, when it is somewhere this process can
// replace it; otherwise the reason it cannot.
function installTarget() {
  if (!app.isPackaged) return { reason: '開発用の起動のため' }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return { reason: 'このMac向けの配布ファイルが無いため' }
  }
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..')
  if (!bundle.endsWith('.app')) return { reason: 'アプリの場所を特定できないため' }
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return { reason: 'ディスクイメージから直接起動しているため(アプリケーションフォルダへコピーしてから起動してください)' }
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
  } catch {
    return { reason: 'アプリの置き場所に書き込めないため' }
  }
  return { bundle }
}

async function fetchLatest() {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ConductorD-Studio' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`リリース情報を取得できませんでした (HTTP ${res.status})`)
  const release = await res.json()
  const version = String(release.tag_name || '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('リリースの版番号を読み取れませんでした')
  const asset = (release.assets || []).find((a) => {
    const m = DMG_NAME_RE.exec(a.name || '')
    return m && m[1] === version
  })
  return { version, asset, pageUrl: release.html_url }
}

async function download(asset, dest) {
  const res = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'ConductorD-Studio' },
  })
  if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗しました (HTTP ${res.status})`)
  let received = 0
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      state.percent = asset.size ? Math.min(99, Math.floor((received / asset.size) * 100)) : 0
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest))
  if (asset.size && received !== asset.size) {
    throw new Error(`ダウンロードしたファイルの大きさが合いません (${received} / ${asset.size})`)
  }
}

// Copies the app out of the DMG and proves it is ours before anything
// touches the installed copy. Returns the staged bundle's path.
async function stage(dmgPath, version) {
  const mount = path.join(stageDir(), 'mnt')
  await fs.promises.mkdir(mount, { recursive: true })
  const staged = path.join(stageDir(), 'ConductorD Studio.app')
  await execFileAsync('/usr/bin/hdiutil',
    ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmgPath])
  try {
    const name = (await fs.promises.readdir(mount)).find((n) => n.endsWith('.app'))
    if (!name) throw new Error('ディスクイメージの中にアプリが見つかりません')
    await execFileAsync('/usr/bin/ditto', [path.join(mount, name), staged])
  } finally {
    await execFileAsync('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {})
  }

  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])
  // codesign prints the signing details on stderr.
  const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=2', staged])
  if (!stderr.includes(`TeamIdentifier=${TEAM_ID}\n`) || !stderr.includes(`Identifier=${BUNDLE_ID}\n`)) {
    throw new Error('ダウンロードしたアプリの署名が想定と違います')
  }
  // Gatekeeper's own verdict (Developer ID + notarization).
  await execFileAsync('/usr/sbin/spctl', ['--assess', '--type', 'execute', staged])
  const { stdout } = await execFileAsync('/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', path.join(staged, 'Contents', 'Info.plist')])
  if (stdout.trim() !== version) {
    throw new Error(`ダウンロードしたアプリの版が違います (${stdout.trim()} / ${version})`)
  }
  return staged
}

// Runs after this process is gone. The old bundle is moved into the staging
// folder (cleared on the next launch) rather than deleted here, so a failed
// swap can put it back, and nothing is ever left behind next to the app.
const INSTALL_SCRIPT = `#!/bin/sh
PID="$1"; STAGED="$2"; TARGET="$3"; OLD="$4"; LOG="$5"; shift 5
exec >>"$LOG" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') waiting for $PID to exit"
n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n+1))
  if [ "$n" -gt 100 ]; then kill -9 "$PID" 2>/dev/null; sleep 1; break; fi
  sleep 0.2
done
if mv "$TARGET" "$OLD"; then
  if mv "$STAGED" "$TARGET"; then
    echo "installed $TARGET"
  else
    echo "could not put the new app in place, restoring the previous one"
    mv "$OLD" "$TARGET"
  fi
else
  echo "could not move the current app aside, leaving it as it is"
fi
if [ "$#" -gt 0 ]; then open -n "$TARGET" --args "$@"; else open "$TARGET"; fi
`

async function installAndRelaunch(staged, bundle) {
  const script = path.join(stageDir(), 'install.sh')
  await fs.promises.writeFile(script, INSTALL_SCRIPT, { mode: 0o755 })
  // A non-default profile directory has to survive the restart, or the new
  // copy would come up on someone else's settings.
  const keep = process.argv.slice(1).filter((a) => a.startsWith('--user-data-dir='))
  const child = spawn('/bin/sh',
    [script, String(process.pid), staged, bundle, path.join(stageDir(), 'previous.app'), logFile(), ...keep],
    { detached: true, stdio: 'ignore' })
  child.unref()
  app.quit()
}

// Parentless dialogs of a Dock-less app can open behind the frontmost
// window, so step forward first.
function ask(options) {
  app.focus({ steal: true })
  return dialog.showMessageBox(options).then((r) => r.response)
}

async function run({ manual }) {
  state.phase = 'checking'
  const current = app.getVersion()
  const latest = await fetchLatest()
  if (!isNewer(latest.version, current)) {
    if (manual) {
      await ask({ type: 'info', message: 'ConductorD Studio は最新です', detail: `お使いの版: v${current}`, buttons: ['OK'] })
    }
    return
  }

  const target = installTarget()
  if (!target.bundle || !latest.asset) {
    const why = target.reason || '配布ファイルが見つからないため'
    if (UNATTENDED) { console.log(`[update] v${latest.version} is available but cannot self-install: ${why}`); return }
    const choice = await ask({
      type: 'info',
      message: `ConductorD Studio v${latest.version} があります`,
      detail: `いまお使いの版は v${current} です。\n${why}、自動ではインストールできません。ダウンロードページから入れ替えてください。`,
      buttons: ['ダウンロードページを開く', 'あとで'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0 && latest.pageUrl) shell.openExternal(latest.pageUrl)
    return
  }

  if (!UNATTENDED) {
    const choice = await ask({
      type: 'question',
      message: `ConductorD Studio v${latest.version} があります`,
      detail: `いまお使いの版は v${current} です。ダウンロードしてインストールしますか?\n\nダウンロードと準備が終わると、Studio を自動で終了し、新しい版に置き換えてから起動し直します。`,
      buttons: ['ダウンロードしてインストール', 'あとで'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice !== 0) return
  }

  state.version = latest.version
  state.percent = 0
  state.phase = 'downloading'
  console.log(`[update] downloading v${latest.version}`)
  await fs.promises.rm(stageDir(), { recursive: true, force: true })
  await fs.promises.mkdir(stageDir(), { recursive: true })
  const dmgPath = path.join(stageDir(), latest.asset.name)
  await download(latest.asset, dmgPath)

  state.phase = 'preparing'
  console.log('[update] staging and verifying')
  const staged = await stage(dmgPath, latest.version)
  await fs.promises.rm(dmgPath, { force: true })

  state.phase = 'installing'
  console.log('[update] handing over to the installer')
  await installAndRelaunch(staged, target.bundle)
}

// manual = asked for from the tray menu: also reports "up to date" and
// failures to reach the release list. The launch-time check stays silent
// about both.
async function checkForUpdate({ manual = false } = {}) {
  if (state.phase !== 'idle') return
  try {
    await run({ manual })
  } catch (e) {
    console.error('[update] failed:', e)
    const started = state.phase !== 'checking'
    if (!UNATTENDED && (manual || started)) {
      await ask({
        type: 'error',
        message: started ? 'アップデートできませんでした' : 'アップデートを確認できませんでした',
        detail: `${e?.message || e}\n\nいまの版はそのまま使えます。`,
        buttons: ['OK'],
      }).catch(() => {})
    }
  } finally {
    // 'installing' means the app is on its way out; leave the menu saying so.
    if (state.phase !== 'installing') state.phase = 'idle'
  }
}

// Leftovers of a finished (or abandoned) update: the previous bundle, the
// script, a partial download.
function cleanUpStaging() {
  if (state.phase !== 'idle') return
  fs.promises.rm(stageDir(), { recursive: true, force: true }).catch(() => {})
}

function trayItems() {
  if (!app.isPackaged) return []
  switch (state.phase) {
    case 'checking': return [{ label: 'アップデートを確認しています…', enabled: false }]
    case 'downloading': return [{ label: `v${state.version} をダウンロード中… ${state.percent}%`, enabled: false }]
    case 'preparing': return [{ label: `v${state.version} を準備しています…`, enabled: false }]
    case 'installing': return [{ label: `v${state.version} に入れ替えて再起動します…`, enabled: false }]
    default: return [{ label: 'アップデートを確認', click: () => checkForUpdate({ manual: true }) }]
  }
}

module.exports = { checkForUpdate, cleanUpStaging, trayItems }

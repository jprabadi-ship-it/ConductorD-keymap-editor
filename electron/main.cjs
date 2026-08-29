const { app, BrowserWindow, session, dialog, Tray, Menu, nativeImage, ipcMain, screen, shell } = require('electron')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const crypto = require('node:crypto')
const extractZip = require('extract-zip')

const isDev = !app.isPackaged
const preloadPath = path.join(__dirname, 'preload.cjs')

// Route external links (FW download, Mac app download, anything http/https)
// to the system browser instead of navigating the Electron window: the app's
// session has no GitHub login, so private-repo release pages come back as
// 404 in-app -- and following them would also navigate Studio away.
function openExternalLinks(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  contents.on('will-navigate', (event, url) => {
    const isAppUrl = url.startsWith('file://') || url.startsWith('http://localhost:5173')
    if (!isAppUrl) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
}

let win = null
let tray = null
let popupWin = null
let isQuitting = false
let latestLayerState = null

function createWindow() {
  // Launch filling the screen's usable area (menu bar/Dock excluded) rather
  // than a fixed 1400x900 -- on an FHD (1920x1080) display that's roughly
  // 1920x1055, matching the 90% zoom above which was tuned for exactly that
  // size. Falls back gracefully to whatever the actual display offers.
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width,
    height,
    title: 'ConductorD Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      // The layout is sized for larger displays and feels cramped at 100%
      // on FHD -- default the Studio window (not the minimap popup) to 90%.
      // Users can still zoom per-session with Cmd+/-; Electron persists
      // per-origin zoom on top of this default.
      zoomFactor: 0.9,
    },
  })

  openExternalLinks(win.webContents)

  if (isDev) {
    win.loadURL('http://localhost:5173/ConductorD-keymap-editor/')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // Electron persists user zoom per-origin and lets it override the
  // webPreferences default above, so force the 90% launch zoom explicitly;
  // Cmd+/- still works for the rest of the session.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(0.9)
  })

  // Keep the app alive in the menu bar instead of quitting when the window
  // is closed — the tray icon is the app's real lifecycle from here on.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })

  return win
}

function toggleWindow() {
  if (!win) {
    createWindow()
    return
  }
  if (win.isVisible()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

// Small frameless window anchored under the tray icon, showing the
// currently-active layer's key layout. Shown/hidden only via the tray's
// "キーマップを表示する" checkbox -- once up, it stays on top and doesn't
// auto-hide on blur, since it's meant to sit there as a running overlay
// while typing, not a click-away popover. Sized to fit the keyboard grid at
// its natural (unscaled) size -- this is a legend meant to be read at a
// glance while typing on blank keycaps, so shrinking it to fit a smaller
// window isn't worth the loss of legibility.
const POPUP_WIDTH = 720
const POPUP_HEIGHT = 360

// Remembered across toggles/recreations for the rest of this run (not
// persisted to disk) -- once the user drags or resizes the popup, or picks
// an opacity, later opens should respect that instead of snapping back.
let popupOpacity = 0.55
let popupUserMoved = false
let showMinimap = true
let popupTheme = 'dark'

function createPopupWindow() {
  popupWin = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    minWidth: 320,
    minHeight: 160,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    opacity: popupOpacity,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  })

  // Keep the minimap above everything, everywhere: 'screen-saver' is a
  // higher NSWindowLevel than the default 'floating' (which normal app
  // windows can still cover in some cases), and visibleOnAllWorkspaces +
  // visibleOnFullScreen makes it follow across Spaces and float over
  // other apps' fullscreen windows -- the main situation where the old
  // floating-level popup silently disappeared.
  // skipTransformProcessType avoids macOS flipping the app's activation
  // policy (which would hide the Dock icon) as a side effect.
  popupWin.setAlwaysOnTop(true, 'screen-saver')
  popupWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

  openExternalLinks(popupWin.webContents)

  if (isDev) {
    popupWin.loadURL('http://localhost:5173/ConductorD-keymap-editor/#/popup')
  } else {
    popupWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: '/popup' })
  }

  popupWin.on('moved', () => {
    popupUserMoved = true
    // Re-assert alwaysOnTop after every move to fix a macOS bug where dragging
    // a frameless alwaysOnTop window to a different display desynchronises its
    // NSWindowLevel, leaving the window stuck and unresponsive to further drags.
    // Same 'screen-saver' level as at creation, or the move would demote it.
    popupWin.setAlwaysOnTop(true, 'screen-saver')
  })
  popupWin.on('closed', () => { popupWin = null })

  // The show-time pushes in showPopup() race against the first page load;
  // re-send once the renderer is definitely ready so the initial theme and
  // state always land.
  popupWin.webContents.on('did-finish-load', () => {
    popupWin.webContents.send('set-theme', popupTheme)
    popupWin.webContents.send('show-minimap', showMinimap)
    if (latestLayerState) popupWin.webContents.send('layer-state', latestLayerState)
  })

  return popupWin
}

// Default resting place: bottom-center of the primary display (just above
// the Dock/taskbar area), where a keyboard legend naturally lives.
function positionPopupBottomCenter() {
  const { workArea } = screen.getPrimaryDisplay()
  const popupBounds = popupWin.getBounds()
  const x = Math.round(workArea.x + (workArea.width - popupBounds.width) / 2)
  const y = Math.round(workArea.y + workArea.height - popupBounds.height - 8)
  popupWin.setPosition(x, y, false)
}

const POPUP_OPACITY_LEVELS = [100, 85, 70, 55, 40]
const POPUP_OPACITY_MIN = 0.15

function showPopupContextMenu() {
  if (!popupWin) return
  const menu = Menu.buildFromTemplate([
    ...POPUP_OPACITY_LEVELS.map(pct => ({
      label: `不透明度 ${pct}%`,
      type: 'radio',
      checked: Math.round(popupOpacity * 100) === pct,
      click: () => {
        popupOpacity = pct / 100
        popupWin.setOpacity(popupOpacity)
      },
    })),
    { type: 'separator' },
    {
      label: 'ミニマップを表示',
      type: 'checkbox',
      checked: showMinimap,
      click: () => {
        showMinimap = !showMinimap
        popupWin.webContents.send('show-minimap', showMinimap)
      },
    },
    { type: 'separator' },
    {
      label: 'ライトモード',
      type: 'radio',
      checked: popupTheme === 'light',
      click: () => {
        popupTheme = 'light'
        popupWin.webContents.send('set-theme', popupTheme)
      },
    },
    {
      label: 'ダークモード',
      type: 'radio',
      checked: popupTheme === 'dark',
      click: () => {
        popupTheme = 'dark'
        popupWin.webContents.send('set-theme', popupTheme)
      },
    },
  ])
  menu.popup({ window: popupWin })
}

function showPopup() {
  if (!popupWin) createPopupWindow()
  if (!popupUserMoved) positionPopupBottomCenter()
  popupWin.show()
  popupWin.focus()
  if (latestLayerState) popupWin.webContents.send('layer-state', latestLayerState)
  popupWin.webContents.send('show-minimap', showMinimap)
  popupWin.webContents.send('set-theme', popupTheme)
}

function hidePopup() {
  popupWin?.hide()
}

// Lets the internal MacBook keyboard be disabled while Conductor (or an
// iPad) sits physically on top of it, to avoid stray keypresses. Uses
// hidutil's DeviceDisabled property, matched by "Built-In" + the keyboard
// usage page/usage so it targets the internal keyboard specifically
// regardless of Mac model (no hardcoded vendor/product ID). This is a
// session-scoped OS setting, not persisted by us or by macOS -- it always
// resets to enabled on logout/reboot, and isn't tied to this app's process
// (quitting ConductorD Studio does NOT re-enable it by itself). We can't
// cheaply read the current OS-level state back from hidutil, so
// builtInKeyboardDisabled below is just this app's own best-effort tracking
// of what IT last set; if the keyboard was left disabled from a previous
// run, the checkbox may not reflect that until toggled once.
const execFileAsync = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
  })

let builtInKeyboardDisabled = false
const BUILT_IN_KEYBOARD_MATCH = '{"Built-In":1,"UsagePage":1,"Usage":6}'

async function setBuiltInKeyboardDisabled(disabled) {
  await execFileAsync(
    'hidutil',
    ['property', '--matching', BUILT_IN_KEYBOARD_MATCH, '--set', `{"DeviceDisabled":${disabled ? 1 : 0}}`],
    { timeout: 5000 },
  )
  builtInKeyboardDisabled = disabled
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Show ConductorD Studio',
      click: () => {
        if (!win) {
          createWindow()
        } else {
          win.show()
          win.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Open miniMap',
      type: 'checkbox',
      checked: !!(popupWin && popupWin.isVisible()),
      click: (menuItem) => {
        if (menuItem.checked) showPopup()
        else hidePopup()
      },
    },
    { type: 'separator' },
    {
      label: '内蔵キーボードを無効にする',
      type: 'checkbox',
      checked: builtInKeyboardDisabled,
      click: async (menuItem) => {
        try {
          await setBuiltInKeyboardDisabled(menuItem.checked)
        } catch (e) {
          console.error('Failed to toggle built-in keyboard:', e)
          menuItem.checked = !menuItem.checked // revert the checkbox on failure
          dialog.showErrorBox(
            '内蔵キーボードの切り替えに失敗しました',
            `${e.message}\n\n再起動すれば内蔵キーボードは必ず有効な状態に戻ります。`,
          )
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  // The app icon's key-cluster artwork in its own colors, minus the rounded
  // background plate, sized to fill the menu bar's 22pt height. Deliberately
  // NOT a template image: macOS renders those from alpha alone, which would
  // drop the orange accent key and the rest of the coloring.
  // Regenerate with: node scripts/gen_tray_icon.mjs
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'trayIcon.png')))
  tray.setToolTip('ConductorD Studio')

  // Both buttons open the menu. Right-click only (the previous behavior)
  // read as "the icon is dead" whenever the click happened to be a normal
  // left click. Rebuild the menu each time so checkboxes reflect current state.
  const openMenu = () => tray.popUpContextMenu(buildTrayMenu())
  tray.on('click', openMenu)
  tray.on('right-click', openMenu)
}

// Shows "L.. R.." battery levels next to the tray icon via Tray.setTitle(),
// which macOS renders with the real system menu-bar font (proper subpixel
// antialiasing, guaranteed legible) -- an earlier approach that composited
// the numbers onto the icon image via an offscreen BrowserWindow's canvas
// kept coming out blocky/aliased no matter the font or supersampling tried,
// most likely because transparent, never-shown BrowserWindows on macOS don't
// get normal font smoothing. setTitle can only place text to the icon's
// right (not wrapped left+right), but it's simple, robust, and reads
// correctly. The icon image itself never changes now, which also removes
// the width-alternation churn suspected of contributing to an earlier
// report of the tray icon vanishing from the menu bar after a while.
const TRAY_REDRAW_MIN_INTERVAL_MS = 15000
let lastTrayRedrawAt = 0
let lastTrayBattery = null // dedupe: skip redraw if r/l unchanged since last update
let trayRedrawPending = null // update deferred by the throttle window

function updateTrayBatteryIcon(battery) {
  if (!tray) return

  const r = battery?.r ?? null
  const l = battery?.l ?? null
  const disconnected = !battery
  if (lastTrayBattery && lastTrayBattery.r === r && lastTrayBattery.l === l && lastTrayBattery.disconnected === disconnected) {
    return
  }
  const now = Date.now()
  if (now - lastTrayRedrawAt < TRAY_REDRAW_MIN_INTERVAL_MS) {
    // Don't drop the update: right after connecting, the first relay carries
    // no battery yet (draws the empty title) and the real values arrive a
    // second later -- dropping them left the tray blank until the values
    // happened to change. Defer to the end of the throttle window instead.
    clearTimeout(trayRedrawPending)
    trayRedrawPending = setTimeout(() => {
      trayRedrawPending = null
      updateTrayBatteryIcon(battery)
    }, TRAY_REDRAW_MIN_INTERVAL_MS - (now - lastTrayRedrawAt) + 50)
    return
  }
  clearTimeout(trayRedrawPending)
  trayRedrawPending = null
  lastTrayRedrawAt = now
  lastTrayBattery = { r, l, disconnected }

  const fmt = (v) => (v === null || v === undefined ? '--' : String(Math.round(v)))
  tray.setTitle(disconnected ? '' : ` L${fmt(l)} R${fmt(r)}`)
}

ipcMain.on('layer-state', (_event, state) => {
  latestLayerState = state
  if (popupWin) popupWin.webContents.send('layer-state', state)
  updateTrayBatteryIcon(state?.battery)
})

ipcMain.on('popup-context-menu', showPopupContextMenu)

// Serial-port handoff (the port is exclusive, one renderer at a time):
// Studio invokes steal-port before connecting; if the popup holds a
// connection it releases it and answers with what it was using. When
// Studio disconnects, the popup is told to reclaim what it gave up.
ipcMain.handle('steal-port', async () => {
  if (!popupWin) return null
  const ack = new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners('port-released')
      resolve(null)
    }, 3000)
    ipcMain.once('port-released', (_event, info) => {
      clearTimeout(timer)
      resolve(info)
    })
  })
  popupWin.webContents.send('release-port')
  return await ack
})

ipcMain.on('studio-released-port', () => {
  if (popupWin) popupWin.webContents.send('reclaim-port')
})

// Pulled by the popup renderer on mount. Pushing set-theme at show time
// races the first page load (the React listener may not be registered yet),
// which made the dark default silently fall back to light on launch.
ipcMain.handle('get-popup-prefs', () => ({ theme: popupTheme, showMinimap }))

// Firmware update check. The conductor repo is private, so its
// firmware-latest release can't be fetched anonymously (and the web build
// can't embed credentials) -- but on this machine the user's gh CLI is
// already authenticated, so the Electron build queries through it. GUI
// apps launched from Finder don't inherit the shell PATH (no
// /opt/homebrew/bin), so probe the usual install locations explicitly.
ipcMain.handle('check-firmware-latest', async () => {
  const ghCandidates = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', 'gh']
  const ghPath = ghCandidates.find((p) => p === 'gh' || fs.existsSync(p))
  return await new Promise((resolve) => {
    execFile(
      ghPath,
      ['release', 'view', 'firmware-latest', '--repo', 'jprabadi-ship-it/conductor', '--json', 'name,publishedAt,body'],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) {
          resolve(null) // gh missing/unauthenticated/offline -- silently skip
          return
        }
        try {
          const data = JSON.parse(stdout)
          // GitHub's publishedAt is set once at first publish and never
          // moves on later `gh release upload`/`edit` calls (this release
          // is reused across every CI run, not recreated) -- it stays
          // frozen at whenever the release was first created, not the
          // actual last build. The workflow now embeds the real build time
          // as "Built: <ISO>" in the notes body; prefer that when present.
          const builtMatch = (data.body || '').match(/Built:\s*(\S+)/)
          const publishedAt = builtMatch ? builtMatch[1] : (data.publishedAt || '')
          resolve({ name: data.name || '', publishedAt })
        } catch {
          resolve(null)
        }
      },
    )
  })
})

// ===== Native BLE bridge =====
// Web Bluetooth is broken in Electron on recent macOS (electron/electron
// #47046: the requestDevice chooser cancels instantly and
// select-bluetooth-device never fires), so the renderer's Connect BLE goes
// through this main-process bridge instead: @stoprocent/noble talks to
// CoreBluetooth directly (same strategy as ZMK Studio's Tauri app, which
// uses native Rust BLE rather than the browser stack). Requires the
// com.apple.security.device.bluetooth entitlement + Info.plist usage
// description, both set in the build config.
const STUDIO_BLE_SERVICE_UUID = '0000000001966107c967c5cfb1c2482a'
const STUDIO_BLE_RPC_CHRC_UUID = '0000000101966107c967c5cfb1c2482a'

let nobleMod = null // lazy: CoreBluetooth init triggers the OS permission prompt
let blePeripheral = null
let bleRpcChar = null

function bleBroadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload) } catch { /* window closing */ }
  }
}

function bleNativeCleanup() {
  if (blePeripheral) {
    try { blePeripheral.removeAllListeners('disconnect') } catch { /* already gone */ }
  }
  blePeripheral = null
  bleRpcChar = null
}

// Single-flight: rapid repeat clicks (or an auto-reconnect loop) must share
// one connect attempt instead of racing 'discover' listeners and connecting
// to the same peripheral a dozen times in parallel.
let bleConnectInFlight = null

ipcMain.handle('ble-native-connect', () => {
  if (bleConnectInFlight) return bleConnectInFlight
  bleConnectInFlight = bleNativeConnectOnce().finally(() => { bleConnectInFlight = null })
  return bleConnectInFlight
})

async function bleNativeConnectOnce() {
  try {
    if (blePeripheral) {
      try { await blePeripheral.disconnectAsync() } catch { /* stale */ }
      bleNativeCleanup()
    }
    if (!nobleMod) nobleMod = require('@stoprocent/noble')
    const noble = nobleMod

    if (noble._state !== 'poweredOn' && noble.state !== 'poweredOn') {
      bleBroadcast('ble-scan-log', `adapter state: ${noble.state || noble._state}, waiting for poweredOn...`)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Bluetoothアダプタが有効になりません (state=${noble.state || noble._state})`)), 10000)
        noble.once('stateChange', (state) => {
          clearTimeout(timer)
          if (state === 'poweredOn') resolve()
          else reject(new Error(`Bluetoothが使用できません (state=${state})`))
        })
        if (noble.state === 'poweredOn') { clearTimeout(timer); resolve() }
      })
    }

    bleBroadcast('ble-scan-log', 'scanning for Studio BLE service...')
    const peripheral = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.stopScanning()
        noble.removeAllListeners('discover')
        reject(new Error('スキャンしましたがConductorが見つかりませんでした (15秒)'))
      }, 15000)
      noble.on('discover', (p) => {
        bleBroadcast('ble-scan-log', `found: ${p.advertisement.localName || p.id}`)
        clearTimeout(timer)
        noble.stopScanning()
        noble.removeAllListeners('discover')
        resolve(p)
      })
      // allowDuplicates=false; filter by the Studio service UUID so only
      // Conductor devices (advertising it, or already connected) match.
      noble.startScanning([STUDIO_BLE_SERVICE_UUID], false, (err) => {
        if (err) { clearTimeout(timer); reject(err) }
      })
    })

    bleBroadcast('ble-scan-log', `connecting to ${peripheral.advertisement.localName || peripheral.id}...`)
    await peripheral.connectAsync()

    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [STUDIO_BLE_SERVICE_UUID], [STUDIO_BLE_RPC_CHRC_UUID])
    if (!characteristics || characteristics.length === 0) {
      try { await peripheral.disconnectAsync() } catch { /* best effort */ }
      throw new Error('Studio RPCキャラクタリスティックが見つかりません')
    }

    blePeripheral = peripheral
    bleRpcChar = characteristics[0]

    bleRpcChar.on('data', (data) => {
      bleBroadcast('ble-native-data', Array.from(data))
    })
    await bleRpcChar.subscribeAsync()

    peripheral.once('disconnect', () => {
      bleNativeCleanup()
      bleBroadcast('ble-native-disconnected', null)
    })

    return { ok: true, name: peripheral.advertisement.localName || 'conductor' }
  } catch (e) {
    bleNativeCleanup()
    return { ok: false, error: e.message || String(e) }
  }
}

ipcMain.handle('ble-native-write', async (_event, bytes) => {
  if (!bleRpcChar) throw new Error('BLE not connected')
  // write-with-response, mirroring the web path's writeValueWithResponse
  await bleRpcChar.writeAsync(Buffer.from(bytes), false)
  return true
})

ipcMain.handle('ble-native-disconnect', async () => {
  const p = blePeripheral
  bleNativeCleanup()
  if (p) { try { await p.disconnectAsync() } catch { /* already gone */ } }
  return true
})

// Local firmware cache: if a zip in this dev-repo folder has the same sha256
// digest as the firmware-latest release's ConductorD-firmware-latest.zip
// asset, use it instead of re-downloading (same bytes either way -- the CI
// workflow publishes the dated copy as a plain `cp` of the rolling one).
// Only ever a fast path; any mismatch or error falls through to the normal
// network download below.
const LOCAL_FIRMWARE_CACHE_DIR = path.join(__dirname, '..', 'firmware-downloads')

function findLocalFirmwareZip(expectedDigest) {
  if (!expectedDigest || !fs.existsSync(LOCAL_FIRMWARE_CACHE_DIR)) return null
  const wantHash = expectedDigest.replace(/^sha256:/, '')
  for (const name of fs.readdirSync(LOCAL_FIRMWARE_CACHE_DIR)) {
    if (!name.endsWith('.zip')) continue
    const filePath = path.join(LOCAL_FIRMWARE_CACHE_DIR, name)
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    if (hash === wantHash) return filePath
  }
  return null
}

// Firmware Update Wizard: download+extract the firmware-latest release ZIP
// so the renderer can hand the individual .uf2 files to a user-picked UF2
// bootloader drive via the File System Access API. User-initiated (unlike
// check-firmware-latest's passive background poll), so failures are
// reported back instead of silently swallowed. gh CLI probing mirrors
// check-firmware-latest above.
ipcMain.handle('download-firmware-release', async () => {
  const ghCandidates = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', 'gh']
  const ghPath = ghCandidates.find((p) => p === 'gh' || fs.existsSync(p))

  const execFileAsync = (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      })
    })

  let workDir = null
  try {
    const releaseJson = await execFileAsync(
      ghPath,
      ['release', 'view', 'firmware-latest', '--repo', 'jprabadi-ship-it/conductor', '--json', 'body,assets'],
      { timeout: 10000 },
    )
    const release = JSON.parse(releaseJson)
    const body = release.body || ''
    const shaMatch = body.match(/@ `([0-9a-f]{7,40})`/)
    if (!shaMatch) throw new Error('release body からビルドSHAを取得できませんでした')
    const sha = shaMatch[1].slice(0, 8)

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductord-fw-'))

    const remoteAsset = (release.assets || []).find((a) => a.name === 'ConductorD-firmware-latest.zip')
    const localZip = findLocalFirmwareZip(remoteAsset?.digest)

    let zipPath
    if (localZip) {
      zipPath = localZip
    } else {
      await execFileAsync(
        ghPath,
        [
          'release', 'download', 'firmware-latest',
          '--repo', 'jprabadi-ship-it/conductor',
          '--dir', workDir,
          '--clobber',
          '--pattern', 'ConductorD-firmware-latest.zip',
        ],
        { timeout: 30000 },
      )
      zipPath = path.join(workDir, 'ConductorD-firmware-latest.zip')
    }
    const extractDir = path.join(workDir, 'extracted')
    fs.mkdirSync(extractDir)
    await extractZip(zipPath, { dir: extractDir })

    const entries = fs.readdirSync(extractDir)
    const findFile = (prefix) => entries.find((f) => f.startsWith(prefix) && f.endsWith('.uf2'))
    // R always runs as a split peripheral in dongle mode in this system, so
    // it's the R_dongle_mode build (monokey_R_periph), not standalone R.
    const names = {
      dongle: findFile('dongle_ConductorD_'),
      R: findFile('R_dongle_mode_ConductorD_'),
      L: findFile('L_ConductorD_'),
    }
    const missing = Object.entries(names).filter(([, f]) => !f).map(([unit]) => unit)
    if (missing.length > 0) {
      throw new Error(`次のユニット用uf2がzip内に見つかりません: ${missing.join(', ')}`)
    }

    // The renderer has no filesystem access (contextIsolation, no
    // nodeIntegration) beyond what the user explicitly grants via
    // showDirectoryPicker, so hand the (small, <1MB) uf2 bytes back
    // directly rather than a path it can't read.
    const files = {}
    for (const [unit, name] of Object.entries(names)) {
      files[unit] = { name, data: fs.readFileSync(path.join(extractDir, name)).toString('base64') }
    }

    return { ok: true, sha, files }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  }
})

// Minimap's "Editorへ" button: open (or focus) the Studio window.
ipcMain.on('open-studio', () => {
  if (!win) {
    createWindow()
  } else {
    win.show()
    win.focus()
  }
})

// Minimap's ✕ button also dismisses the minimap itself.
ipcMain.on('hide-popup', () => hidePopup())

// Studio's "ミニマップを起動" button (shown after a Write): bring up the
// minimap and tuck the Studio window away — back to day-to-day mode. The
// hidden Studio renderer keeps its connection, so the minimap display
// continues via the layer-state relay.
ipcMain.on('switch-to-minimap', () => {
  showPopup()
  if (win) win.hide()
})

// Hidden feature: scroll over the popup to fade it steplessly, instead of
// picking from the menu's fixed percentages. Delta is relative so the
// renderer never needs to know the current opacity.
ipcMain.on('adjust-popup-opacity', (_event, delta) => {
  if (!popupWin) return
  popupOpacity = Math.min(1, Math.max(POPUP_OPACITY_MIN, popupOpacity + delta))
  popupWin.setOpacity(popupOpacity)
})

// Web Serial: Electron doesn't show its own port picker, so we must answer
// navigator.serial.requestPort() ourselves. Auto-select when there's exactly
// one candidate (the common case). With more than one — e.g. macOS always
// lists a phantom "Bluetooth-Incoming-Port" cu device alongside real USB
// serial ports — ask the user, the same way a real browser's native picker
// would, instead of guessing and silently connecting to the wrong port.
// Shared chooser for the serial/bluetooth device pickers. Deliberately async
// (never showMessageBoxSync, which freezes the whole main process -- tray
// included -- for as long as the dialog is up), and it only attaches a sheet
// to a window the user can actually see: a sheet on a hidden window is a
// dialog nobody can answer.
function pickFromDialog(webContents, opts, cancelIndex) {
  const requester = webContents ? BrowserWindow.fromWebContents(webContents) : null
  const visible = [requester, win, popupWin].find((w) => w && !w.isDestroyed() && w.isVisible())
  const promise = visible ? dialog.showMessageBox(visible, opts) : dialog.showMessageBox(opts)
  return promise.then((r) => r.response).catch((e) => {
    console.error('device picker failed:', e)
    return cancelIndex
  })
}

function wireSerialPermissions(ses) {
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault()

    if (portList.length <= 1) {
      callback(portList.length === 1 ? portList[0].portId : '')
      return
    }

    const labels = portList.map((p, i) => p.displayName || p.portName || `Port ${i + 1}`)
    const opts = {
      type: 'question',
      title: 'Select a serial port',
      message: 'Multiple serial ports were found. Which one is your Conductor device?',
      buttons: [...labels, 'Cancel'],
      cancelId: labels.length,
    }
    // Async, and only ever parented to a *visible* window: showMessageBoxSync
    // blocks the entire main process, and as a sheet on a hidden window it is
    // invisible while doing so -- the whole app, tray included, stops
    // responding with nothing on screen to dismiss.
    pickFromDialog(webContents, opts, labels.length).then((result) => {
      callback(result < labels.length ? portList[result].portId : '')
    })
  })

  ses.setDevicePermissionHandler((details) =>
    details.deviceType === 'serial' || details.deviceType === 'bluetooth',
  )
}

// Web Bluetooth: same story as serial — Electron requires the host app to
// resolve navigator.bluetooth.requestDevice() via this event. Same
// single-candidate auto-select / multi-candidate prompt pattern.
function wireBluetoothPermissions(ses) {
  // select-bluetooth-device fires repeatedly while Chromium scans, starting
  // with an EMPTY list. Cancelling on that first empty emission (the old
  // behavior) made requestDevice reject within milliseconds, so a device
  // that isn't already connected (e.g. standalone R advertising on the
  // hidden pair slot) never got a chance to be discovered. Instead, keep
  // the scan alive and only give up after a quiet period with no devices.
  // Relay scan progress into the renderer's debug console: the packaged app
  // has no visible main-process stdout, and Web Bluetooth's renderer-side
  // errors don't say whether this event ever fired.
  const bleScanLog = (msg) => {
    console.log(`[ble-scan] ${msg}`)
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('ble-scan-log', msg) } catch { /* window closing */ }
    }
  }

  let bleScanTimeout = null
  ses.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault()
    clearTimeout(bleScanTimeout)
    bleScanLog(`select-bluetooth-device: ${deviceList.length} device(s) ${deviceList.map((d) => d.deviceName || d.deviceId).join(', ') || '(none yet)'}`)

    if (deviceList.length === 0) {
      bleScanTimeout = setTimeout(() => callback(''), 15000)
      return
    }

    if (deviceList.length === 1) {
      callback(deviceList[0].deviceId)
      return
    }

    const labels = deviceList.map((d, i) => d.deviceName || `Device ${i + 1}`)
    const opts = {
      type: 'question',
      title: 'Select a Bluetooth device',
      message: 'Multiple Bluetooth devices were found. Which one is your Conductor device?',
      buttons: [...labels, 'Cancel'],
      cancelId: labels.length,
    }
    // Async + visible-parent-only, same reasoning as the serial picker.
    pickFromDialog(null, opts, labels.length).then((result) => {
      callback(result < labels.length ? deviceList[result].deviceId : '')
    })
  })

  ses.setBluetoothPairingHandler((details, callback) => {
    callback({ confirm: true })
  })
}

app.whenReady().then(() => {
  const ses = session.defaultSession
  wireSerialPermissions(ses)
  wireBluetoothPermissions(ses)

  ses.setPermissionCheckHandler((_webContents, permission) =>
    permission === 'serial' || permission === 'bluetooth',
  )

  // Menu-bar-resident app: no Dock icon, lives as a tray icon instead.
  if (process.platform === 'darwin') app.dock.hide()

  createTray()
  // Day-to-day usage is the minimap, not the editor: launch straight into
  // it. The Studio window is created lazily from the minimap's "Editorへ"
  // button or the tray menu.
  showPopup()

  app.on('activate', () => toggleWindow())
})

app.on('window-all-closed', () => {
  // The window hides rather than closes, and the tray keeps the app alive —
  // this only fires on the real, quitting close (or on non-mac platforms).
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  isQuitting = true

  // If noble was ever loaded, normal quit deadlocks: node's env cleanup
  // runs NobleMac::~NobleMac -> [BLEManager dealloc] on the main thread,
  // which hangs forever (observed live via `sample`: the app becomes a
  // zombie with an unresponsive tray icon). Tear the connection down
  // ourselves, then hard-exit past the finalizers.
  if (nobleMod) {
    event.preventDefault()
    const p = blePeripheral
    bleNativeCleanup()
    const finish = () => app.exit(0)
    const failsafe = setTimeout(finish, 2000)
    ;(async () => {
      try { nobleMod.stopScanning() } catch { /* not scanning */ }
      try { if (p) await p.disconnectAsync() } catch { /* already gone */ }
      clearTimeout(failsafe)
      finish()
    })()
  }
})

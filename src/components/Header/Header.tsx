import { useState, useRef, useEffect } from 'react';
import { version } from '../../../package.json';
import { KeymapStore } from '../../store/useKeymapStore';
import { applyDeviceSettingsSnapshot, collectDeviceSettingsSnapshot, setKeyboardLayout } from '../../services/usbService';
import { listWriteBackups, loadWriteBackup } from '../../services/writeBackups';
import { ConnectionPanel } from '../LeftPanel/ConnectionPanel';

interface Props {
  store: KeymapStore;
  showConsole: boolean;
  onToggleConsole: () => void;
  usbConnected: boolean;
  connectionType: 'usb' | 'bluetooth' | null;
  onConnectionChange: (connected: boolean, type: 'usb' | 'bluetooth' | null) => void;
  unsaved: boolean;
  onWrite: () => void;
  wroteToDevice?: boolean;
  fwUpdateAvailable?: boolean;
  fwLatestPublishedAt?: string | null;
  onRead: () => void;
  onSave: () => void;
}

// Electron ships its own app -- only the plain web build (GitHub Pages)
// needs a way to get the desktop one.
const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;
// Deliberately the version-LESS asset name (uploaded to every release
// alongside the versioned one): a versioned URL here 404s whenever the
// deployed/cached web build's version differs from the newest DMG release
// -- Pages deploys on every push while the DMG follows minutes later (or
// never, if a release run is aborted), and browsers cache old bundles.
// This URL always resolves to the newest release's DMG regardless; the
// downloaded app still identifies its version in the DMG volume name,
// the About panel, and this header.
const MAC_APP_DOWNLOAD_URL = 'https://github.com/jprabadi-ship-it/conductor-keymap-editor/releases/latest/download/ConductorD-Studio-mac-arm64.dmg';
// Firmware is a separate repo/artifact from Studio itself, so unlike the Mac
// app link above this isn't gated on !isElectron -- both builds need it.
// The "firmware-latest" release is republished in place by conductor-dongle's
// CI on every green push to a release/conductor-* branch (see build.yml's
// "Publish Firmware Release" job). The zip's primary filename is now
// date-stamped (ConductorD-firmware-latest-YYYYMMDD-HHMM.zip), but a fixed-
// name copy is uploaded alongside it on every publish specifically so this
// link keeps working -- direct one-click download, no release-page detour.
const FIRMWARE_DOWNLOAD_URL = 'https://github.com/jprabadi-ship-it/conductor/releases/latest/download/ConductorD-firmware-latest.zip';

// True auto-update (silent download+relaunch via electron-updater/Squirrel.Mac)
// needs a valid code signature, which this app doesn't have (unsigned, no
// Developer ID cert) -- Squirrel.Mac's own update-apply step requires one, it's
// not just a Gatekeeper prompt to click through. So this is a lighter "there's
// a newer version, here's the link" notice instead: same manual download+open
// flow as clicking "Macアプリダウンロード" in the web build, just surfaced
// proactively inside the app. conductor-keymap-editor is intentionally public
// (for GitHub Pages), so the release API needs no auth, unlike the firmware
// check against the private conductor repo.
function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

export function Header({ store, showConsole, onToggleConsole, usbConnected, connectionType, onConnectionChange, unsaved, onWrite, wroteToDevice, fwUpdateAvailable, fwLatestPublishedAt, onRead, onSave }: Props) {
  const [showExport, setShowExport] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('conductor-theme') || 'light');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editorLatestVersion, setEditorLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron) return;
    fetch('https://api.github.com/repos/jprabadi-ship-it/conductor-keymap-editor/releases/latest')
      .then((r) => r.json())
      .then((data) => {
        const tag = typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null;
        if (tag && isNewerVersion(tag, version)) setEditorLatestVersion(tag);
      })
      .catch(() => { /* offline or rate-limited -- silently skip */ });
  }, []);

  const handleExport = async () => {
    const data = store.exportProject();
    if (usbConnected) {
      // Backing up every USB slot / BLE profile's trackball settings means
      // briefly cycling the device's active output through all of them
      // (real transport switches, not just reads) — surface that before
      // doing it rather than silently changing what host the keyboard is
      // talking to.
      const includeAllSlotProfiles = window.confirm(
        '全スロット分のトラックボール設定もバックアップするには、実機の出力先を一時的に順番に切り替えます（BLE接続の場合、切断されることがあります）。続行しますか？\n\n「キャンセル」を選ぶと、現在のスロットの設定のみバックアップします。'
      );
      data.deviceSettings = await collectDeviceSettingsSnapshot({ includeAllSlotProfiles });
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'conductor-keymap.json';
    a.click();
    URL.revokeObjectURL(url);
    setShowExport(false);
  };

  const handleImport = () => {
    fileInputRef.current?.click();
    setShowExport(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.version === 2 && data.layers && Array.isArray(data.layers)) {
          // Convert Conductor Studio export format to internal format
          const project = store.exportProject();
          project.layers = data.layers.map((dl: any, i: number) => {
            const existing = project.layers[i] || project.layers[0];
            const keys = existing.keys.map((k: any) => {
              const b = dl.bindings?.[k.id];
              if (!b) return { id: k.id, binding: { type: 'none', keyCode: 'NONE', label: '' } };
              const binding: any = { type: b.type === 'transparent' ? 'trans' : b.type, keyCode: b.keyCode, label: b.label };
              if (b.holdAction) {
                if (b.type === 'layer-tap') binding.layer = parseInt(b.holdAction.replace('Layer ', ''));
                if (b.type === 'mod-tap') binding.modifiers = [b.holdAction.toLowerCase()];
                binding.tapLabel = b.tapAction || b.label;
                binding.tapKeyCode = b.tapAction;
              }
              if (b.modifiers) binding.modifiers = b.modifiers.map((m: string) => m.toLowerCase());
              return { id: k.id, binding };
            });
            return { ...existing, name: dl.name || existing.name, index: dl.id ?? i, keys };
          });
          if (data.combos) project.combos = data.combos;
          if (data.macros) project.macros = data.macros;
          store.importProject(project);
          setKeyboardLayout(project.osLayout || 'us');
        } else if (data.layers) {
          store.importProject(data);
          if (data.osLayout) setKeyboardLayout(data.osLayout);
          if (data.deviceSettings && usbConnected) {
            const ok = await applyDeviceSettingsSnapshot(data.deviceSettings);
            if (!ok) alert('一部の実機設定を復元できませんでした。Debug Consoleを確認してください。');
          }
        }
      } catch (err) {
        console.error('Import failed:', err);
        alert('ファイルの読み込みに失敗しました');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <header className="header">
      <div className="header-title">
        <span style={{ cursor: 'pointer' }} onClick={() => setShowChangelog(true)}>ConductorD Studio v{version}</span>
      </div>

      {showChangelog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowChangelog(false)}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, maxWidth: 520, maxHeight: '70vh', overflowY: 'auto', color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.6 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Version History</h2>
              <button className="btn btn-icon" onClick={() => setShowChangelog(false)} style={{ fontSize: 16 }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { v: '0.38.32.0', at: '2026-07-24 JST', changes: ['新機能: トレイメニューに「内蔵キーボードを無効にする」チェックボックスを追加。ConductorやiPadをMacBookのキーボードの上に載せて使う際の誤入力防止用。`hidutil`のDeviceDisabledプロパティを使用(Built-In判定なので機種によらず動作)、カーネル拡張や管理者権限は不要。この設定はOSセッション単位で、再起動すれば必ず有効な状態に戻る(アプリを終了しただけでは元に戻らない点に注意)'] },
                { v: '0.38.31.0', at: '2026-07-24 JST', changes: ['トレイのバッテリー表示を、アイコンに数字を合成する方式から`Tray.setTitle()`によるネイティブ描画に変更。カスタム合成方式(隠しウィンドウのCanvas)はフォントを何度変えてもぼやけて読みにくく(透明ウィンドウでは通常のフォントスムージングが効かないため)、macOS標準のメニューバーフォントで表示することで解消。表示は「[アイコン] L90 R92」(アイコンの右側、macOS仕様上L/Rでの左右挟み込みは不可)'] },
                { v: '0.38.30.0', at: '2026-07-24 JST', changes: ['トレイアイコンのレイアウトを「L残量 / アイコン / R残量」に変更(アイコンを中央、L/Rを左右に分離、以前は右側に2段でR/L)。フォントも太字から通常ウェイトに変更'] },
                { v: '0.38.29.0', at: '2026-07-24 JST', changes: ['ミニマップ(トレイのポップアップ)から直接接続した場合もトレイアイコンにR/Lバッテリーが表示されるように修正。これまではメインのStudioウィンドウでの接続時だけIPCでバッテリー情報を送っており、ミニマップ単体接続だと反映されなかった。切断時もトレイを「R--/L--」に戻すよう通知(Studio側で接続中の間は誤って切断表示にしないようガード付き)'] },
                { v: '0.38.28.0', at: '2026-07-24 JST', changes: ['トレイアイコンがしばらく使用後にメニューバーから消える不具合に対応。原因と推測されるのは、接続中(52px幅)⇄未接続時(元の22px幅アイコン)でアイコン幅が交互に変わることによるmacOSメニューバー配置の不安定化。常に52px幅の合成アイコンを使う(未接続時は「R--/L--」表示)よう変更し、再描画も最短15秒間隔にスロットル。プロセス自体はクラッシュしていなかった(ps auxで生存確認)ため、確定的な原因究明ではなく予防的対応'] },
                { v: '0.38.27.0', at: '2026-07-24 JST', changes: ['トレイアイコンのR/Lバッテリー表示(v0.38.26)で文字が右端で切れていた不具合を修正。アイコン全体の幅を44→52pxに拡張しフォントも調整、実際に画像を書き出して視認できることを確認済み'] },
                { v: '0.38.26.0', at: '2026-07-24 JST', changes: ['新機能: メニューバーの常駐トレイアイコンにR/Lのバッテリー残量を重ねて表示するように変更。元の22x22アイコンの右側に「R82/L75」のように2段で描画(接続中のみ、隠しウィンドウのCanvasで合成)。未接続時は元のプレーンなアイコンに戻る'] },
                { v: '0.38.25.0', at: '2026-07-24 JST', changes: ['v0.38.24で追加したKey Config「Double Tap」TYPEとTimingタブの間隔設定を撤去（ユーザー判断によりリバート）。ファームウェア側の&double_tapビヘイビアとget/set_double_tap_gap RPCも同時にリバート済み(要ファームウェア更新)'] },
                { v: '0.38.23.0', at: '2026-07-22 JST', changes: ['マクロの最大ステップ数をfirmware側で32→50に拡張(要ファームウェア更新)。editor側のステップ数チェック上限も追従。診断タブに前回CI確認時点のFlash/RAM使用量(Dongle/R/L)を追加(実機からのリアルタイム取得ではなく静的な参考値)'] },
                { v: '0.38.22.0', at: '2026-07-22 JST', changes: ['マクロのsetMacroが応答すら返さずタイムアウトし続ける問題の真因を発見・修正。UIの「Tap」1ステップは実機送信時にPress+Releaseの2ステップへ展開されるため、UI上のステップ数(28)と実際の配線ステップ数(46)が乖離し、firmwareの上限32を超過していた。上限超過時はfirmwareが応答自体を返せずResponse timeoutになるだけだったため、これまでのスロット固有バグという推測は誤りだった(スロット0の修正自体はファームウェア側の改善として有効なため維持)。Steps見出しに実際の配線ステップ数を表示し、超過時はWrite to Device前に明確なエラーで止めるように変更'] },
                { v: '0.38.21.0', at: '2026-07-22 JST', changes: ['前バージョンで追加した「特定スロットを避ける」editor側の回避策を撤去。真因がファームウェア側のマクロストレージスロット0固有のバグと判明し、firmware側で該当スロットを最初から使わないよう修正されたため(要ファームウェア更新)、editor側の場当たり的な回避は不要になった'] },
                { v: '0.38.20.0', at: '2026-07-21 JST', changes: ['新規マクロ作成時に毎回同じ特定のスロット(devicetree宣言順で一番最初の動的マクロ)を優先的に割り当てていたのを変更。このスロットはsetMacro書き込みが再現性を持って失敗する(ファームウェア側の原因は未特定、要UARTログ調査)ことが分かったため、空きスロットの末尾から選ぶよう変更し、他に空きがある限りこのスロットを避けるようにした(そのスロットしか空きが無い場合は引き続き使用される)'] },
                { v: '0.38.19.0', at: '2026-07-20 JST', changes: ['マクロのWrite to Deviceが1回目のsetMacro呼び出しでResponse timeoutになったまま何も救済されずに終わる問題に対応。完全リセット後でもタイムアウトする場合があることを確認、原因はまだ完全には特定できていないが、手動での再クリックで通っていた実績があるため、setMacro呼び出し自体に自動リトライ(最大3回)を追加'] },
                { v: '0.38.6.0', at: '2026-07-19 JST', changes: ['カスタムhold-tapビヘイビア（lt6_j等）がWriteのたびに標準のLayer-Tap/Mod-Tapへ静かに置き換わってしまう不具合を修正（J/Zが繰り返し汎用ビヘイビアに戻る症状の真因）。ファームウェアの表示名がカテゴリ名でなく個別名（"lt6_j"等）で返るキーを正しく認識できていなかった。Key Configにキー個別の「カスタムbehavior」選択欄を追加し、既に壊れているキーの復元にも対応'] },
                { v: '0.38.18.0', at: '2026-07-20 JST', changes: ['マクロのWrite to Deviceが繰り返しResponse timeoutで失敗する不具合を修正。ファームウェアのsetMacroはsaveChangesと同様にNVSへ同期的なフラッシュ書き込みを行うが、32スロット化でNVS領域が埋まりガベージコレクションに時間がかかるようになったのに対し、setMacro側のタイムアウトだけUSBデフォルトの5秒のままだった。saveChangesと同じ20秒に延長'] },
                { v: '0.38.17.0', at: '2026-07-20 JST', changes: ['マクロ名に大文字が使えなかった問題を修正。ファームウェア側は単なる文字バッファでケース制限が無く、エディタの入力欄側で小文字/数字/アンダースコアのみに制限していただけだったため、大文字も許可するよう変更'] },
                { v: '0.38.16.0', at: '2026-07-20 JST', changes: ['マクロの空きスロットが無い時のメッセージから、実際とは異なりうる固定の「全16個」という文言を削除（実機側の枠数と無関係な誤表示だったため）。あわせてファームウェア側の別バグ（マクロ一覧のRPC上限が実際には固定+動的マクロ合算で32件までだったため、32枠化後に一部の動的マクロがリストから欠落していた）も修正済み（要ファームウェア更新）'] },
                { v: '0.38.15.0', at: '2026-07-20 JST', changes: ['コードレビュー指摘に基づき3件の書き込み信頼性バグを修正。①キー書き込みが個別に拒否(INVALID_BEHAVIOR等)されても書き込み成功として数えられていた、②現在のキーマップで未使用のbehavior種別(Bluetooth等)を新規に割り当てると誤って無効なIDになりうる、③マクロのWrite失敗時にもアプリ内部では登録済み扱いのまま残ってしまう'] },
                { v: '0.38.14.0', at: '2026-07-20 JST', changes: ['マクロの最大保存数を16→32に倍増（要ファームウェア更新）。基盤のflash/RAM使用率にまだ十分な余裕があることを確認した上で、devicetreeのマクロ枠を追加。ワイヤプロトコル側は元々32件までサポート済みだったためproto変更は不要'] },
                { v: '0.38.13.0', at: '2026-07-20 JST', changes: ['新規マクロで「Write to Device」ボタンが理由の説明なく表示されないことがある問題に対応。原因は実機の空きマクロスロット（全16個）を使い切っている状態だったため、その場合は理由を示すメッセージを表示するように変更。また、マクロ削除時に空いたスロットが再Readするまでプールに戻らなかった問題も修正（削除直後から新規マクロに再利用可能に）'] },
                { v: '0.38.12.0', at: '2026-07-20 JST', changes: ['Macro編集画面で「Write to Device」「⏺ Record keystrokes」ボタンをStepsリストの上に移動（操作順として先に来るべきという指摘のため）'] },
                { v: '0.38.11.0', at: '2026-07-20 JST', changes: ['既存マクロの名前を変更して「Write to Device」しても、キー割り当てが新しい名前でマクロを見つけられず書き込みが失敗する不具合を修正。マクロ名→実機スロットの対応登録が、新規スロット確保時にしか行われておらず、既存マクロの名前変更時には更新されていなかった'] },
                { v: '0.38.10.0', at: '2026-07-19 JST', changes: ['ファームウェア更新ウィザードが、ユニットをブートローダーモードにリセットした瞬間（USB/BLE接続が切れる想定内の動作）に画面ごと消えて続行不能になる不具合を修正。ウィザードが診断タブの「接続中のみ表示」領域の内側に置かれていたため、接続が切れると丸ごとアンマウントされていた。App全体の直下（接続状態に依存しない場所）へ移動し、切断後もウィザードの進行状態が維持されるように'] },
                { v: '0.38.9.0', at: '2026-07-19 JST', changes: ['トラックボールのスクロール反転をONにすると診断表示が「Scroll: 4294966896/100」のような巨大な値になる不具合を修正。反転はワイヤ上uint32のフィールドに負の数を送ることで表現していたが、読み込み側が符号なし前提でしか解釈しておらず反転を正しく検出できていなかった（実際の反転動作自体はファームウェア側では機能していた可能性が高い、表示・検出のみの問題）'] },
                { v: '0.38.8.0', at: '2026-07-19 JST', changes: ['Write前バックアップの保持件数を3件から20件に増加。File メニューの一覧は長くなりすぎないようスクロール表示に対応'] },
                { v: '0.38.7.0', at: '2026-07-19 JST', changes: ['Key Configの「カスタムbehavior」欄で説明文が文字化けしていた不具合を修正（HTML実体参照として解釈される記法をそのまま使っていたため）'] },
                { v: '0.38.5.0', at: '2026-07-19 JST', changes: ['Macアプリ版に更新通知を追加。起動時に自分のリリース一覧を確認し、新しいバージョンがあればヘッダーに「⬇ Studioアップデート」を表示（クリックでDMGを直接ダウンロード）。無署名配布のためelectron-updaterによる完全自動更新（サイレントDL→再起動）はSquirrel.Macがコード署名を必須要件とするため不可——ダウンロード後の上書きインストールは引き続き手動'] },
                { v: '0.38.4.0', at: '2026-07-19 JST', changes: ['「FWダウンロード」ボタンの最終更新日が更新されない不具合を修正。GitHubのpublishedAtは初回公開時刻に固定され、firmware-latestのようにアセットだけを更新し続けるリリースでは実質ずっと同じ日時のままだった。firmware側リリースノートに埋め込んだ実ビルド日時を読むように変更（firmware v0.6.12以降が必要）'] },
                { v: '0.38.3.0', at: '2026-07-19 JST', changes: ['(開発者向け)CIに契約テストを追加。`src/data/zmk-studio-proto.json`(手動更新)がfirmware側の実際の.protoファイルと食い違っていないかを毎push/PRで自動チェック。ユーザー向けの機能変更はなし'] },
                { v: '0.38.2.0', at: '2026-07-19 JST', changes: ['レイヤーパネルに「🎨 テーマ」を追加。現在の全レイヤーのLED配色に好きな名前を付けて保存し、いつでも一括で呼び戻せるように（レイヤー名で対応付けるため、レイヤーの並び替え後も概ね正しく適用される）'] },
                { v: '0.38.1.0', at: '2026-07-19 JST', changes: ['LEDカラーピッカーに「明るさ」スライダーを追加（10-100%）。選んだ色（プリセット・履歴・カスタム）を後から一律に暗く調整可能に。ワイヤ形式・ファームウェアに明るさの概念はないため、スライダーで暗くした色をそのままRGB値として送信する方式（元の色相は保存されない）'] },
                { v: '0.38.0.0', at: '2026-07-19 JST', changes: ['ファームウェア更新ウィザードを追加（Macアプリ版のみ）。診断タブの「ファームウェア構成」に「🔄 アップデート」ボタンが出現し、最新リリースのビルドIDと各ユニットを自動比較→古いユニットだけ、リセットボタン操作の案内付きでUF2ドライブへ直接書き込み。手作業でのファイル取り違え・焼き忘れを防止。ファームウェアリポジトリが非公開のためダウンロード部分のみElectron版限定（`gh` CLI認証を利用）、書き込み自体はブラウザ標準のFile System Access APIで行う'] },
                { v: '0.37.2.0', at: '2026-07-19 JST', changes: ['ファームウェア構成の表示を修正。BLE ATT MTUの制約でL/Rのビルド日時が送信できなくなった(ファームウェア側v0.6.12で修正済み)ため、日時が空でビルドIDのみのユニットを「-- #abc12345」ではなく「#abc12345」と表示するように'] },
                { v: '0.37.1.0', at: '2026-07-18 JST', changes: ['診断タブに「ファームウェア構成」セクションを追加（要ファームウェア最新ビルド）。dongle・L・Rそれぞれのビルド日時とビルドID（同一CIビルドなら3台完全一致）を表示し、不一致があれば警告。接続直後にも自動チェックし、ビルドが食い違っていればトースト通知。L/Rの取り違え・焼き忘れが「なんとなく色が変」等の間接症状ではなく一目で分かるように'] },
                { v: '0.37.0.0', at: '2026-07-18 JST', changes: ['LEDカラーピッカーに「最近使った色」を追加。カスタムで選んだ色（プリセット8色以外）を小窓を閉じたタイミングで自動保存し、次回から履歴スワッチとしてワンクリックで再選択可能に（最新8件、ブラウザに保存）'] },
                { v: '0.36.6.0', at: '2026-07-18 JST', changes: ['Write完了後も「書き込み処理中... (5/5 書き戻し検証)」等の進捗トーストが画面に残り続け、書き込みが終わらないように見える不具合を修正。トーストのスタック表示化(v0.35.4)の際、自動消滅タイマーを持たない進捗トーストが、完了通知（3秒で消える）の後ろに積まれたまま永遠に残るようになっていた。完了・エラー等の最終通知が出た時点で進捗トーストを一掃するように変更（万一に備えた60秒の自動消滅も追加）。※書き込み自体は毎回正常に完了しており、表示だけの問題'] },
                { v: '0.36.5.0', at: '2026-07-17 JST', changes: ['Write中のコンソールに毎回出ていた「getRuntimeState failed: Response timeout」エラーと「Unexpected response id」警告を解消。正体はレイヤー表示・バッテリー用の1秒間隔ポーリングが、Flash保存（firmware側で数秒ブロックする）中にタイムアウトしていただけの無害なノイズで、Write自体の失敗ではない。Write処理中はポーリングを一時停止するように変更'] },
                { v: '0.36.4.0', at: '2026-07-17 JST', changes: ['LEDの色をWriteしても実機に壊れた色が書き込まれることがあった問題のエディタ側修正。v0.36.0より前のキャッシュに残っていた旧形式の色名（green・cyan等の英単語）を、新形式の16進数として誤って解釈していた（cyanが#00000c扱いになる等）。読み込み時に旧形式を自動で対応する色に変換するように修正。※実機のLEDに中間色（カスタム色）が物理的に光らない問題は別途ファームウェア側でも修正済み、最新FWの焼き直しが必要'] },
                { v: '0.36.3.0', at: '2026-07-17 JST', changes: ['LEDカラーピッカーの挙動を変更。プリセット色をクリックしたり「カスタム」で色を調整するたびに小窓が閉じてしまい、複数の色を試せなかったのを修正。今後は色を選んでも小窓は開いたままになり、選び終わったら「閉じる」ボタンで明示的に閉じる方式に変更（プリセットのトグルボタンをもう一度押しても閉じます）'] },
                { v: '0.36.2.0', at: '2026-07-17 JST', changes: ['LEDカラーピッカーの小窓が、開いた場所と実際に描画される位置がズレていたため、色を選ぼうとクリックすると別のレイヤー行に当たって閉じてしまう不具合を修正。小窓を配置する基準となる親要素にposition指定が無く、フレックスレイアウトの都合で本来の行から離れた場所に表示されていたのが原因。行に対して確実に真下に表示されるよう修正'] },
                { v: '0.36.1.0', at: '2026-07-17 JST', changes: ['LED カラーピッカーで「カスタム」からネイティブのカラー選択を終えても小窓が閉じないままだった不具合を修正。プリセットの8色ボタンはクリック時に小窓を閉じていたが、カスタムカラー入力にはその処理が抜けていた'] },
                { v: '0.36.0.0', at: '2026-07-16 JST', changes: ['レイヤーLEDの色を8色固定からフルRGB（カラーピッカーで自由選択）に拡張（要ファームウェア最新ビルド）。ドングルのLEDは元々PWM駆動のフルカラーLEDだが、ソフトウェア側が8色（各チャンネルon/offの組み合わせ）しか扱っていなかったのを解消。従来の8色はクイック選択プリセットとして残しつつ、その下の「カスタム」からネイティブのカラーピッカーで任意の色を選択可能に。ファームウェア側でレイヤー色の永続化キーを変更したため、アップデート後は各レイヤーの色が一度リセットされる（選び直しが必要）'] },
                { v: '0.35.5.0', at: '2026-07-15 JST', changes: ['ヘッダーのバージョン表示横にあったレイヤー名テキストを削除。同じ場所のLEDカラードットが色でレイヤーを示しており、テキストは役目を終えていたため（ドット自体は継続表示）'] },
                { v: '0.35.4.0', at: '2026-07-15 JST', changes: ['トースト通知をスタック表示に変更。従来は新しい通知が前の通知を即座に置き換えるだけだったが、新しい通知が手前にパタッと現れ、それまで表示していた通知は後ろに退いて重なって見えるアニメーションに変更（最大3件まで表示、それより古いものは自動で外れる）。Write時の「1/5 → 5/5」のような連続進捗表示で特に効果を発揮'] },
                { v: '0.35.3.0', at: '2026-07-15 JST', changes: ['Write時にコンボの一部RPCがタイムアウトすると、書き戻し検証が「コンボ数: 期待0件 → 実機N件」という偽の不一致を報告していた不具合を修正。実際にはコンボは実機側で変化していないのに、内部で計算済みだった「書き込みたい内容」の集合がタイムアウト発生時に丸ごと空配列にリセットされてから検証に渡っていたのが原因（内部データは失われておらず表示上の誤検知だった）。あわせて、コンボ書き込みの各RPC呼び出しを個別にtry/catchするように変更し、1件のタイムアウトで残り全部のコンボ書き込みが連鎖的に中断されないように改善（実際のWriteログで発覚、実機未検証）'] },
                { v: '0.35.2.0', at: '2026-07-15 JST', changes: ['コンボ「scroll」等で発生していた「存在しないレイヤー参照」エラーが消えない問題を修正。原因は過去に削除したレイヤー（14〜19番)へのACTIVE LAYERS参照がローカルデータに残り続けていたこと——該当レイヤーは既にUIから存在しないため、Active Layersのピッカーで選び直して外す手段が無く、Writeするたびに監査エラーが再発していた。読み込み時（Read/File読込/キャッシュ復元のいずれも）に存在しないレイヤーへの参照を自動的に取り除くように変更。参照先が既に存在しない値なので実際の動作への影響はなし（=既に無効化されていた値を消すだけ）。設定監査のメッセージも改善し、同じ値が何度も重複しているケースと本当に多数の異なるレイヤーを参照しているケースを区別できるように（配列サイズ・範囲外件数・一意な値の個数と範囲を表示）'] },
                { v: '0.35.1.0', at: '2026-07-14 JST', changes: ['設定監査に「同じ名前のコンボがローカルに重複している」検出を追加。90件近い不正レイヤー参照として表示されていた実例が、実は同名コンボの重複保存だった場合に一目で分かるように。あわせて、診断タブの「設定監査」セクションが未接続時は非表示になっていた不具合を修正（実機診断部分だけ接続必須、設定監査はローカルデータのみで動くため常時表示・常時「再検査」可能に）'] },
                { v: '0.35.0.0', at: '2026-07-14 JST', changes: ['タイミングタブに「キーボード側キーリピート」トグルを追加（要ファームウェア最新ビルド、デフォルトOFF）。ONにすると修飾キー・メディアキー以外の通常キーを押し続けたとき、ホストOSの設定に関係なくキーボード自身が高速に離す→押すを繰り返して連続入力を送信。macOSで英字キーが長押しリピートせずアクセント候補ポップアップが出てしまう問題への対策'] },
                { v: '0.34.0.0', at: '2026-07-14 JST', changes: ['タイミングタブにHold-Tap Flavor設定を追加（要ファームウェア最新ビルド）。&mt/&lt/mt_shift/lt6_j/mt_shift_zそれぞれに hold-preferred/balanced/tap-preferred/tap-unless-interrupted を個別設定可能に。デバイスのFlashに保存され、従来flavorの変更に必要だったファームウェア再ビルド・書き込みが不要に。比較表も表示'] },
                { v: '0.33.6.0', at: '2026-07-14 JST', changes: ['「FWダウンロード」を直接ダウンロード方式に戻す（v0.32.1でリリースページ方式に変更したのを差し戻し）。firmware側のzipは日付入りファイル名がメインだが、互換用の固定名コピー（ConductorD-firmware-latest.zip）を毎回並行アップロードしているため、1クリックの直接ダウンロードのまま成立する'] },
                { v: '0.33.5.0', at: '2026-07-14 JST', changes: ['メニューバーのアイコン（トレイアイコン）が旧デザイン（左右2クラスター）のまま変わっていなかった不具合を修正。build/icon.icnsとは別ファイル（electron/trayIcon.png）だったため見落としていた。v0.33.3と同じ右キーボードのみのデザインに統一'] },
                { v: '0.33.4.0', at: '2026-07-14 JST', changes: ['Macアプリ版の初期起動ウィンドウサイズを固定1400x900から画面の使用可能領域いっぱい（メニューバー・Dock除く）に変更。FHD(1920x1080)ディスプレイでは約1920x1055になり、既にFHD向けに調整済みの90%ズームと組み合わせて画面を有効活用'] },
                { v: '0.33.3.0', at: '2026-07-14 JST', changes: ['Macアプリ版のアイコンを左右2つのキークラスター構成から右キーボード（トラックボール付き）のみに変更。中央に配置し1.35倍に拡大して見やすさを確保'] },
                { v: '0.33.2.0', at: '2026-07-14 JST', changes: ['Macアプリ版で「FWダウンロード」を押すと404になる不具合を修正。アプリ内ブラウザはGitHubにログインしていないためプライベートリポジトリのページが404になっていた。外部リンク（FWダウンロード等のhttp/httpsリンク）はすべてmacOSの既定ブラウザ（GitHubログイン済み）で開くように変更。リンククリックでStudio画面自体が遷移してしまう問題も同時に解消'] },
                { v: '0.33.1.0', at: '2026-07-14 JST', changes: ['ミニマップの最前面表示を強化。ウィンドウレベルをfloating→screen-saverに引き上げ、全Space・他アプリのフルスクリーンの上でも表示されるように変更（従来はフルスクリーンアプリの上や別Spaceに移ると見えなくなっていた）'] },
                { v: '0.33.0.0', at: '2026-07-14 JST', changes: ['「FWダウンロード」ボタンに最新FWの最終更新日時（firmware-latestの公開日時、JST表示）を表示するように変更。アプリ起動時に自動取得し、デバイス接続時にも更新。Macアプリ版のみ（Web版はプライベートリポジトリのAPIに触れないため従来通り表示なし）'] },
                { v: '0.32.1.0', at: '2026-07-14 JST', changes: ['FWのzipファイル名に日付を追加（ConductorD-firmware-latest-YYYYMMDD-HHMM.zip、JST）。ダウンロードフォルダで複数のビルドを見分けられるように。「FWダウンロード」ボタンはリリースページを開く方式に変更（ファイル名が毎回変わるため直リンク不可。ページにはバージョン・ビルド元コミットも表示される）。旧来の日付なしURLも互換のため引き続き有効'] },
                { v: '0.32.0.0', at: '2026-07-14 JST', changes: ['Writeを安全なトランザクション方式に強化。①Write前に設定監査を実行し、エラーがあれば確認ダイアログで警告 ②Write前に実機の直前状態を自動バックアップ（直近3件、File>「⟲ Write前バックアップ」から復元可能） ③Write完了後に実機から再読込して書いた内容と一致するか検証（USB接続時のみ。不一致があればエラー表示して未保存状態を維持） ④進捗表示を5段階に拡張（5/5が書き戻し検証）'] },
                { v: '0.31.0.0', at: '2026-07-14 JST', changes: ['設定監査機能を追加。Readのたびに設定の不整合を自動検査し、問題があればトースト通知+診断タブに赤/黄で一覧表示（📋コピーにも含まれる）。検査対象: カスタムbehavior（lt6_j等）がどのキーからも参照されなくなっていないか（過去のJ/Z上書き問題の再発検知）、実機に存在しないbehavior参照（NVS破損の兆候）、存在しないレイヤーへの参照、コンボの重複・包含関係による発火不能・不正キー数・変換不能な出力、参照先のないマクロ・空マクロ。診断タブから手動再検査も可能'] },
                { v: '0.30.2.0', at: '2026-07-14 JST', changes: ['「Macアプリダウンロード」が404になることがある不具合を修正。リンクをバージョン番号付きファイル名からバージョン番号なし（毎リリース同梱）に変更し、Web版のキャッシュ・デプロイとDMGリリースの時間差があっても常に最新リリースのDMGが取得できるように'] },
                { v: '0.30.1.0', at: '2026-07-14 JST', changes: ['Macアプリ版のStudioウィンドウを90%ズームで起動するように変更（FHDディスプレイで手狭だったため。Cmd+/-でのセッション中の調整は従来通り、ミニマップは対象外）'] },
                { v: '0.30.0.0', at: '2026-07-14 JST', changes: ['コンボ編集に「REQUIRE PRIOR IDLE (MS)」（直前にコンボ以外のキーを打った直後はコンボを発火させない、タイピング中の誤爆対策。0=無効）と「SLOW RELEASE」（全キーを離すまでコンボ動作を保持）を追加。firmwareのRPCには元々あったが編集UIに露出していなかったパラメータで、Read/Writeの往復にも対応'] },
                { v: '0.29.0.0', at: '2026-07-14 JST', changes: ['FW更新通知を追加（Macアプリ版のみ）。接続時にCIが公開している最新FW（firmware-latest）と接続中デバイスのバージョン・ビルド日時を比較し、新しいFWがあればトースト通知+FWダウンロードボタンにオレンジのバッジを表示。リポジトリがプライベートのため照会はローカルのgh CLI経由（Web版はチェックなしで従来通り）'] },
                { v: '0.28.0.0', at: '2026-07-13 JST', changes: ['コンボ書き込みを差分方式に変更。従来はWriteのたびに全コンボを削除→再追加していたが、変更のあったコンボだけを更新（未変更ならRPCゼロ）するように。コンボを触っていないWriteが数秒速く', 'Write進捗トーストに段階表示を追加（1/4 レイヤー設定 → 2/4 キー割り当て → 3/4 コンボ → 4/4 Flash保存）'] },
                { v: '0.27.0.0', at: '2026-07-13 JST', changes: ['コンボ名を実機に保存するように対応（要ファームウェア0.6.12+の最新ビルド）。protoにnameフィールドを追加し、Writeでコンボ名がデバイスのFlashに永続化、別のPC・ブラウザから接続しても名前が復元されるように。DTデフォルトコンボ（scroll/gesture/pair/boot）はfirmwareがdevicetreeのノード名を直接報告。旧firmwareでは従来通りローカル名でのフォールバック動作'] },
                { v: '0.26.5.0', at: '2026-07-13 JST', changes: ['Readのたびにコンボ名が「Combo 1」等の仮名に上書きされていた不具合を修正。ZMK Studioのコンボ用RPCには元々名前を保持するフィールドが無く、実機からのReadで機械的な仮名に置き換わっていた（接続直後の自動Readも含む）。既存のローカル名を位置で突き合わせて優先するように変更'] },
                { v: '0.26.4.0', at: '2026-07-13 JST', changes: ['Write実行中に「⏳ 書き込み処理中...」トーストを表示するように変更。firmware側の保存処理が変更点の数に応じて長くなる（saveChangesは1キーごとに直列でflashへ保存するため）ため、完了までの間も無反応に見えないように改善。完了時は従来通り成功/失敗のトーストに切り替わる'] },
                { v: '0.26.3.0', at: '2026-07-13 JST', changes: ['ヘッダーに「FWダウンロード」ボタンを追加。conductor-dongle側のCIがrelease/conductor-*ブランチへのpush毎に自動更新するfirmware-latest（dongle/L/R/settings_reset一式のzip）へのリンク。Macアプリダウンロードと違い、Web版・Electron版どちらでも常時表示'] },
                { v: '0.26.2.0', at: '2026-07-13 JST', changes: ['Write時に「Save failed: Response timeout」でFlash保存が失敗して見える不具合を修正。firmware側のsaveChangesは変更したキー1つずつを直列でsettings保存するため、変更点が多いとUSB接続時の5秒タイムアウトを実際の保存時間が超えることがあった（デバイス側は正常に保存し続けているのに、クライアントが先に諦めていた）。該当RPCのタイムアウトを20秒に延長'] },
                { v: '0.26.1.0', at: '2026-07-13 JST', changes: ['Write失敗時にトーストが一切出ず無反応に見えていた不具合を修正。デバイス書き込み・Flash保存が失敗、または例外が発生した場合にエラートーストを表示するように変更（従来は成功時のトーストのみで、失敗時は完全に無音だった）。詳細はヘッダーの「>_」デバッグコンソールで確認可能'] },
                { v: '0.26.0.0', at: '2026-07-13 JST', changes: ['ピンチズームを実際に使えるように対応。firmwareに専用behavior「&pinch_zm」(display-name: Pinch Zoom)を新規実装（押下でCtrl保持+scrollレイヤーを一時有効化、離すと両方解除）し、コンボの「デバイス機能」リストおよび通常のKey ConfigのDeviceカテゴリから選択・保存可能に。スリープ(電源オフ)は上流ZMKのdeep sleep issue解決待ちのため引き続き未対応。実機での動作確認はまだ'] },
                { v: '0.25.2.0', at: '2026-07-13 JST', changes: ['通常のキー設定（Key Config）でも「AML Tog」をDeviceカテゴリから選択できるように対応。コンボ限定だった&aml_togバインドが、普通のキーにも割り当て可能に'] },
                { v: '0.25.1.0', at: '2026-07-13 JST', changes: ['「デバイス機能」を専用リスト（ピンチズーム・AML切替・スリープ）に変更し、AML切替を実際に選択・保存できるように対応（firmwareの&aml_togに接続）。ピンチズーム・スリープは現行firmwareで未実装のため選択不可表示。あわせて、前バージョンで追加したMouse/DeviceカテゴリのキーコードがWrite時に正しいbehaviorへ解決されていなかった不具合を修正'] },
                { v: '0.25.0.0', at: '2026-07-12 JST', changes: ['コンボ編集画面を強化。BINDING TYPEに「Mouse Button」「デバイス機能」を追加（クリックでOUTPUT KEYのカテゴリ欄も自動でジャンプ）、OUTPUT KEYを単純なテキスト入力からカテゴリ別キーコードピッカー（検索・Letters/Numbers/Mouse/Deviceなど全カテゴリ表示）に変更'] },
                { v: '0.24.3.0', at: '2026-07-12 JST', changes: ['キーボード左右の隙間が不自然に広かった不具合を修正。可変グリッド設定がCSSの詳細度不足で固定48pxグリッドに上書きされ、各半分の箱の中でキーが左寄せになり右端に余白ができていたのが原因'] },
                { v: '0.24.2.0', at: '2026-07-12 JST', changes: ['キーボードが左右均等にセンタリングされていなかった不具合を修正。縦スクロールバーを画面全体ではなくタブ内容の領域だけに持たせるよう変更し、スクロールバー分の幅のズレが解消'] },
                { v: '0.24.1.0', at: '2026-07-12 JST', changes: ['統合タブバーの幅を672px→820pxに拡大し、「診断」タブが2行目に折り返されていたのを修正（8タブ全てが1行に収まるように）'] },
                { v: '0.24.0.0', at: '2026-07-12 JST', changes: ['レイアウトを再設計。Layers/Combos/Macros と Key Config/Trackball/Timing/デバイス/診断 の8タブを1本の横並びタブバーに統合し、キーボード直下に配置。常に1つのパネルだけを表示する形に変更（前バージョンの「横並び2パネル」表示は撤回）'] },
                { v: '0.23.1.0', at: '2026-07-12 JST', changes: ['キーボード・レイヤー/コンボ/マクロ一覧・右側の設定パネルを、通常の横長ウィンドウでは横並び表示に変更（縦長ウィンドウ時のみ従来通り縦積み）。今週の変更で常時縦積みになっていたのを、横幅がある場合は横並びに戻した'] },
                { v: '0.23.0.0', at: '2026-07-12 JST', changes: ['接続パネル・実機診断に peripheral(L/R) の実際の接続状態を表示（要ファームウェア0.6.12+、バッテリー値からの推測表示だった旧FWでは引き続き推測表示）。あわせて、接続時にファームウェアが最小対応バージョンより古い場合に警告するように変更'] },
                { v: '0.22.0.0', at: '2026-07-12 JST', changes: ['実機診断タブに「📋 コピー」ボタンを追加。表示中の診断内容をテキストとしてクリップボードにコピーし、不具合報告時に貼り付けやすく'] },
                { v: '0.21.0.0', at: '2026-07-12 JST', changes: ['デバイス(BT/USB)設定コピーを複数選択・一括適用に対応。コピー先を個別にチェック、または「すべて選択」で全デバイスへ一度に、キーマップオーバーレイとジェスチャ4方向をコピーできるように変更'] },
                { v: '0.20.9.0', at: '2026-07-12 JST', changes: ['実機設定バックアップの安全性を修正: Export/トラックボール比較が確認なしに全スロットの出力先を切り替えていた挙動に確認ダイアログを追加、比較表がタブを開くだけで自動巡回していた不具合を修正、ロック中のExportが空データを黙って出力していた問題を修正、複数スロット走査後の出力先復元が不明な場合に0番へ誤って固定されていた不具合を修正、復元不能なcursor比率のバックアップ項目を削除'] },
                { v: '0.20.8.0', at: '2026-07-12 JST', changes: ['接続パネルに dongle connection health 表示を追加。active output、L/R online 状態、battery、layer state、OS profile を接続直下で確認可能にし、未露出の last-received / layer sync は未対応と明示'] },
                { v: '0.20.7.0', at: '2026-07-12 JST', changes: ['右ペインに「診断」タブを追加。接続中の実機から device info、レイヤー状態、バッテリー、AML、トラックボール設定、BT/USBスロット、デバイス別キーマップ/ジェスチャ設定を一覧表示'] },
                { v: '0.20.6.0', at: '2026-07-12 JST', changes: ['Export .json / Import .json が、接続中の実機設定（トラックボール、AML、デバイス別キーマップ、デバイス別ジェスチャ、BT/USB名など）もバックアップ・復元するように変更'] },
                { v: '0.20.5.0', at: '2026-07-12 JST', changes: ['シリアル/Bluetoothのポート選択ダイアログを、接続操作をしたウィンドウ（ミニマップ等）にシート表示するように変更（別ディスプレイに出る問題を解消）'] },
                { v: '0.20.4.0', at: '2026-07-12 JST', changes: ['ダウンロードされるDMGのファイル名にバージョン番号を含めるように変更'] },
                { v: '0.20.3.0', at: '2026-07-12 JST', changes: ['ミニマップの切断ボタンをmac風の✕ボタン（左上）に変更、未接続時も閉じるボタンとして機能', 'StudioでWrite成功後、ヘッダーに「ミニマップを起動」ボタンを表示（ミニマップを出してStudioを片付ける・接続は維持）'] },
                { v: '0.20.2.0', at: '2026-07-12 JST', changes: ['ミニマップがダーク設定なのにライトで起動する不具合を修正（初期テーマIPCの取りこぼしを解消）', 'グリップを目立つピル型ハンドルに変更（初期画面にも表示）', '初期表示位置をメインモニター最下段の中央に変更'] },
                { v: '0.20.1.0', at: '2026-07-12 JST', changes: ['アプリ起動時にStudioではなくミニマップを表示', 'ミニマップに「Editorへ」ボタン（Studioを開く）', 'ミニマップのデフォルトをダークテーマ・不透明度55%に', '切断ボタンでミニマップも閉じる（トレイから再表示可）', 'ドラッグできる位置に⠿グリップマークを表示'] },
                { v: '0.20.0.0', at: '2026-07-12 JST', changes: ['Studioとミニマップの接続ハンドオフ（アプリ版）: ミニマップ接続中でもStudioのConnectを押すだけで接続を自動で引き継ぎ、Studioを切断するとミニマップ(USB)が自動で取り返す'] },
                { v: '0.19.9.0', at: '2026-07-11 JST', changes: ['スクロールバーを背景と同系の控えめな色に変更（ライト/ダーク両テーマ）'] },
                { v: '0.19.8.0', at: '2026-07-11 JST', changes: ['マクロ録画がプレス/リリースを正しく記録するように修正（修飾キー押しっぱなしがPress/Releaseで残り、通常キーはTapに自動圧縮）、オートリピートの重複記録も防止'] },
                { v: '0.19.7.0', at: '2026-07-11 JST', changes: ['デバイス設定（キーマップオーバーレイ＋ジェスチャ4方向）を他のデバイスへコピーする機能'] },
                { v: '0.19.6.0', at: '2026-07-11 JST', changes: ['ミニマップ単体で接続した場合の切断ボタンをヘッダーに追加'] },
                { v: '0.19.5.0', at: '2026-07-11 JST', changes: ['バッテリーバッジの位置を内側親指キー（BSPC/Enter）上に変更'] },
                { v: '0.19.4.0', at: '2026-07-11 JST', changes: ['ミニマップ（ポップアップ）の英数/かなキー上に、それぞれL/Rのバッテリー残量バッジを表示'] },
                { v: '0.19.3.0', at: '2026-07-09 JST', changes: ['ポップアップを別ディスプレイに移動後、移動できなくなる不具合を修正（macOS alwaysOnTop + 複数ディスプレイの既知バグを回避）'] },
                { v: '0.19.2.0', at: '2026-07-09 09:15 JST', changes: ['ポップアップの「読み込み中」表示時に接続ボタンが出ていなかった不具合を修正'] },
                { v: '0.19.1.0', at: '2026-07-09 09:00 JST', changes: ['ポップアップ単体でUSB/Bluetooth接続可能に（メインエディタ不要）', '隠し機能: ポップアップ上でスクロールして不透明度を無段階調整'] },
                { v: '0.19.0.0', at: '2026-07-09 08:16 JST', changes: ['Electronデスクトップアプリ化（メニューバー常駐）', 'トレイ右クリックからレイヤー配列ポップアップ（移動/リサイズ/不透明度/ライト・ダーク切替）', 'ポップアップに押下キーの発光表示、リサイズ時の自動フィット表示', 'Web版ヘッダーにMacアプリダウンロードボタン追加'] },
                { v: '0.18.22.0', at: '2026-07-07 17:04 JST', changes: ['Diffモードとデバイス別キーマップオーバーレイのチップグリッド選択機能'] },
                { v: '0.18.21.0', at: '2026-07-07 16:31 JST', changes: ['トラックボールのドラッグ精密モード（ボタン長押しで感度スケール）'] },
                { v: '0.18.20.0', at: '2026-07-07 12:20 JST', changes: ['コンボRPCで実機とコンボ設定を同期'] },
                { v: '0.18.19.0', at: '2026-07-07 12:03 JST', changes: ['接続時の自動キーマップ読み込みを停止（明示的なReadのみに）'] },
                { v: '0.18.18.0', at: '2026-07-07 11:59 JST', changes: ['マクロ記録中にテンキー入力を正しく記録するよう修正'] },
                { v: '0.18.17.0', at: '2026-07-07 11:47 JST', changes: ['IMEキーコードに日本語の機能名ラベルを追加'] },
                { v: '0.18.16.0', at: '2026-07-07 11:43 JST', changes: ['スクロールバーを背景色になじませるスタイル調整'] },
                { v: '0.18.15.0', at: '2026-07-07 10:03 JST', changes: ['BT5（Studio）キーコードを削除（ドングルに存在しないプロファイルのため）'] },
                { v: '0.18.14.0', at: '2026-07-06 19:24 JST', changes: ['公式zmk-studio-ts-clientの接続フローに合わせて修正'] },
                { v: '0.18.13.0', at: '2026-07-06 19:13 JST', changes: ['BLEサービスUUIDフィルタを削除（無効な候補が出る不具合の修正）'] },
                { v: '0.18.12.0', at: '2026-07-06 13:19 JST', changes: ['既に接続済みのドングルをBLEデバイス選択に表示するよう修正'] },
                { v: '0.18.11.0', at: '2026-07-06 13:13 JST', changes: ['BluetoothでのStudio接続に対応（Web Bluetoothトランスポート）'] },
                { v: '0.18.10.0', at: '2026-07-06 12:01 JST', changes: ['L/Rバッテリー残量を物理的な左右順で個別表示'] },
                { v: '0.18.9.0', at: '2026-07-06 11:44 JST', changes: ['デバッグコンソールをオンデマンド表示に変更、保存トーストを色分け'] },
                { v: '0.18.8.0', at: '2026-07-06 11:36 JST', changes: ['左右半分の間隔を広げ、トラックボール円の潰れを修正'] },
                { v: '0.18.7.0', at: '2026-07-06 11:22 JST', changes: ['トラックボールに慣性（グライド）タブ追加、ON/OFFと調整機能'] },
                { v: '0.18.6.0', at: '2026-07-05 17:06 JST', changes: ['IMEキーコードカテゴリにmacOSのGlobe/fnキーを追加'] },
                { v: '0.18.5.0', at: '2026-07-05 16:26 JST', changes: ['レイヤースイッチャー下部の余白調整'] },
                { v: '0.18.4.0', at: '2026-07-05 13:02 JST', changes: ['接続時に自動でキーマップを読み込むように修正（明示的なReadだけでなく）'] },
                { v: '0.18.3.0', at: '2026-07-05 12:56 JST', changes: ['カスタムビヘイビアをファームウェアマクロと誤検出する不具合を修正'] },
                { v: '0.18.2.0', at: '2026-07-05 11:50 JST', changes: ['デバイスパネルを常にキーボード下に中央揃えで配置'] },
                { v: '0.18.1.0', at: '2026-07-05 11:37 JST', changes: ['USB仮想スロット、デバイスタブ刷新、ジェスチャレイヤーのデバイス選択、縦画面レイアウト対応'] },
                { v: '0.18.0.0', at: '2026-07-04 12:54 JST', changes: ['全体Resetでマウス加速度を「弱」にリセット'] },
                { v: '0.17.4.0', at: '2026-07-04 07:07 JST', changes: ['Key ConfigのKey Codeクリックでレイヤータップ/Mod-TapがBasicに戻ってしまう不具合を修正'] },
                { v: '0.17.3.0', at: '2026-07-02 11:41 JST', changes: ['bindingベースジェスチャRPC用にproto JSONを再生成'] },
                { v: '0.17.2.0', at: '2026-07-02 10:34 JST', changes: ['Readでレイヤーのledカラーを実際には取得していなかった不具合を修正'] },
                { v: '0.17.1.0', at: '2026-07-02 10:04 JST', changes: ['ジェスチャ4方向を1クリックで共有設定に一括リセット'] },
                { v: '0.17.0.0', at: '2026-07-02 09:08 JST', changes: ['ジェスチャ編集を新しいbindingベースのRPCに切り替え'] },
                { v: '0.16.1.0', at: '2026-07-02 08:23 JST', changes: ['保護されていないレイヤーのLEDドット表示ズレ修正'] },
                { v: '0.16.0.0', at: '2026-07-02 08:20 JST', changes: ['USBデバイス名の編集機能（get/set_usb_name）'] },
                { v: '0.15.1.0', at: '2026-07-02 08:07 JST', changes: ['キーマップドロップダウンでオーバーレイレイヤーを直接選択可能に'] },
                { v: '0.15.0.0', at: '2026-07-02 08:01 JST', changes: ['デバイスごとのキーマップオーバーレイ切り替え機能'] },
                { v: '0.14.2.0', at: '2026-07-02 07:51 JST', changes: ['デバイスジェスチャ一覧をBluetoothプロファイル行に統合'] },
                { v: '0.14.1.0', at: '2026-07-02 07:44 JST', changes: ['ジェスチャの上下左右位置マッピング修正'] },
                { v: '0.14.0.0', at: '2026-07-02 07:32 JST', changes: ['出力デバイスごとのトラックボールジェスチャ編集（デバイスタブ）'] },
                { v: '0.13.3.0', at: '2026-07-02 06:51 JST', changes: ['BluetoothプロファイルのリネームAPIと実プロファイル状態読み込みを配線'] },
                { v: '0.13.2.0', at: '2026-07-01 21:43 JST', changes: ['Write時にレイヤーLEDカラーをデバイスに送信するよう修正'] },
                { v: '0.13.1.0', at: '2026-07-01 16:14 JST', changes: ['位置限定ホールドタップ設定パネル追加'] },
                { v: '0.13.0.0', at: '2026-06-30 07:43 JST', changes: ['AML持続時間のFW RPC対応（duration_ms）'] },
                { v: '0.12.4.0', at: '2026-06-30 07:31 JST', changes: ['AML詳細設定ボタンからコンボタブのAML編集を直接展開'] },
                { v: '0.12.3.0', at: '2026-06-30 07:27 JST', changes: ['ライトモードを初期テーマに変更'] },
                { v: '0.12.2.0', at: '2026-06-30 07:23 JST', changes: ['導線ボタンをアクセントカラーに統一'] },
                { v: '0.12.1.0', at: '2026-06-30 07:18 JST', changes: ['AML詳細設定をコンボタブに移動', 'トラボAMLタブはクイックON/OFFのみに'] },
                { v: '0.12.0.0', at: '2026-06-30 07:09 JST', changes: ['コンボごとのAML抑制フラグ追加'] },
                { v: '0.11.2.0', at: '2026-06-30 07:02 JST', changes: ['AML除外キーをミニキーボードで選択可能に'] },
                { v: '0.11.1.0', at: '2026-06-30 06:59 JST', changes: ['コンボタブのAML重複を削除（トラックボールAMLタブに一本化）'] },
                { v: '0.11.0.0', at: '2026-06-30 06:49 JST', changes: ['トラックボール設定を AML / ジェスチャ / カーソル の3タブに分割'] },
                { v: '0.10.2.0', at: '2026-06-30 06:44 JST', changes: ['保存ボタンの対象範囲をグループヘッダーで明示'] },
                { v: '0.10.1.0', at: '2026-06-30 06:41 JST', changes: ['トラックボール設定に機能キャプション追加', 'セクション間隔の調整'] },
                { v: '0.10.0.0', at: '2026-06-30 06:38 JST', changes: ['AML 持続時間スライダー追加', 'AML設定適用ボタンのデザイン改善'] },
                { v: '0.9.1.0', at: '2026-06-30 06:32 JST', changes: ['Record ボタンを目立つ位置に移動'] },
                { v: '0.9.0.0', at: '2026-06-30 06:23 JST', changes: ['マクロレコーディングモード（キー入力キャプチャ）'] },
                { v: '0.8.2.0', at: '2026-06-29 14:54 JST', changes: ['Export ボタンを File にリネーム'] },
                { v: '0.8.1.0', at: '2026-06-29 14:53 JST', changes: ['デバッグコンソール背景をテーマ変数に統一'] },
                { v: '0.8.0.0', at: '2026-06-29 14:52 JST', changes: ['トースト通知', 'Read 時の未保存確認ダイアログ', 'レイヤー名の保持', 'Undo スタック上限 50'] },
                { v: '0.7.4.0', at: '2026-06-29 14:46 JST', changes: ['レイヤースイッチャーの折り返し防止'] },
                { v: '0.7.3.0', at: '2026-06-29 14:43 JST', changes: ['「Click a key to configure」ヒント削除'] },
                { v: '0.7.2.0', at: '2026-06-29 14:42 JST', changes: ['バージョン履歴にパッチバージョンを含める'] },
                { v: '0.7.1.0', at: '2026-06-29 14:40 JST', changes: ['バージョン履歴ダイアログ'] },
                { v: '0.7.0.0', at: '2026-06-29 14:34 JST', changes: ['ダーク/ライトモード切替'] },
                { v: '0.6.15.0', at: '2026-06-29 14:23 JST', changes: ['マウスボタンのビットフラグ修正（MB3=4）'] },
                { v: '0.6.14.0', at: '2026-06-29 13:57 JST', changes: ['TS ビルドエラー修正'] },
                { v: '0.6.13.0', at: '2026-06-29 13:22 JST', changes: ['マウスキー（Click/R Click/M Click）の正しい書き込みと表示'] },
                { v: '0.6.12.0', at: '2026-06-29 13:15 JST', changes: ['デバッグコンソールのコピーボタン'] },
                { v: '0.6.11.0', at: '2026-06-29 13:11 JST', changes: ['Mod-Tap の param1=hold, param2=tap エンコード修正'] },
                { v: '0.6.10.0', at: '2026-06-29 13:05 JST', changes: ['Basic モディファイア（グレー）と Mod-Tap ホールド（オレンジ）の色分け'] },
                { v: '0.6.9.0', at: '2026-06-29 13:01 JST', changes: ['Read 時にモディファイア付き basic キーのモディファイアを分離'] },
                { v: '0.6.8.0', at: '2026-06-29 12:57 JST', changes: ['右 Shift 等でも Shifted シンボル表示（RS+; → :）'] },
                { v: '0.6.7.0', at: '2026-06-29 12:49 JST', changes: ['Basic キーのモディファイアを HID param にエンコード', 'モディファイア付きキーの左下表示'] },
                { v: '0.6.6.0', at: '2026-06-29 12:46 JST', changes: ['dirty keys の layer index 不一致修正'] },
                { v: '0.6.5.0', at: '2026-06-29 12:41 JST', changes: ['左モディファイアに L プレフィックス統一'] },
                { v: '0.6.4.0', at: '2026-06-29 12:38 JST', changes: ['デバイス読み込み mod-tap のホールドラベル表示'] },
                { v: '0.6.3.0', at: '2026-06-29 12:16 JST', changes: ['タップキー中央・ホールドアクション左下表示'] },
                { v: '0.6.2.0', at: '2026-06-29 12:12 JST', changes: ['選択キーの背景を明るく'] },
                { v: '0.6.1.0', at: '2026-06-29 12:08 JST', changes: ['ジェスチャキーピッカーにモディファイアトグル追加'] },
                { v: '0.6.0.0', at: '2026-06-29 12:05 JST', changes: ['ジェスチャショートカットのインラインキーピッカー'] },
                { v: '0.5.11.0', at: '2026-06-29 11:49 JST', changes: ['トラックボールクリックで Trackball タブを開く'] },
                { v: '0.5.10.0', at: '2026-06-29 11:46 JST', changes: ['トラックボールプレースホルダーを真円に'] },
                { v: '0.5.9.0', at: '2026-06-29 11:43 JST', changes: ['トラックボールプレースホルダーを円形表示'] },
                { v: '0.5.8.0', at: '2026-06-29 11:27 JST', changes: ['Read 後にマクロキーをエディタ名で表示'] },
                { v: '0.5.7.0', at: '2026-06-29 11:21 JST', changes: ['& キーのマクロ誤判定修正'] },
                { v: '0.5.6.0', at: '2026-06-29 10:59 JST', changes: ['None キーにキーコード選択時に type を basic に変更'] },
                { v: '0.5.5.0', at: '2026-06-29 10:52 JST', changes: ['Shifted シンボル（! @ # $ 等）をキーコードに追加'] },
                { v: '0.5.4.0', at: '2026-06-29 10:27 JST', changes: ['エクスポート/インポートに amlExcluded 追加', 'インポート時のレイアウト同期'] },
                { v: '0.5.3.0', at: '2026-06-29 10:24 JST', changes: ['Macros タブで右パネル自動最大化'] },
                { v: '0.5.2.0', at: '2026-06-29 10:21 JST', changes: ['右パネル最大幅を 800px に拡大'] },
                { v: '0.5.1.0', at: '2026-06-29 10:16 JST', changes: ['マクロモード時のキーボードビュー自動縮小'] },
                { v: '0.5.0.0', at: '2026-06-29 10:04 JST', changes: ['Macros タブでレイアウト入替（マクロ中央、キーボード右）'] },
                { v: '0.4.1.0', at: '2026-06-29 09:58 JST', changes: ['リアルタイム US/JIS レイアウト切替'] },
                { v: '0.4.0.0', at: '2026-06-29 09:52 JST', changes: ['US/JIS キーボードレイアウト切替'] },
                { v: '0.3.5.0', at: '2026-06-28 17:27 JST', changes: ['ファームウェアマクロ検出のデバッグログ追加'] },
                { v: '0.3.4.0', at: '2026-06-28 17:22 JST', changes: ['Read 時にファームウェアマクロを自動検出'] },
                { v: '0.3.3.0', at: '2026-06-28 17:13 JST', changes: ['kp/mkp 衝突とマクロ behavior 名検索を修正'] },
                { v: '0.3.2.0', at: '2026-06-28 17:10 JST', changes: ['マクロデバッグ用に全 behavior 名をログ出力'] },
                { v: '0.3.0.0', at: '2026-06-28 16:46 JST', changes: ['フルマクロエディタとキーピッカーを実装'] },
                { v: '0.2.1.0', at: '2026-06-28 16:17 JST', changes: ['デプロイ検証用のバージョン更新'] },
                { v: '0.2.0.0', at: '2026-06-28 16:10 JST', changes: ['ZMK Studio プロトコル対応', 'キーマップ Read/Write', 'トラックボール設定', 'タッピングターム設定'] },
                { v: '0.1.0.0', at: '2026-06-28 09:08 JST', changes: ['初期実装', 'レイアウトエディタ', 'USB 接続', 'デバッグコンソール'] },
              ].map(({ v, at, changes }) => (
                <div key={v}>
                  <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 2 }}>v{v}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 2 }}>{at}</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {changes.map((c, i) => <li key={i} style={{ color: 'var(--text-secondary)' }}>{c}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="header-breadcrumb">
        <span className="led-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: store.selectedLayer?.ledColor || '#e5e5e5', display: 'inline-block' }} />
      </div>

      <div className="header-spacer" />

      <ConnectionPanel
        connected={usbConnected}
        connectionType={connectionType}
        onConnectionChange={onConnectionChange}
        compact
      />

      {/* USB connection status & device actions */}
      {usbConnected && (
        <>
          <button className="header-pill header-pill-live">
            <span className="header-pill-icon">⚡</span>
            USB Live
            <span className="header-pill-dot header-pill-dot-green" />
          </button>

          <button className={`header-pill ${unsaved ? 'header-pill-unsaved' : ''}`}>
            <span className="header-pill-dot" style={{ background: unsaved ? 'var(--warning)' : 'var(--success)' }} />
            {unsaved ? 'Unsaved' : 'Saved'}
          </button>

          <button className="header-action-btn" onClick={onWrite}>
            <span>↑</span> Write
          </button>
          <button className="header-action-btn" onClick={onRead}>
            <span>↓</span> Read
          </button>
          <button className="header-action-btn" onClick={onSave}>
            <span>💾</span> Save
          </button>
          {isElectron && wroteToDevice && (
            <button className="header-action-btn" title="ミニマップを表示してStudioを片付ける（接続は維持されます）"
              onClick={() => (window as any).electronAPI?.switchToMinimap?.()}>
              <span>🗺</span> ミニマップを起動
            </button>
          )}
        </>
      )}

      {!isElectron && (
        <a className="header-action-btn" href={MAC_APP_DOWNLOAD_URL} style={{ textDecoration: 'none' }}>
          <span>⬇</span> Macアプリダウンロード
        </a>
      )}

      {isElectron && editorLatestVersion && (
        <a className="header-action-btn" href={MAC_APP_DOWNLOAD_URL}
          style={{ textDecoration: 'none', borderColor: 'var(--warning)' }}
          title={`Studio v${editorLatestVersion} が公開されています。クリックしてDMGをダウンロードし、開いて上書きインストールしてください`}>
          <span>⬇</span> Studioアップデート (v{editorLatestVersion})
        </a>
      )}

      <a className="header-action-btn" href={FIRMWARE_DOWNLOAD_URL}
        style={{ textDecoration: 'none', position: 'relative', ...(fwUpdateAvailable ? { borderColor: 'var(--warning)' } : {}) }}
        title={fwUpdateAvailable
          ? '接続中のデバイスより新しいFWが公開されています。zipをダウンロードして書き込んでください'
          : '最新のFW一式（dongle/L/R/settings_reset）をzipでダウンロード'}>
        <span>⬇</span> FWダウンロード
        {fwLatestPublishedAt && (
          <span style={{ fontSize: 9, opacity: 0.75, marginLeft: 4 }}>
            最終更新 {new Date(fwLatestPublishedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {fwUpdateAvailable && (
          <span style={{
            position: 'absolute', top: -4, right: -4, width: 10, height: 10,
            borderRadius: '50%', background: 'var(--warning)',
            border: '2px solid var(--bg-primary)',
          }} />
        )}
      </a>

      <div className="btn-group">
        <button
          className={`btn ${store.osLayout === 'us' ? 'btn-active' : ''}`}
          onClick={() => { store.setOsLayout('us'); setKeyboardLayout('us'); store.relabelLayers(); }}
        >US</button>
        <button
          className={`btn ${store.osLayout === 'jis' ? 'btn-active' : ''}`}
          onClick={() => { store.setOsLayout('jis'); setKeyboardLayout('jis'); store.relabelLayers(); }}
        >JIS</button>
      </div>

      <button
        className="btn btn-icon"
        title="Toggle dark/light mode"
        onClick={() => {
          const next = theme === 'light' ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', next);
          localStorage.setItem('conductor-theme', next);
          setTheme(next);
        }}
        style={{ fontSize: 14 }}
      >{theme === 'light' ? '🌙' : '☀️'}</button>

      <div className="header-group">
        <button className="btn btn-icon" onClick={store.undo} disabled={!store.canUndo} title="Undo">↩</button>
        <button className="btn btn-icon" onClick={store.redo} disabled={!store.canRedo} title="Redo">↪</button>
      </div>

      <button
        className="btn btn-outline"
        onClick={() => {
          if (confirm('キーマップを初期値にリセットしますか？\n現在の設定は失われます。')) {
            store.reset();
          }
        }}
        title="初期値にリセット"
        style={{ fontSize: 12 }}
      >⟳ Reset</button>

      <div style={{ position: 'relative' }}>
        <button className="btn btn-primary" onClick={() => setShowExport(!showExport)}>
          📁 File
        </button>
        {showExport && (
          <div className="export-dropdown">
            <button className="export-item" onClick={handleExport}>
              <span className="export-item-title">Export .json</span>
              <span className="export-item-desc">Full project + device settings</span>
            </button>
            <button className="export-item" onClick={handleImport}>
              <span className="export-item-title">Import .json</span>
              <span className="export-item-desc">Load project and restore device settings</span>
            </button>
            {listWriteBackups().map(b => (
              <button
                key={b.at}
                className="export-item"
                onClick={() => {
                  const backup = loadWriteBackup(b.at);
                  if (!backup) return;
                  if (!confirm(`${new Date(b.at).toLocaleString('ja-JP')} のWrite前バックアップをエディタに読み込みます。\n（実機に反映するには読み込み後にWriteしてください）`)) return;
                  store.importProject(backup);
                  setShowExport(false);
                }}
              >
                <span className="export-item-title">⟲ Write前バックアップ</span>
                <span className="export-item-desc">{new Date(b.at).toLocaleString('ja-JP')} 時点の実機状態を復元</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className={`btn btn-icon ${showConsole ? 'btn-active' : ''}`}
        onClick={onToggleConsole}
        title="Toggle Debug Console"
        style={{ fontFamily: 'monospace', fontSize: 14 }}
      >&gt;_</button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </header>
  );
}

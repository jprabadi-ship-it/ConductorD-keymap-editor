const { contextBridge, ipcRenderer } = require('electron')

// Exposed to both the main editor window and the tray popup window. The
// editor window only calls sendLayerState; the popup only calls onLayerState.
contextBridge.exposeInMainWorld('electronAPI', {
  sendLayerState: (state) => ipcRenderer.send('layer-state', state),
  onLayerState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('layer-state', listener)
    return () => ipcRenderer.removeListener('layer-state', listener)
  },
  showPopupMenu: () => ipcRenderer.send('popup-context-menu'),
  checkFirmwareLatest: () => ipcRenderer.invoke('check-firmware-latest'),
  downloadFirmwareRelease: () => ipcRenderer.invoke('download-firmware-release'),
  onShowMinimap: (callback) => {
    const listener = (_event, show) => callback(show)
    ipcRenderer.on('show-minimap', listener)
    return () => ipcRenderer.removeListener('show-minimap', listener)
  },
  onSetTheme: (callback) => {
    const listener = (_event, theme) => callback(theme)
    ipcRenderer.on('set-theme', listener)
    return () => ipcRenderer.removeListener('set-theme', listener)
  },
  adjustPopupOpacity: (delta) => ipcRenderer.send('adjust-popup-opacity', delta),

  // Serial-port handoff between the Studio window and the tray popup: the
  // port is exclusive, so when Studio wants to connect it asks the popup to
  // release its own connection first, and hands it back on disconnect.
  openStudio: () => ipcRenderer.send('open-studio'),
  getPopupPrefs: () => ipcRenderer.invoke('get-popup-prefs'),
  hidePopup: () => ipcRenderer.send('hide-popup'),
  switchToMinimap: () => ipcRenderer.send('switch-to-minimap'),
  stealPort: () => ipcRenderer.invoke('steal-port'),
  studioReleasedPort: () => ipcRenderer.send('studio-released-port'),
  onReleasePort: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('release-port', listener)
    return () => ipcRenderer.removeListener('release-port', listener)
  },
  portReleased: (info) => ipcRenderer.send('port-released', info),
  onReclaimPort: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('reclaim-port', listener)
    return () => ipcRenderer.removeListener('reclaim-port', listener)
  },
  onBleScanLog: (callback) => {
    const listener = (_event, msg) => callback(msg)
    ipcRenderer.on('ble-scan-log', listener)
    return () => ipcRenderer.removeListener('ble-scan-log', listener)
  },

  // Native BLE bridge (main-process noble) -- see main.cjs. Replaces the
  // renderer's navigator.bluetooth path, which Electron currently breaks on
  // recent macOS (electron#47046).
  bleNativeConnect: () => ipcRenderer.invoke('ble-native-connect'),
  bleNativeWrite: (bytes) => ipcRenderer.invoke('ble-native-write', bytes),
  bleNativeDisconnect: () => ipcRenderer.invoke('ble-native-disconnect'),
  onBleNativeData: (callback) => {
    const listener = (_event, bytes) => callback(bytes)
    ipcRenderer.on('ble-native-data', listener)
    return () => ipcRenderer.removeListener('ble-native-data', listener)
  },
  onBleNativeDisconnected: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('ble-native-disconnected', listener)
    return () => ipcRenderer.removeListener('ble-native-disconnected', listener)
  },
})

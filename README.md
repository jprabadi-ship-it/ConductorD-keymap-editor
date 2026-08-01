# ConductorD Studio

ConductorD Studio is a browser-based keymap editor for Conductor Monokey firmware.

## Features

- Edit 14 layers and 40 physical keys.
- Read and write keymaps over USB with the Web Serial API.
- Save only modified key bindings with dirty-key tracking.
- Edit layer names and persist them with ZMK Studio RPC.
- Configure trackball CPI, scroll sensitivity, precision mode, acceleration, and AML settings.
- Read and write tapping term settings.
- Manage combos, firmware macros, US/JIS labels, and project JSON export/import.
- Use the built-in debug console for USB/RPC troubleshooting.

## Requirements

- Chrome or Edge for Web Serial API support.
- A ConductorD/Conductor Monokey firmware build with the matching Studio RPC extensions.
- USB connection to the keyboard or dongle.

## Development

```sh
npm install
npm run dev
```

The Vite dev server serves the app at:

```text
http://127.0.0.1:5173/ConductorD-keymap-editor/
```

## Build

```sh
npm run build
npm run preview
```

## Deployment

The app is configured for GitHub Pages with:

```ts
base: '/ConductorD-keymap-editor/'
```

Current deployed URL:

https://jprabadi-ship-it.github.io/ConductorD-keymap-editor/

## Notes

USB write operations require the device to be unlocked with the firmware's `studio_unlock` combo. BLE Studio is not used for the dongle route; the supported path is USB.

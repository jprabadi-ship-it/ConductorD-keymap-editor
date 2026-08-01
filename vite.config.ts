import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Electron loads the build via file://, which needs relative asset
  // paths; GitHub Pages needs the repo-name subpath.
  base: process.env.ELECTRON_BUILD ? './' : '/ConductorD-keymap-editor/',
})

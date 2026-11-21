import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { navisPlugin } from './server/vite-plugin.mjs';

export default defineConfig({
  plugins: [react(), navisPlugin()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});

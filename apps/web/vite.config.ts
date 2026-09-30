import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on the LAN so phones and tablets on the same Wi-Fi can join during development.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': api,
      '/ws': { target: api, ws: true },
    },
  },
});

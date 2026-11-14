import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The subtitle renderer (JASSUB) runs in a module worker.
  worker: { format: 'es' },
  server: {
    port: 5173,
    // ws: the watch-party sync socket (/api/party/:id/socket).
    proxy: { '/api': { target: 'http://localhost:7979', ws: true } },
  },
});

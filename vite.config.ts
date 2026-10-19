import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

// Suppress automatic location.reload() triggered when Cloud Run/Nginx idle WebSocket drops
const disableHmrClientReloadPlugin = (): Plugin => ({
  name: 'disable-hmr-client-reload',
  transform(code, id) {
    if (id.includes('vite/dist/client/client.mjs')) {
      return code.replace(/location\.reload\(\)/g, '/* [vite] HMR auto-reload suppressed in AI Studio */');
    }
  },
});

export default defineConfig(() => {
  return {
    plugins: [
      disableHmrClientReloadPlugin(),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is completely disabled in AI Studio to prevent automatic page reload when Cloud Run/Nginx WebSocket times out.
      hmr: false,
      // Disable file watching to prevent reload loops and save CPU during edits.
      watch: null,
    },
  };
});

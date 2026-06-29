import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildStamp = process.env.RENDER_GIT_COMMIT?.slice(0, 7)
  || process.env.GIT_SHA?.slice(0, 7)
  || Date.now().toString(36);

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${buildStamp}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildStamp}.js`,
        assetFileNames: `assets/[name]-[hash]-${buildStamp}[extname]`,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000'
    }
  }
});

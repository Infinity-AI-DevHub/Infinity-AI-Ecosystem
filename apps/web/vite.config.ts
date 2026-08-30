import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Deep links are served by index.html (SPA history fallback), which Vite does by
 * default for the dev server and preview.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 4600, strictPort: true },
  preview: { port: 4600, strictPort: true },
  build: { outDir: 'dist', sourcemap: true },
});

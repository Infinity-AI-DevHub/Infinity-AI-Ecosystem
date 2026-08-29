import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * The public bundle: share links, activation and password reset.
 *
 * Built separately from the desktop renderer so that a recipient of a share link
 * downloads three screens rather than the whole workspace, and so nothing authenticated
 * is ever served from the public host.
 */
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'serve-public-entry',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url && !req.url.includes('.') && !req.url.startsWith('/@')) req.url = '/public.html';
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url && !req.url.includes('.')) req.url = '/index.html';
          next();
        });
      },
    },
    {
      /**
       * The entry is called public.html in the source tree to keep it distinct from the
       * desktop renderer's index.html, but it ships as index.html - otherwise every
       * deep link needs a bespoke nginx fallback rather than the ordinary one.
       */
      name: 'emit-as-index',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const entry = bundle['public.html'];
        if (entry) {
          delete bundle['public.html'];
          entry.fileName = 'index.html';
          bundle['index.html'] = entry;
        }
      },
    },
  ],
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  /**
   * In development Vite serves the root index.html, which is the full workspace - so
   * without this the public server would quietly serve the very bundle it exists to
   * separate, and any check against it would prove nothing.
   */
  appType: 'mpa',
  build: {
    outDir: 'dist-public',
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'public.html'),
    },
  },
});

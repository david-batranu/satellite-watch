import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

/**
 * `npm run dev`         → http://localhost:5173 (desktop testing)
 * `npm run dev:https`   → https://<lan-ip>:5173 (real phone: sensors + camera
 *                          require a secure context)
 *
 * `PAGES_BASE` sets the deployment sub-path. GitHub Pages serves project sites
 * from `/<repo>/`, so the deploy script builds with `PAGES_BASE=/satellite-watch/`.
 * The service worker, manifest, icons and runtime data fetches all follow it.
 */
const rawBase = process.env.PAGES_BASE ?? '/';
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

export default defineConfig(({ mode }) => ({
  base,
  plugins: [
    react(),
    ...(mode === 'https' ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Satellite Watch — AR Sky',
        short_name: 'SkyWatch',
        description:
          'Point your phone at the sky to see satellites, planets, stars and constellations in real time.',
        theme_color: '#05070d',
        background_color: '#05070d',
        display: 'standalone',
        orientation: 'any',
        start_url: base,
        scope: base,
        categories: ['education', 'utilities', 'navigation'],
        icons: [
          { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
          {
            src: `${base}icons/maskable-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,json}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 2048,
    chunkSizeWarningLimit: 1400,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
}));

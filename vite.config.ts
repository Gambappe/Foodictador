import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';

/**
 * Vite config for the UI shell (U1).
 *
 * PostCSS is configured inline rather than in a `postcss.config.js`: the DAG's §2
 * ownership table lists no such file, and a root config nobody owns is how a build
 * acquires a file no lane will maintain. Tailwind and autoprefixer are the whole
 * pipeline, so inlining costs nothing.
 *
 * `outDir` is `dist/ui` because `npm run build` runs `tsc` first and tsc already emits
 * the Node side to `dist`; sharing the directory would have Vite empty tsc's output.
 */
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss(), autoprefixer()] } },
  build: { outDir: 'dist/ui', emptyOutDir: true },
});

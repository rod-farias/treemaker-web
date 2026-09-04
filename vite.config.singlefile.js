import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Separate config for the offline, single-file build (`npm run
// build:single`) — the normal `npm run build` (zero-config, no
// vite.config.js of its own) stays a regular multi-file production build,
// meant to be served over http(s). This one inlines every JS/CSS asset
// (and, since src/referenceFinderClient.js now imports its worker via
// Vite's own `?worker&inline`, the Web Worker too) into one self-contained
// HTML file, so it can be opened directly via file:// with no server at
// all — a plain multi-file build can't: browsers block a file://-loaded
// page's `<script type="module">` requests for its own other files as a
// cross-origin violation, even though they're right next to it on disk.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
  },
  plugins: [viteSingleFile()],
});

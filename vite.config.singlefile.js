import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// See src/vendor/pdfHtmlPluginStub.js: without this alias, jsPDF's unused
// `.html()` plugin drags html2canvas + dompurify (~800 KB combined) into
// this build specifically — vite-plugin-singlefile inlines every dynamic
// import() into the one output file, so unlike the regular multi-file
// build (where they'd sit in their own chunk and never actually get
// fetched), here they'd always ship.
const pdfHtmlPluginStub = fileURLToPath(new URL('./src/vendor/pdfHtmlPluginStub.js', import.meta.url));

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
  resolve: {
    alias: {
      html2canvas: pdfHtmlPluginStub,
      dompurify: pdfHtmlPluginStub,
    },
  },
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
  },
  plugins: [viteSingleFile()],
});

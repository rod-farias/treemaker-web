import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Otherwise-zero-config: `npm run dev`/`npm run build` need no vite.config.js
// of their own (see vite.config.singlefile.js's comment) beyond this one
// alias — see src/vendor/pdfHtmlPluginStub.js for why jsPDF's own optional
// html2canvas/dompurify dependencies are swapped out here instead of left
// to bundle for real.
const pdfHtmlPluginStub = fileURLToPath(new URL('./src/vendor/pdfHtmlPluginStub.js', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      html2canvas: pdfHtmlPluginStub,
      dompurify: pdfHtmlPluginStub,
    },
  },
});

// Stands in for the `html2canvas`/`dompurify` packages jsPDF only needs for
// its `.html()` plugin (rendering a live DOM element into a PDF) — a
// feature this app's PDF export never uses (see exportSelectedViewsAsPdf()
// in src/main.js, which only calls addImage()/addPage()/output() on plain
// PNG snapshots). Both packages are declared as jsPDF's own
// optionalDependencies and pulled into the bundle through a dynamic
// `import("html2canvas")`/`import("dompurify")` inside jspdf.es.min.js;
// aliased here (see vite.config.js/vite.config.singlefile.js) so neither's
// real, multi-hundred-KB implementation ships in the build — harmless
// since the aliased-in code path is never reached without calling
// `.html()`, and cuts dist-single's output by roughly 800 KB.
export default {};

#!/usr/bin/env node
// Removes every `<!-- ... -->` block from a built index.html — run as a
// post-build step (see package.json's "build"/"build:single" scripts), not
// against the source index.html in the repo root. The source file is full
// of doc comments aimed at future developers (this is a large, actively
// documented codebase); those have no reason to ship in the built output
// a user's browser actually downloads. Vite's own build doesn't strip HTML
// comments — only JS/CSS get minified — so this fills that gap.
//
// A plain global regex is safe here: this file has no conditional comments
// (`<!--[if ...]>`, IE-only, irrelevant to a modern app) worth preserving,
// and every embedded data: URI (icons, the About modal's inline SVG) is
// base64 — a charset that cannot contain the literal "-->" sequence — so
// nothing but real comments ever matches.
import fs from 'fs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/strip-html-comments.js <path-to-index.html>');
  process.exit(1);
}

const original = fs.readFileSync(filePath, 'utf8');
const stripped = original.replace(/<!--[\s\S]*?-->/g, '');
fs.writeFileSync(filePath, stripped);

const removed = (original.match(/<!--/g) || []).length;
console.log(`strip-html-comments: removed ${removed} comment block(s) from ${filePath} (${original.length} -> ${stripped.length} bytes)`);

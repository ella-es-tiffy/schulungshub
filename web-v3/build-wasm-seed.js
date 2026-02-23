#!/usr/bin/env node
/**
 * build-wasm-seed.js – Embeds sql-wasm.wasm as base64 in a <script>-loadable JS file.
 * This allows sql.js to initialize on file:// protocol (no fetch needed).
 * Run: node build-wasm-seed.js
 */

const fs = require("fs");
const path = require("path");

const wasmPath = path.join(__dirname, "vendor", "sql-wasm.wasm");
if (!fs.existsSync(wasmPath)) {
  console.error("vendor/sql-wasm.wasm not found.");
  process.exit(1);
}

const wasm = fs.readFileSync(wasmPath);
const b64 = wasm.toString("base64");

const outPath = path.join(__dirname, "wasm-seed.js");
fs.writeFileSync(outPath, `// Auto-generated – sql-wasm.wasm as base64\n// Run: node build-wasm-seed.js\nwindow.__WASM_SEED="${b64}";\n`);

const kb = (b64.length / 1024).toFixed(1);
console.log(`✓ wasm-seed.js generated (${kb} KB)`);

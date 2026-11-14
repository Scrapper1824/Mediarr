// Writes .br and .gz copies of the built files, so the server can send them compressed without
// compressing on every request (it picks the copy the browser accepts).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = path.resolve(import.meta.dirname, '../dist');
const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|wasm|txt)$/i;
let before = 0;
let after = 0;

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else yield p;
  }
}

for (const file of files(dist)) {
  if (!COMPRESSIBLE.test(file)) continue;
  const data = fs.readFileSync(file);
  if (data.length < 1024) continue;
  // Best compression for the scripts and styles; a bit less for the multi-megabyte subtitle engine, to keep builds quick.
  const quality = data.length > 1_000_000 ? 9 : 11;
  const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  const gz = zlib.gzipSync(data, { level: 9 });
  fs.writeFileSync(`${file}.br`, br);
  fs.writeFileSync(`${file}.gz`, gz);
  before += data.length;
  after += br.length;
}
console.log(`precompressed: ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB (brotli)`);

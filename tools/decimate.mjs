#!/usr/bin/env node
// Make a small preview of a huge PLY: node tools/decimate.mjs input.ply output.ply [maxPoints=2000000]
// Streams the input (any size), keeps every Nth point, writes a binary little-endian point cloud
// (float32 xyz relative to the first point, plus uchar rgb when the input has colour).
import fs from 'node:fs';
import { loadPly } from '../site/ply-parser.js';

const [input, output, max = '2000000'] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/decimate.mjs input.ply output.ply [maxPoints=2000000]');
  process.exit(1);
}

const fd = fs.openSync(input, 'r');
const source = {
  size: fs.fstatSync(fd).size,
  read: async (a, b) => {
    const buf = Buffer.alloc(b - a);
    const n = fs.readSync(fd, buf, 0, b - a, a);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + n);
  },
};

const res = await loadPly(source, { budget: +max, meshVertexLimit: 0, meshFaceLimit: 0 }, (f, msg) => {
  process.stderr.write(`\r${msg} ${(f * 100).toFixed(0)}%   `);
});
process.stderr.write('\n');

const n = res.shownVertices;
const header = [
  'ply', 'format binary_little_endian 1.0',
  `comment decimated from ${input.split('/').pop()}: every ${res.step}th of ${res.totalVertices} points`,
  `comment origin ${res.origin.join(' ')}`,
  `element vertex ${n}`, 'property float x', 'property float y', 'property float z',
  ...(res.colors ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
  'end_header', '',
].join('\n');
const stride = res.colors ? 15 : 12;
const body = Buffer.alloc(n * stride);
for (let i = 0; i < n; i++) {
  const o = i * stride;
  for (let k = 0; k < 3; k++) body.writeFloatLE(res.positions[i * 3 + k], o + k * 4);
  if (res.colors) for (let k = 0; k < 3; k++) body[o + 12 + k] = res.colors[i * 3 + k];
}
fs.writeFileSync(output, Buffer.concat([Buffer.from(header, 'latin1'), body]));
console.log(`wrote ${output}: ${n} points, ${(fs.statSync(output).size / 1e6).toFixed(1)} MB`);

// Streaming PLY loader. Works on any "source" ({ size, read(start, end) -> ArrayBuffer }),
// so a multi-GB file is read in small chunks and never held in memory as a whole.
// Large point clouds are subsampled to a point budget while reading.

const TYPES = {
  char: ['Int8', 1], int8: ['Int8', 1],
  uchar: ['Uint8', 1], uint8: ['Uint8', 1],
  short: ['Int16', 2], int16: ['Int16', 2],
  ushort: ['Uint16', 2], uint16: ['Uint16', 2],
  int: ['Int32', 4], int32: ['Int32', 4],
  uint: ['Uint32', 4], uint32: ['Uint32', 4],
  float: ['Float32', 4], float32: ['Float32', 4],
  double: ['Float64', 8], float64: ['Float64', 8],
};

const CHUNK = 32 * 1024 * 1024;
const SH_C0 = 0.28209479177387814; // Gaussian-splat DC spherical harmonic -> colour

export async function parseHeader(source) {
  const max = Math.min(source.size, 4 * 1024 * 1024);
  let len = Math.min(max, 64 * 1024);
  for (;;) {
    const bytes = new Uint8Array(await source.read(0, len));
    const text = new TextDecoder('latin1').decode(bytes);
    const end = text.indexOf('end_header');
    if (end >= 0) {
      let dataStart = end + 'end_header'.length;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;
      return { ...parseHeaderText(text.slice(0, end)), dataStart };
    }
    if (len >= max) throw new Error('Not a valid PLY file (no end_header)');
    len = Math.min(max, len * 4);
  }
}

function parseHeaderText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== 'ply') throw new Error('Not a PLY file (missing "ply" magic)');
  let format = null;
  const elements = [];
  for (const line of lines.slice(1)) {
    const t = line.split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: parseInt(t[2], 10), props: [] });
    else if (t[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new Error('Malformed PLY header');
      if (t[1] === 'list') el.props.push({ list: true, countType: t[2], itemType: t[3], name: t[4] });
      else el.props.push({ list: false, type: t[1], name: t[2] });
    }
  }
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) {
    throw new Error('Unsupported PLY format: ' + format);
  }
  for (const el of elements) {
    for (const p of el.props) {
      for (const ty of p.list ? [p.countType, p.itemType] : [p.type]) {
        if (!TYPES[ty]) throw new Error('Unsupported PLY type: ' + ty);
      }
    }
    if (el.props.every((p) => !p.list)) {
      let off = 0;
      for (const p of el.props) { p.offset = off; off += TYPES[p.type][1]; }
      el.stride = off;
    } else el.stride = null;
  }
  return { format, elements };
}

// Describe how to turn one vertex record into x/y/z and an RGB colour.
function vertexLayout(el) {
  const idx = (n) => el.props.findIndex((p) => !p.list && p.name === n);
  const first = (names) => names.map(idx).find((i) => i >= 0) ?? -1;
  const x = idx('x'), y = idx('y'), z = idx('z');
  if (x < 0 || y < 0 || z < 0) throw new Error('PLY has no x/y/z vertex properties');
  const rgb = [
    first(['red', 'r', 'diffuse_red']),
    first(['green', 'g', 'diffuse_green']),
    first(['blue', 'b', 'diffuse_blue']),
  ];
  const sh = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(idx);
  let color = null;
  if (rgb.every((i) => i >= 0)) color = { kind: 'rgb', idx: rgb };
  else if (sh.every((i) => i >= 0)) color = { kind: 'sh', idx: sh };
  return { pos: [x, y, z], color };
}

function makeGetter(prop) {
  const [name, size] = TYPES[prop.type];
  return { method: 'get' + name, size, offset: prop.offset, type: prop.type };
}

function toByte(v, type) {
  if (type === 'float' || type === 'float32' || type === 'double' || type === 'float64') {
    return v <= 1.0001 ? v * 255 : v; // 0..1 floats, or already 0..255
  }
  if (type === 'ushort' || type === 'uint16') return v >> 8;
  return v;
}

export async function loadPly(source, opts, onProgress = () => {}) {
  const budget = opts.budget;
  const header = await parseHeader(source);
  const vel = header.elements.find((e) => e.name === 'vertex');
  if (!vel || !vel.count) throw new Error('PLY has no vertices');
  const fel = header.elements.find((e) => e.name === 'face');
  const wantMesh = !!(fel && fel.count > 0 &&
    vel.count <= opts.meshVertexLimit && fel.count <= opts.meshFaceLimit);
  const step = wantMesh ? 1 : Math.max(1, Math.ceil(vel.count / budget));
  const outCount = Math.ceil(vel.count / step);

  const layout = vertexLayout(vel);
  const positions = new Float32Array(outCount * 3);
  const colors = layout.color ? new Uint8Array(outCount * 3) : null;
  const state = { n: 0, origin: null, indices: null, nIndices: 0 };
  const ctx = { chunk: opts.chunk || CHUNK, header, vel, fel, wantMesh, step, layout, positions, colors, state, source, onProgress };

  if (header.format === 'ascii') await readAscii(ctx);
  else await readBinary(ctx);

  const n = state.n;
  const out = {
    positions: n === outCount ? positions : positions.slice(0, n * 3),
    colors: colors && (n === outCount ? colors : colors.slice(0, n * 3)),
    indices: state.indices && state.indices.slice(0, state.nIndices),
    origin: state.origin || [0, 0, 0],
    totalVertices: vel.count,
    shownVertices: n,
    step,
    hasColor: !!layout.color,
    format: header.format,
  };
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < out.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = out.positions[i + k];
      if (v < bb.min[k]) bb.min[k] = v;
      if (v > bb.max[k]) bb.max[k] = v;
    }
  }
  out.bbox = bb;
  return out;
}

function pushVertex(ctx, vals) {
  const { positions, colors, state, layout } = ctx;
  const [x, y, z] = vals.pos;
  if (!state.origin) state.origin = [x, y, z];
  const o = state.n * 3;
  positions[o] = x - state.origin[0];
  positions[o + 1] = y - state.origin[1];
  positions[o + 2] = z - state.origin[2];
  if (colors && vals.rgb) {
    for (let k = 0; k < 3; k++) {
      const c = vals.rgb[k];
      colors[o + k] = c < 0 ? 0 : c > 255 ? 255 : c;
    }
  }
  state.n++;
}

function pushTriangleFan(ctx, ids, count) {
  const { state, fel } = ctx;
  const need = state.nIndices + (count - 2) * 3;
  if (!state.indices) state.indices = new Uint32Array(fel.count * 3);
  if (need > state.indices.length) {
    const bigger = new Uint32Array(Math.max(need, state.indices.length * 2));
    bigger.set(state.indices);
    state.indices = bigger;
  }
  for (let k = 1; k < count - 1; k++) {
    state.indices[state.nIndices++] = ids[0];
    state.indices[state.nIndices++] = ids[k];
    state.indices[state.nIndices++] = ids[k + 1];
  }
}

// ---------- binary ----------

async function readBinary(ctx) {
  const { header, vel, fel, wantMesh, source, onProgress } = ctx;
  const little = header.format === 'binary_little_endian';
  let offset = header.dataStart;
  let seenVertex = false, doneFaces = !wantMesh;
  for (const el of header.elements) {
    if (el === vel) {
      await readBinaryVertices(ctx, offset, little);
      offset += vel.count * vel.stride;
      seenVertex = true;
    } else if (el === fel && wantMesh && seenVertex) {
      await readBinaryFaces(ctx, offset, little);
      doneFaces = true;
    } else if (el.stride != null) {
      offset += el.count * el.stride;
    } else if (seenVertex) {
      break; // variable-length element we do not need; faces (if any) are unreachable
    } else {
      throw new Error('Unsupported PLY layout: variable-size element before vertices');
    }
    if (seenVertex && doneFaces) break;
  }
  onProgress(1, 'Done');
}

async function readBinaryVertices(ctx, offset, little) {
  const { vel, step, layout, source, onProgress } = ctx;
  const stride = vel.stride;
  const gp = layout.pos.map((i) => makeGetter(vel.props[i]));
  const gc = layout.color && layout.color.idx.map((i) => makeGetter(vel.props[i]));
  const sh = layout.color && layout.color.kind === 'sh';
  const perChunk = Math.max(1, Math.floor(ctx.chunk / stride));
  for (let i = 0; i < vel.count; i += perChunk) {
    const n = Math.min(perChunk, vel.count - i);
    const buf = await source.read(offset + i * stride, offset + (i + n) * stride);
    const dv = new DataView(buf);
    for (let j = (step - (i % step)) % step; j < n; j += step) {
      const base = j * stride;
      const vals = {
        pos: [
          dv[gp[0].method](base + gp[0].offset, little),
          dv[gp[1].method](base + gp[1].offset, little),
          dv[gp[2].method](base + gp[2].offset, little),
        ],
        rgb: null,
      };
      if (gc) {
        const c = gc.map((g) => dv[g.method](base + g.offset, little));
        vals.rgb = sh
          ? c.map((v) => (0.5 + SH_C0 * v) * 255)
          : c.map((v, k) => toByte(v, gc[k].type));
      }
      pushVertex(ctx, vals);
    }
    onProgress(Math.min(0.95, (i + n) / vel.count * (ctx.wantMesh ? 0.6 : 1)), 'Reading points');
  }
}

async function readBinaryFaces(ctx, offset, little) {
  const { fel, source, onProgress, vel } = ctx;
  const end = source.size;
  // plan how to walk one face record
  const props = fel.props.map((p) => ({ ...p, isIndex: false }));
  const idxProp = props.find((p) => p.list && /vertex_ind/.test(p.name)) || props.find((p) => p.list);
  if (idxProp) idxProp.isIndex = true;
  const ids = [];
  let faces = 0;
  let pos = offset;
  while (faces < fel.count && pos < end) {
    const buf = await source.read(pos, Math.min(end, pos + ctx.chunk));
    const dv = new DataView(buf);
    const len = buf.byteLength;
    let p = 0;
    const atEof = pos + len >= end;
    while (faces < fel.count) {
      let q = p, ok = true;
      ids.length = 0;
      let nIds = 0;
      for (const pr of props) {
        if (pr.list) {
          const [cm, cs] = TYPES[pr.countType];
          const [im, is] = TYPES[pr.itemType];
          if (q + cs > len) { ok = false; break; }
          const cnt = dv['get' + cm](q, little);
          q += cs;
          if (q + cnt * is > len) { ok = false; break; }
          if (pr.isIndex) {
            for (let k = 0; k < cnt; k++) ids[k] = dv['get' + im](q + k * is, little);
            nIds = cnt;
          }
          q += cnt * is;
        } else {
          const sz = TYPES[pr.type][1];
          if (q + sz > len) { ok = false; break; }
          q += sz;
        }
      }
      if (!ok) break;
      p = q;
      faces++;
      if (nIds >= 3) pushTriangleFan(ctx, ids, nIds);
    }
    if (p === 0 && atEof) break; // truncated file
    pos += p;
    onProgress(0.6 + 0.4 * (faces / fel.count), 'Reading faces');
  }
}

// ---------- ascii ----------

async function readAscii(ctx) {
  const { header, vel, fel, wantMesh, source, step, layout, onProgress } = ctx;
  const dec = new TextDecoder();
  const toks = (s) => s.split(/\s+/);
  const pidx = (el, name) => el.props.findIndex((p) => p.name === name);
  const gp = layout.pos;
  const gc = layout.color && layout.color.idx;
  const sh = layout.color && layout.color.kind === 'sh';
  const cType = gc && gc.map((i) => vel.props[i].type);
  const faceIdxProp = fel && fel.props.findIndex((p) => p.list && /vertex_ind/.test(p.name));

  let elIdx = 0, recLeft = header.elements[0].count, recNo = 0;
  let carry = '';
  let pos = header.dataStart;
  const size = source.size;

  const handle = (line) => {
    while (elIdx < header.elements.length && recLeft === 0) {
      elIdx++;
      recNo = 0;
      if (elIdx < header.elements.length) recLeft = header.elements[elIdx].count;
    }
    if (elIdx >= header.elements.length) return;
    const el = header.elements[elIdx];
    recLeft--;
    const i = recNo++;
    if (el === vel) {
      if (i % step !== 0) return;
      const t = toks(line);
      const vals = { pos: [+t[gp[0]], +t[gp[1]], +t[gp[2]]], rgb: null };
      if (gc) {
        vals.rgb = sh
          ? gc.map((c) => (0.5 + SH_C0 * +t[c]) * 255)
          : gc.map((c, k) => toByte(+t[c], cType[k]));
      }
      pushVertex(ctx, vals);
    } else if (el === fel && wantMesh) {
      const t = toks(line);
      let q = 0, ids = null, cnt = 0;
      for (let k = 0; k < el.props.length; k++) {
        const pr = el.props[k];
        if (pr.list) {
          const c = +t[q++];
          if (k === faceIdxProp) { ids = t.slice(q, q + c).map(Number); cnt = c; }
          q += c;
        } else q++;
      }
      if (ids && cnt >= 3) pushTriangleFan(ctx, ids, cnt);
    }
  };

  while (pos < size) {
    const buf = await source.read(pos, Math.min(size, pos + ctx.chunk / 2));
    pos += buf.byteLength;
    const text = carry + dec.decode(buf, { stream: pos < size });
    const lines = text.split('\n');
    carry = lines.pop();
    for (const l of lines) {
      const s = l.trim();
      if (s) handle(s);
    }
    onProgress(Math.min(0.99, pos / size), 'Reading (ascii)');
  }
  if (carry.trim()) handle(carry.trim());
  onProgress(1, 'Done');
}

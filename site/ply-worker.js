import { loadPly } from './ply-parser.js';

// A "source" reads byte ranges from either a local File or a remote URL (HTTP Range).
function fileSource(file) {
  return { size: file.size, read: (a, b) => file.slice(a, b).arrayBuffer() };
}

async function urlSource(url) {
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (!head.ok) throw new Error('Could not fetch file: HTTP ' + head.status);
  if (head.status !== 206) {
    // No Range support: fall back to downloading the whole file (only sensible for small files).
    const len = +head.headers.get('Content-Length') || 0;
    if (len > 400e6) throw new Error('Server does not support Range requests; file too large to download whole');
    const whole = await (await fetch(url)).arrayBuffer();
    return { size: whole.byteLength, read: async (a, b) => whole.slice(a, b) };
  }
  const m = /\/(\d+)$/.exec(head.headers.get('Content-Range') || '');
  const size = m ? +m[1] : 0;
  if (!size) throw new Error('Server did not report the file size (needs CORS with Content-Range exposed)');
  return {
    size,
    async read(a, b) {
      const r = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
      if (r.status !== 206) throw new Error('Range request failed: ' + r.status);
      return r.arrayBuffer();
    },
  };
}

self.onmessage = async (e) => {
  const { file, url, opts } = e.data;
  try {
    const source = file ? fileSource(file) : await urlSource(url);
    const res = await loadPly(source, opts, (f, msg) => self.postMessage({ type: 'progress', f, msg }));
    const transfer = [res.positions.buffer];
    if (res.colors) transfer.push(res.colors.buffer);
    if (res.indices) transfer.push(res.indices.buffer);
    self.postMessage({ type: 'done', res, fileSize: source.size }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

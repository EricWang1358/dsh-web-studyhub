import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { zipStored } from './zip.mjs';

/* A local PEP 503 index for the uv wheel, for the one-click MinerU install tests (no network). It serves /simple/uv/ with one wheel per platform tag
   (href relative, with #sha256=), and the wheels themselves with HTTP Range support. Knobs (set(...)): `status` (an error status for every request),
   `cutAfter` (the next wheel download stops after this many bytes, once), `wrongSha` (the page gives a wrong sha256), `noSha` (no fragment), `missing`
   (the page lists no wheels), `noRange` (ignore Range: answer 200 with the whole file). `requests` lists what was asked. */

export const UV_TEST_VERSION = '0.13.1';
const TAGS = ['win_amd64', 'win_arm64', 'win32', 'macosx_11_0_arm64', 'macosx_10_12_x86_64', 'manylinux_2_17_x86_64.manylinux2014_x86_64', 'manylinux_2_17_aarch64.manylinux2014_aarch64'];

export function uvWheel(tag, version = UV_TEST_VERSION, size = 200_000) {
  const name = tag.startsWith('win') ? 'uv.exe' : 'uv';
  const program = Buffer.alloc(size, 0x61);
  program.write(`fake uv ${version} ${tag}\n`, 0);
  return zipStored({ [`uv-${version}.data/scripts/${name}`]: program, [`uv-${version}.data/scripts/${tag.startsWith('win') ? 'uvx.exe' : 'uvx'}`]: 'fake uvx',
    [`uv-${version}.dist-info/METADATA`]: `Metadata-Version: 2.1\nName: uv\nVersion: ${version}\n` });
}

export async function startFakeIndex({ version = UV_TEST_VERSION } = {}) {
  const wheels = new Map(TAGS.map(tag => { const bytes = uvWheel(tag, version); return [`uv-${version}-py3-none-${tag}.whl`, { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }]; }));
  const knobs = {}, requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, range: req.headers.range || '' });
    if (knobs.status) { res.writeHead(knobs.status).end('no'); return; }
    if (req.url.startsWith('/simple/uv')) {
      const links = knobs.missing ? [] : [...wheels].map(([name, wheel]) => {
        const fragment = knobs.noSha ? '' : `#sha256=${knobs.wrongSha ? '0'.repeat(64) : wheel.sha256}`;
        return `<a href="../../packages/ab/cd/${name}${fragment}" data-requires-python="&gt;=3.8">${name}</a><br/>`;
      });
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!DOCTYPE html><html><body><h1>Links for uv</h1>${links.join('\n')}</body></html>`);
      return;
    }
    const name = decodeURIComponent(req.url.split('/').pop());
    const wheel = wheels.get(name);
    if (!wheel) { res.writeHead(404).end('missing'); return; }
    let start = 0;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (range && !knobs.noRange) {
      start = Number(range[1]);
      if (start >= wheel.bytes.length) { res.writeHead(416, { 'content-range': `bytes */${wheel.bytes.length}` }).end(); return; }
      res.writeHead(206, { 'content-length': wheel.bytes.length - start, 'content-range': `bytes ${start}-${wheel.bytes.length - 1}/${wheel.bytes.length}` });
    } else res.writeHead(200, { 'content-length': wheel.bytes.length });
    const body = wheel.bytes.subarray(start);
    if (knobs.cutAfter) {
      const cut = knobs.cutAfter; delete knobs.cutAfter;
      res.write(body.subarray(0, cut), () => setTimeout(() => res.destroy(), 20));
      return;
    }
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, indexUrl: `${base}/simple/uv/`, packageIndex: `${base}/simple`, wheels, requests, set: patch => Object.assign(knobs, patch), reset: () => { for (const key of Object.keys(knobs)) delete knobs[key]; },
    sources: { mainland: { uvIndex: `${base}/simple/uv/`, packageIndex: `${base}/simple` }, global: { uvIndex: `${base}/simple/uv/`, packageIndex: `${base}/simple` } },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

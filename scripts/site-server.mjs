// Loopback-only preview of the built bilingual site. It never opens a study library.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSite, SITE_OUTPUT } from './site-build.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' };
export async function createSiteServer({ root = SITE_OUTPUT, port = 0 } = {}) {
  const directory = resolve(root);
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = decodeURIComponent(url.pathname), target = resolve(directory, '.' + (route === '/' ? '/index.html' : route));
      if (!target.startsWith(directory + sep)) { res.writeHead(403).end('forbidden'); return; }
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 400, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(); }); });
  return { url: `http://127.0.0.1:${server.address().port}`, root: directory,
    close: () => new Promise(done => { server.close(done); server.closeAllConnections(); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSite();
  const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) || process.env.PORT || 4321);
  const preview = await createSiteServer({ port });
  console.log(`StudyHub site: ${preview.url} (Chinese), ${preview.url}/en.html (English)`);
  process.once('SIGINT', () => preview.close());
  process.once('SIGTERM', () => preview.close());
}

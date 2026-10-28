/* Serves the --test panel build over plain HTTP for a real-browser check, with the real MCP server behind it.
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT); here every request goes through host/entry.mjs over stdio, the
   way ZCode reaches it, instead of calling the host in-process.
     GET  /                 panel.test.html (the shell whose loader is ui-port/test-app-stub.mjs)
     GET  /ui/<file>        that ui://studyhub/<file> resource, read from the MCP server
     POST /api/tool         {name, arguments} -> the MCP server's tools/call answer
   node packages/studyhub-zcode/scripts/test-panel-server.mjs --library=<folder> [--home=<folder>] [--port=8765]
   Nothing here touches a real library unless --library names one; the home defaults to a folder next to the library. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = fileURLToPath(new URL('../', import.meta.url));
const MAX_BODY = 64 * 1024 * 1024;

/** Start the server; answers { url, port, client, close() }. `env` is the MCP server's whole environment (scrub keys first). */
export async function createTestPanelServer({ libraryRoot, home, uiDir = join(here, 'dist', 'ui'), port = 0, env = process.env } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'host', 'entry.mjs')], stderr: 'inherit',
    env: { ...env, STUDYHUB_LIBRARY: resolve(libraryRoot), DSH_HOME: resolve(home || `${libraryRoot}-home`), STUDYHUB_ZCODE_UI_DIR: uiDir } });
  const client = new Client({ name: 'studyhub-test-panel', version: '0.0.0' });
  await client.connect(transport);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/api/tool') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > MAX_BODY) throw new Error('Request too large'); }
        const { name, arguments: args } = JSON.parse(body || '{}');
        const answer = await client.callTool({ name, arguments: args ?? {} });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
        return;
      }
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/' || url.pathname === '/panel.test.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(await readFile(join(uiDir, 'panel.test.html'), 'utf8'));
        return;
      }
      if (url.pathname.startsWith('/ui/')) {
        const uri = `ui://studyhub/${decodeURIComponent(url.pathname.slice(4))}`;
        const content = (await client.readResource({ uri })).contents[0];
        response.writeHead(200, { 'content-type': `${content.mimeType}; charset=utf-8` }).end(content.text);
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error?.message || error));
    }
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  const actual = server.address().port;
  return { url: `http://127.0.0.1:${actual}/`, port: actual, client,
    close: async () => { await new Promise((done) => server.close(done)); server.closeAllConnections?.(); await client.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const libraryRoot = option('library');
  if (!libraryRoot) { console.error('Usage: test-panel-server.mjs --library=<folder> [--home=<folder>] [--port=8765]'); process.exit(2); }
  const running = await createTestPanelServer({ libraryRoot, home: option('home'), port: Number(option('port') || 8765) });
  console.log(`test panel: ${running.url}`);
}

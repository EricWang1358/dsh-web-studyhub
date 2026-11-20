import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { MAX_REQUEST_BYTES } from '../../../../lib/documents.js';

export const MAX_RESTORE_REQUEST_BYTES = 64 * 1024 * 1024;

const TAURI_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
});

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function tokensMatch(expectedDigest, candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  return timingSafeEqual(expectedDigest, sha256(candidate));
}

function isAllowedHost(hostHeader, boundPort) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const lower = hostHeader.trim().toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  ]);
  return allowed.has(lower);
}

function isAllowedOrigin(originHeader, boundPort) {
  if (!originHeader) return true;
  if (typeof originHeader !== 'string') return false;
  const origin = originHeader.trim();
  if (TAURI_ORIGINS.has(origin)) return true;
  return origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;
}

function applyCorsHeaders(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Study-Token');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, status, payload, origin = '') {
  applyCorsHeaders(res, origin);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBoundedBody(req, hardLimit) {
  return new Promise((resolveBody, rejectBody) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > hardLimit) {
      rejectBody(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > hardLimit) {
        done = true;
        rejectBody(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolveBody({ raw: Buffer.concat(chunks).toString('utf8'), bytes: total });
      }
    });
    req.on('error', (error) => {
      if (!done) {
        done = true;
        rejectBody(error);
      }
    });
  });
}

async function serveStaticFile({ res, pathname, uiRoot, token, injectDevToken }) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(safePath);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Bad path' });
    return;
  }
  const resolved = resolve(uiRoot, `.${decoded}`);
  const rootPrefix = uiRoot.endsWith(sep) ? uiRoot : `${uiRoot}${sep}`;
  if (resolved !== uiRoot && !resolved.startsWith(rootPrefix)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    const ext = extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    if (ext === '.html' && injectDevToken) {
      const html = await readFile(resolved, 'utf8');
      const script = `<script>window.STUDY_TOKEN=${JSON.stringify(token)};</script>`;
      const injected = html.includes('</head>') ? html.replace('</head>', `  ${script}\n</head>`) : `${script}\n${html}`;
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(injected);
      return;
    }
    const data = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendJson(res, 404, { ok: false, error: 'Not found' });
  }
}

function validateApiPayload(payload, bytes, maxRequestBytes) {
  if (bytes > maxRequestBytes && payload?.action !== 'restore') {
    return { ok: false, status: 413, error: 'Request body too large', code: 'payload-too-large' };
  }
  const validAction = payload && typeof payload === 'object' && typeof payload.action === 'string' && payload.action;
  if (!validAction) {
    return { ok: false, status: 400, error: 'Missing action', code: 'invalid-request' };
  }
  const args = payload.args && typeof payload.args === 'object' ? payload.args : {};
  return { ok: true, action: payload.action, args };
}

async function parseApiRequestBody(req, { maxRequestBytes, maxRestoreBytes }) {
  let bodyInfo;
  try {
    bodyInfo = await readBoundedBody(req, maxRestoreBytes);
  } catch (error) {
    const tooLarge = error?.statusCode === 413;
    return {
      ok: false,
      status: tooLarge ? 413 : 400,
      error: error?.message || 'Invalid body',
      code: tooLarge ? 'payload-too-large' : 'bad-request',
    };
  }
  let payload;
  try {
    payload = JSON.parse(bodyInfo.raw);
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON', code: 'invalid-json' };
  }
  return validateApiPayload(payload, bodyInfo.bytes, maxRequestBytes);
}

async function handleApiCall({ req, res, origin, expectedDigest, onCall, maxRequestBytes, maxRestoreBytes }) {
  if (!tokensMatch(expectedDigest, req.headers['x-study-token'])) {
    sendJson(res, 403, { ok: false, error: 'Forbidden', code: 'forbidden' }, origin);
    return;
  }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 415, { ok: false, error: 'Expected application/json', code: 'unsupported-media-type' }, origin);
    return;
  }
  const parsed = await parseApiRequestBody(req, { maxRequestBytes, maxRestoreBytes });
  if (!parsed.ok) {
    sendJson(res, parsed.status, { ok: false, error: parsed.error, code: parsed.code }, origin);
    return;
  }
  const result = await onCall(parsed.action, parsed.args);
  sendJson(res, 200, result, origin);
}

function validateHostAndOrigin(req, res, boundPort) {
  if (!isAllowedHost(req.headers.host, boundPort)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden host', code: 'forbidden-host' });
    return null;
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!isAllowedOrigin(origin, boundPort)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden origin', code: 'forbidden-origin' });
    return null;
  }
  return origin;
}

async function routeIncomingRequest({ req, res, boundPort, expectedDigest, onCall, uiRoot, token, injectDevToken, maxRequestBytes, maxRestoreBytes }) {
  const origin = validateHostAndOrigin(req, res, boundPort);
  if (origin === null) return;

  const url = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
  if (req.method === 'OPTIONS' && url.pathname === '/api/call') {
    applyCorsHeaders(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true }, origin);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/call') {
    await handleApiCall({ req, res, origin, expectedDigest, onCall, maxRequestBytes, maxRestoreBytes });
    return;
  }
  if (req.method === 'GET' && uiRoot) {
    await serveStaticFile({ res, pathname: url.pathname, uiRoot, token, injectDevToken });
    return;
  }
  sendJson(res, 404, { ok: false, error: 'Not found', code: 'not-found' }, origin);
}

/**
 * Start a loopback-only HTTP RPC server (`127.0.0.1:0` by default) with strict Host,
 * Origin, constant-time `X-Study-Token`, and body-size enforcement.
 */
export async function startLocalServer({
  token,
  onCall,
  port = 0,
  serveUiDir = '',
  injectDevToken = false,
  maxRequestBytes = MAX_REQUEST_BYTES,
  maxRestoreBytes = MAX_RESTORE_REQUEST_BYTES,
}) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('Local server requires a strong token');
  }
  const expectedDigest = sha256(token);
  const uiRoot = serveUiDir ? resolve(serveUiDir) : '';
  let boundPort = port;

  const server = createServer((req, res) => {
    void routeIncomingRequest({
      req, res, boundPort, expectedDigest, onCall, uiRoot, token, injectDevToken, maxRequestBytes, maxRestoreBytes,
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal server error', code: 'internal-error' });
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  boundPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

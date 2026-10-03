/* Preloaded by the test worker, never through NODE_OPTIONS into CLI fixtures. */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';

let attempts = 0;
const loopback = host => {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return value === 'localhost' || value === '::1' || /^127\.\d+\.\d+\.\d+$/.test(value) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(value);
};
const localPath = path => typeof path === 'string' && path.length > 0 &&
  (!path.startsWith('\\\\') || path.startsWith('\\\\.\\pipe\\') || path.startsWith('\\\\?\\pipe\\'));
function localConnection(args, channel) {
  const input = args[0];
  if (Array.isArray(input)) return localConnection(input, channel);
  const socket = ['net', 'tls', 'Socket'].includes(channel);
  if (socket && typeof input === 'string') return localPath(input);
  if (socket && input?.path) return localPath(input.path);
  if (input?.socketPath) return localPath(input.socketPath);
  if (typeof input === 'number') return loopback(typeof args[1] === 'string' ? args[1] : 'localhost');
  try { return loopback(new URL(typeof input === 'string' ? input : input?.url || input?.href).hostname); }
  catch {
    if (!input || typeof input !== 'object') return false;
    const host = input.hostname || input.host || input.socket?.remoteAddress || 'localhost';
    try { return loopback(new URL(`http://${host}`).hostname); } catch { return loopback(host); }
  }
}
function deny() {
  attempts++;
  throw Object.assign(new Error('Tests allow only loopback network connections'), { code: 'TEST_NETWORK_BLOCKED' });
}
const fetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  if (!localConnection(args, 'fetch')) deny();
  return fetch(...args);
};
for (const [module, methods, channel] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'],
  [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [net.Socket.prototype, ['connect'], 'Socket']]) {
  for (const method of methods) {
    const original = module[method];
    module[method] = function (...args) {
      if (!localConnection(args, channel)) deny();
      return original.apply(this, args);
    };
  }
}
syncBuiltinESMExports();
if (process.env.STUDY_TEST_NETWORK_REPORT === '1' && process.env.STUDY_TEST_NETWORK_REPORT_FILE) {
  process.once('exit', () => {
    try { appendFileSync(process.env.STUDY_TEST_NETWORK_REPORT_FILE, JSON.stringify({ attempts }) + '\n'); }
    catch { /* diagnostics must not change a test's exit status */ }
  });
}

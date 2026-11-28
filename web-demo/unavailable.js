if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production', DSH_HOME: '/demo' }, pid: 1, platform: 'browser', arch: 'wasm', cwd: () => '/demo', uptime: () => 0, versions: {} };
}
if (typeof globalThis.Buffer === 'undefined') {
  class BrowserBuffer extends Uint8Array {
    static alloc(size = 0, fill = 0) {
      const b = new BrowserBuffer(Number(size) || 0);
      if (fill) b.fill(typeof fill === 'number' ? fill & 0xff : 0);
      return b;
    }
    static isBuffer(obj) { return obj instanceof BrowserBuffer; }
    static byteLength(str, encoding = 'utf8') {
      if (str instanceof Uint8Array || str instanceof ArrayBuffer) return str.byteLength;
      return BrowserBuffer.from(String(str ?? ''), encoding).byteLength;
    }
    static from(input, encoding = 'utf8') {
      if (typeof input === 'string') {
        const enc = String(encoding || 'utf8').toLowerCase();
        if (enc === 'base64') {
          const bin = globalThis.atob ? globalThis.atob(input) : '';
          const out = new BrowserBuffer(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        if (enc === 'hex') {
          const clean = input.replace(/\s+/g, '');
          const out = new BrowserBuffer(Math.floor(clean.length / 2));
          for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
          return out;
        }
        if (enc === 'latin1' || enc === 'binary') {
          const out = new BrowserBuffer(input.length);
          for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i) & 0xff;
          return out;
        }
        const bytes = new TextEncoder().encode(input);
        const out = new BrowserBuffer(bytes.length);
        out.set(bytes);
        return out;
      }
      if (input instanceof ArrayBuffer) {
        const out = new BrowserBuffer(input.byteLength);
        out.set(new Uint8Array(input));
        return out;
      }
      if (ArrayBuffer.isView(input)) {
        const out = new BrowserBuffer(input.byteLength);
        out.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
        return out;
      }
      if (Array.isArray(input)) {
        const out = new BrowserBuffer(input.length);
        for (let i = 0; i < input.length; i++) out[i] = input[i] & 0xff;
        return out;
      }
      return new BrowserBuffer(0);
    }
    static concat(list = [], totalLength) {
      const len = totalLength ?? list.reduce((sum, item) => sum + (item?.length || 0), 0);
      const out = new BrowserBuffer(len);
      let offset = 0;
      for (const item of list) {
        if (!item?.length || offset >= len) continue;
        const slice = offset + item.length > len ? item.subarray(0, len - offset) : item;
        out.set(slice, offset);
        offset += slice.length;
      }
      return out;
    }
    subarray(start, end) {
      const sub = super.subarray(start, end);
      Object.setPrototypeOf(sub, BrowserBuffer.prototype);
      return sub;
    }
    writeUInt32BE(value, offset = 0) {
      new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(offset, value >>> 0, false);
      return offset + 4;
    }
    writeUInt32LE(value, offset = 0) {
      new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(offset, value >>> 0, true);
      return offset + 4;
    }
    writeUInt16LE(value, offset = 0) {
      new DataView(this.buffer, this.byteOffset, this.byteLength).setUint16(offset, value & 0xffff, true);
      return offset + 2;
    }
    writeInt16LE(value, offset = 0) {
      new DataView(this.buffer, this.byteOffset, this.byteLength).setInt16(offset, value, true);
      return offset + 2;
    }
    writeBigUInt64BE(value, offset = 0) {
      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigUint64(offset, BigInt(value), false);
      return offset + 8;
    }
    readUInt32BE(offset = 0) {
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset, false);
    }
    readUInt32LE(offset = 0) {
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset, true);
    }
    toString(encoding = 'utf8', start = 0, end = this.length) {
      const view = this.subarray(start, end);
      const enc = String(encoding || 'utf8').toLowerCase();
      if (enc === 'base64') {
        let bin = '';
        for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
        return globalThis.btoa ? globalThis.btoa(bin) : bin;
      }
      if (enc === 'hex') return Array.from(view, b => b.toString(16).padStart(2, '0')).join('');
      if (enc === 'latin1' || enc === 'binary') {
        let out = '';
        for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
        return out;
      }
      return new TextDecoder('utf-8').decode(view);
    }
  }
  globalThis.Buffer = BrowserBuffer;
}

const isEn = () => { try { return (globalThis.localStorage?.getItem?.('study-ui-language') || 'en') !== 'zh'; } catch { return true; } };
export function unavailable() { throw new Error(isEn() ? 'This feature requires the installed plugin. Use the built-in materials and sample decks in the web demo.' : '此功能需要本地插件。网页体验版请使用内置资料和示例题组。'); }
export const extractPdf = unavailable, importLegacy = unavailable, importSourceFile = unavailable;
export const createUserMessage = unavailable;
// Match fs/promises: callers can handle absent desktop files with .catch().
const unavailableAsync = async () => unavailable();
export const open = unavailableAsync, readdir = unavailableAsync, stat = unavailableAsync, lstat = unavailableAsync, readFile = unavailableAsync, realpath = unavailableAsync;
export const access = unavailableAsync, chmod = unavailableAsync, cp = unavailableAsync, rmdir = unavailableAsync, statfs = unavailableAsync, unlink = unavailableAsync;
export const createReadStream = unavailable, createWriteStream = unavailable, spawn = unavailable, openPdfDocument = unavailableAsync, getDocument = unavailable, TextLayer = unavailable;
export const createRequire = () => unavailable, watch = unavailable;
export const WorkerMessageHandler = {};
export const readFileSync = p => String(p).includes('package.json') ? '{"version":"4.11.0"}' : unavailable();
export const existsSync = () => false;
export const realpathSync = p => String(p);
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
export const crc32 = unavailable, inflateRawSync = unavailable, gunzipSync = unavailable;
export const Worker = unavailable, pipeline = unavailableAsync;
export class Transform {}
export class Writable {}
export const setTimeout = (ms, value) => new Promise(resolve => globalThis.setTimeout(resolve, ms, value));
export class AsyncLocalStorage {
  constructor() { this._store = undefined; }
  getStore() { return this._store; }
  run(store, fn, ...args) {
    const prev = this._store;
    this._store = store;
    const restore = () => { this._store = prev; };
    try {
      const out = fn(...args);
      if (out && typeof out.then === 'function') return out.finally(restore);
      restore();
      return out;
    } catch (err) { restore(); throw err; }
  }
}
export const appendFile = unavailableAsync, mkdir = unavailableAsync, rm = unavailableAsync, writeFile = unavailableAsync;
export const rename = unavailableAsync, copyFile = unavailableAsync, mkdtemp = unavailableAsync;
export const MAX_PDF_BYTES = 8 * 1024 * 1024, MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const join = (...parts) => parts.join('/');
export const basename = p => p.split(/[\\/]/).pop();
export const dirname = p => String(p).replace(/[\\/][^\\/]*$/, '') || '.';
export const extname = p => /\.[^./\\]+$/.exec(p)?.[0] || '';
export const isAbsolute = p => p.startsWith('/') || /^[A-Z]:/i.test(p);
export const relative = (a,b) => b;
export const resolve = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
export const sep = '/';
export const win32 = { basename };
export default { join, basename, dirname, extname, isAbsolute, relative, resolve, sep, win32, request: unavailable };

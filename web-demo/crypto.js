// Browser equivalents for randomness and the service's SHA-256 / SHA-1 cache digests.
export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = () => { throw new Error('Audio processing requires the installed plugin.'); };
export function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  const span = max - min, limit = Math.floor(0x100000000 / span) * span;
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
  return min + bytes[0] % span;
}
const primes = [];
for (let n = 2; primes.length < 64; n++) if (!primes.some(p => p * p <= n && n % p === 0)) primes.push(n);
const constants = primes.map(p => (Math.cbrt(p) % 1 * 0x100000000) >>> 0);
const rotate = (n, bits) => n >>> bits | n << (32 - bits);
const rotl = (n, bits) => (n << bits) | (n >>> (32 - bits));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBytes(chunks) {
  const parts = chunks.map(c => c instanceof Uint8Array ? c : new TextEncoder().encode(String(c)));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function wordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i] >>> 0, false);
  return out;
}

function encodeBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >>> 6) & 63] : '=')
      + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

function sha256Words(input) {
  const length = input.length;
  const bytes = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  bytes.set(input); bytes[length] = 128;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(length * 8 / 0x100000000));
  view.setUint32(bytes.length - 4, length * 8);
  const hash = primes.slice(0, 8).map(p => (Math.sqrt(p) % 1 * 0x100000000) >>> 0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10);
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + constants[i] + words[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c)) | 0;
      [a, b, c, d, e, f, g, h] = [(t1 + t2) | 0, a, b, c, (d + t1) | 0, e, f, g];
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { hash[i] = (hash[i] + v) >>> 0; });
  }
  return hash;
}

function sha1Words(input) {
  const length = input.length;
  const bytes = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  bytes.set(input); bytes[length] = 128;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(length * 8 / 0x100000000));
  view.setUint32(bytes.length - 4, length * 8);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) >>> 0;
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? ((b & c) | (~b & d))
        : i < 40 ? (b ^ c ^ d)
        : i < 60 ? ((b & c) | (b & d) | (c & d))
        : (b ^ c ^ d);
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4];
}

export function createHash(algorithm) {
  if (algorithm !== 'sha256' && algorithm !== 'sha1') throw new Error('Unsupported digest');
  const chunks = [];
  return {
    update(value) { chunks.push(value); return this; },
    digest(format) {
      const raw = wordsToBytes(algorithm === 'sha1' ? sha1Words(toBytes(chunks)) : sha256Words(toBytes(chunks)));
      if (!format) return raw;
      if (format === 'hex') return Array.from(raw, b => b.toString(16).padStart(2, '0')).join('');
      if (format === 'base64') return encodeBase64(raw);
      if (format === 'base64url') return encodeBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      throw new Error('Unsupported digest format');
    },
  };
}

// Browser equivalents for randomness and the service's SHA-256 cache digests.
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
function sha256(text) {
  const input = new TextEncoder().encode(text), length = input.length;
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
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + (e & f ^ ~e & g) + constants[i] + words[i]) | 0;
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + (a & b ^ a & c ^ b & c)) | 0;
      [a,b,c,d,e,f,g,h] = [(t1+t2)|0,a,b,c,(d+t1)|0,e,f,g];
    }
    [a,b,c,d,e,f,g,h].forEach((v,i) => { hash[i] = (hash[i] + v) >>> 0; });
  }
  return hash.map(n => n.toString(16).padStart(8,'0')).join('');
}
export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error('Unsupported digest');
  let text = '';
  return { update(value) { text += String(value); return this; }, digest(format) {
    if (format !== 'hex') throw new Error('Unsupported digest format');
    return sha256(text);
  } };
}

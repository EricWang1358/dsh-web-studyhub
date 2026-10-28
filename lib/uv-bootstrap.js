import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZip } from './office/zip.js';
import { InstallError } from './tool-install.js';

/* Getting `uv` without GitHub and without Python: PyPI publishes uv as a wheel per platform, and the wheel holds the uv binary itself
   (uv-<version>.data/scripts/uv[.exe]). The wheel comes from the chosen index's PEP 503 page (Tsinghua for the mainland, pypi.org overseas),
   is checked against the sha256 that page gives, and is unzipped with the repository's own reader. A download that was cut off continues
   with an HTTP Range request from what is already on disk. Every network call goes through `fetch` (a seam: tests use a local server). */

const MB = 1_048_576;
export const UV_ZIP_LIMITS = Object.freeze({ maxEntryBytes: 160 * MB, maxReadBytes: 160 * MB });

/** The wheel tag of this platform's uv build. */
export function wheelTagFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'win_arm64' : arch === 'ia32' ? 'win32' : 'win_amd64';
  if (platform === 'darwin') return arch === 'arm64' ? 'macosx_11_0_arm64' : 'macosx_10_12_x86_64';
  return arch === 'arm64' ? 'manylinux_2_17_aarch64.manylinux2014_aarch64' : 'manylinux_2_17_x86_64.manylinux2014_x86_64';
}

const ANCHOR = /<a\s[^>]*href\s*=\s*"([^"]+)"[^>]*>([^<]+)<\/a>/gi;
const decode = text => text.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

/** The wheel `uv-<version>-py3-none-<tag>.whl` on a PEP 503 page: resolves { url, sha256, filename }. A page without it, or without its sha256, is refused. */
export async function findWheel(indexUrl, version, tag, { fetch = globalThis.fetch, signal } = {}) {
  const filename = `uv-${version}-py3-none-${tag}.whl`;
  let response;
  try { response = await fetch(indexUrl, { signal, headers: { accept: 'text/html' } }); }
  catch (error) { if (signal?.aborted) throw signal.reason ?? error; throw new InstallError('network', `fetch failed: ${error?.message || error}`); }
  if (!response.ok) throw new InstallError('network', `the index answered ${response.status}`);
  const html = await response.text();
  for (const match of html.matchAll(ANCHOR)) {
    if (match[2].trim() !== filename) continue;
    const href = decode(match[1]), url = new URL(href, indexUrl), sha256 = /(?:^|&)sha256=([0-9a-f]{64})/i.exec(url.hash.slice(1))?.[1]?.toLowerCase();
    if (!sha256) throw new InstallError('checksum', `the index gives no sha256 for ${filename}`);
    url.hash = '';
    return { url: url.href, sha256, filename };
  }
  throw new InstallError('network', `${filename} is not on ${indexUrl}`);
}

/** The digest of a file: sha256 in hex by default, or another algorithm and encoding (an npm integrity is sha512 in base64). */
export async function digestOf(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest(encoding);
}
const sha256Of = file => digestOf(file);
/** Does the file match an npm-style integrity ("sha512-<base64>")? Only sha512 is accepted: it is what the registry publishes. */
const matchesIntegrity = async (file, integrity) => {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity).trim());
  return !!match && (await digestOf(file, 'sha512', 'base64')) === match[1];
};
const sizeOf = file => stat(file).then(info => info.size, () => 0);

/**
 * Download `url` into `file`, continuing a partial file with a Range request when the server allows it, then check its sha256 or its npm
 * `integrity` (sha512) (a mismatch deletes
 * the file and throws InstallError 'checksum'). `onProgress({ done, total })` while it comes. Resolves { bytes, resumedFrom }.
 */
export async function downloadResumable(url, file, { sha256, integrity, signal, onProgress, fetch = globalThis.fetch } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const have = await sizeOf(file);
  let response;
  try { response = await fetch(url, { signal, headers: have > 0 ? { range: `bytes=${have}-` } : {} }); }
  catch (error) { if (signal?.aborted) throw signal.reason ?? error; throw new InstallError('network', `fetch failed: ${error?.message || error}`); }
  if (response.status === 416 && have > 0) {
    // The part on disk is already whole (or longer than the file): check it as it is.
  } else if (!response.ok) throw new InstallError('network', `the download answered ${response.status}`);
  const resumed = response.status === 206 && have > 0;
  const length = Number(response.headers.get('content-length')) || 0;
  const total = response.status === 416 ? have : resumed ? have + length : length;
  if (response.status !== 416) {
    const handle = await open(file, resumed ? 'a' : 'w');
    let done = resumed ? have : 0;
    try {
      for await (const part of response.body) {
        await handle.write(part);
        done += part.length;
        onProgress?.({ done, total });
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new InstallError('network', `the download was cut off: ${error?.message || error}`);
    } finally { await handle.close(); }
  }
  if ((sha256 && (await sha256Of(file)) !== sha256.toLowerCase()) || (integrity && !(await matchesIntegrity(file, integrity)))) {
    await rm(file, { force: true });
    throw new InstallError('checksum', `the downloaded file does not match its ${sha256 ? 'sha256' : 'sha512 integrity'}`);
  }
  return { bytes: await sizeOf(file), resumedFrom: resumed ? have : 0 };
}

/** Take the uv program out of a wheel into `destDir` (uv.exe on Windows). Resolves the program's path. */
export async function extractUv(wheel, destDir, platform = process.platform) {
  const zip = readZip(await readFile(wheel), UV_ZIP_LIMITS);
  const name = platform === 'win32' ? 'uv.exe' : 'uv';
  const entry = zip.names().find(item => new RegExp(`^uv-[^/]+\\.data/scripts/${name.replace('.', '\\.')}$`).test(item));
  if (!entry) throw new InstallError('checksum', `the wheel has no ${name}`);
  await mkdir(destDir, { recursive: true });
  const target = path.join(destDir, name);
  await writeFile(target, zip.read(entry));
  if (platform !== 'win32') await chmod(target, 0o755);
  return target;
}

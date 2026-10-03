import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Check the actual archives, including documentation links and DSH's locale entry points.
const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const target = resolve(root, process.argv.find(arg => arg.startsWith('--outdir='))?.slice(9) || `output/release-${manifest.version}`);
const receipt = JSON.parse(await readFile(join(target, 'artifacts.json'), 'utf8'));
assert.equal(receipt.version, manifest.version);
assert.equal(receipt.archives.length, 8);
const checksums = new Map((await readFile(join(target, `SHA256SUMS-${manifest.version}.txt`), 'utf8')).trim().split(/\r?\n/)
  .map(line => { const [hash, filename] = line.split(/\s+/); return [filename, hash]; }));
const checked = [];
for (const artifact of [...receipt.archives, receipt.setup, receipt.setupZh]) {
  assert.equal(artifact.filename, artifact.filename.replaceAll(/[/\\]/g, ''), 'artifact names stay in the release directory');
  const bytes = await readFile(join(target, artifact.filename));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, artifact.sha256, artifact.filename);
  assert.equal(hash, checksums.get(artifact.filename), artifact.filename);
  if (!artifact.filename.endsWith('.tgz')) continue;
  const archive = join(target, artifact.filename);
  const { stdout } = await run('tar', ['-tzf', archive], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const files = stdout.trim().split(/\r?\n/);
  assert.ok(files.every(file => file.startsWith('package/') && !file.split('/').includes('..')), 'package entries stay in their directory');
  const unpacked = await mkdtemp(join(target, 'verify-'));
  try {
    await run('tar', ['-xzf', archive, '-C', unpacked], { windowsHide: true });
    const packageRoot = join(unpacked, 'package');
    const packed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(packed.name, artifact.name);
    assert.equal(packed.version, manifest.version);
    await access(resolve(packageRoot, packed.main));
    if (packed.name !== '@ericwang1358/studyhub-retrieval') {
      for (const language of ['en', 'zh']) {
        const localePath = packed.exports['./locale/*'].replace('*', `${language}.json`);
        const locale = JSON.parse(await readFile(resolve(packageRoot, localePath), 'utf8'));
        assert.ok(locale.meta.title.startsWith('StudyHub'));
      }
      for (const file of files.filter(file => file.endsWith('.md'))) {
        const source = join(unpacked, file);
        const prose = (await readFile(source, 'utf8')).replace(/```[\s\S]*?```/g, '');
        for (const [, link] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
          if (/^(?:[a-z]+:|\/\/|#)/i.test(link)) continue;
          await access(resolve(dirname(source), decodeURIComponent(link.split('#')[0])));
        }
      }
    }
    checked.push({ name: packed.name, version: packed.version, files: files.length, sha256: hash });
  } finally {
    assert.equal(dirname(resolve(unpacked)), target, 'cleanup stays inside the release directory');
    await rm(unpacked, { recursive: true, force: true });
  }
}
assert.equal(checksums.size, 10, 'all eight archives and both setup pages have checksums');
const result = { version: manifest.version, archives: checked, setupPages: 2, status: 'passed' };
await writeFile(join(target, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));

/* Check the ZCode package of a release (npm run release:zcode:check) the way a learner would get it: the zip's checksum
   against its receipt and SHA256SUMS-ZCode-<version>.txt, its layout (installer, marketplace, guide, plugin of the same
   version, StudyHub's lib from this commit, the built panel in resources of at most 8 MiB, the production
   dependencies), and then the unpacked plugin's MCP server started with nothing but Node: tools listed, panel read,
   snapshot answered. Options: --outdir=<dir> (default output/release-<version>). */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RECEIPT, STUDYHUB_PARTS, sumsName, windowsTar, zipName } from '../release-zcode.mjs';
import { MAX_RESOURCE_BYTES } from '../build-zcode.mjs';
import { scrubSecrets } from './env.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

export async function checkZcodeRelease({ outdir } = {}) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const target = resolve(root, outdir || join('output', `release-${version}`));
  const receipt = JSON.parse(await readFile(join(target, RECEIPT), 'utf8'));
  assert.equal(receipt.version, version);
  assert.equal(receipt.zcode.filename, zipName(version));
  const bytes = await readFile(join(target, receipt.zcode.filename));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, receipt.zcode.sha256, 'the zip matches its receipt');
  const sums = (await readFile(join(target, sumsName(version)), 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(sums, [`${sha256}  ${zipName(version)}`], 'SHA256SUMS-ZCode lists the zip and nothing else');

  const unpacked = await mkdtemp(join(target, 'verify-zcode-'));
  try {
    if (process.platform === 'win32') await exec(windowsTar(), ['-x', '-f', join(target, receipt.zcode.filename), '-C', unpacked], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    else await exec('unzip', ['-q', join(target, receipt.zcode.filename), '-d', unpacked], { maxBuffer: 64 * 1024 * 1024 });
    assert.deepEqual(await readdir(unpacked), [`StudyHub-ZCode-${version}`], 'one top folder');
    const folder = join(unpacked, `StudyHub-ZCode-${version}`), plugin = join(folder, 'studyhub');
    const bat = await readFile(join(folder, 'install.bat'), 'utf8');
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(bat), 'install.bat is ASCII');
    assert.ok(!/(^|[^\r])\n/.test(bat), 'install.bat is CRLF');
    const market = JSON.parse(await readFile(join(folder, 'marketplace.json'), 'utf8'));
    assert.equal(market.name, 'studyhub-bundle');
    assert.deepEqual([market.plugins[0].name, market.plugins[0].source, market.plugins[0].version], ['studyhub', './studyhub', version]);
    for (const guide of ['README-ZCode.md', 'README-ZCode.zh-CN.md']) await access(join(folder, guide));
    assert.equal(JSON.parse(await readFile(join(plugin, '.zcode-plugin', 'plugin.json'), 'utf8')).version, version);
    const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
    assert.equal(manifest.version, version, 'the plugin version is StudyHub\'s');
    for (const part of STUDYHUB_PARTS) await access(join(plugin, part));
    for (const file of ['host/entry.mjs', 'hooks/hooks.json', 'hooks/session-start.mjs', 'commands/studyhub.md', 'install/find-zcode.mjs', 'lib/service.js', 'skills/study-book/SKILL.md'])
      await access(join(plugin, file));
    // lib/ in the plugin is this commit's lib/ (spot checks: the service and the version reader).
    for (const file of ['service.js', 'update-check.js', 'host.js'])
      assert.equal(await readFile(join(plugin, 'lib', file), 'utf8'), await readFile(join(root, 'lib', file), 'utf8'), `lib/${file} is this commit's`);
    assert.ok(!(await readdir(join(plugin, 'lib'))).some((name) => /^client(\..+)?\.js$/.test(name)), 'the DSH UI bundle is not carried');
    for (const name of Object.keys(manifest.dependencies)) await access(join(plugin, 'node_modules', ...name.split('/'), 'package.json'));
    const ui = join(plugin, 'dist', 'ui');
    const panelManifest = JSON.parse(await readFile(join(ui, 'manifest.json'), 'utf8'));
    for (const name of [panelManifest.entry, ...panelManifest.css, ...panelManifest.chunks, 'panel.html']) {
      const size = (await stat(join(ui, name))).size;
      assert.ok(size <= MAX_RESOURCE_BYTES, `${name} is ${size} bytes, over ZCode's 8 MiB resource limit`);
    }
    await assert.rejects(access(join(ui, 'panel.test.html')), 'the browser-test page is not shipped');

    // The unpacked plugin runs with Node alone: its MCP server lists its tools, serves the panel and answers a snapshot.
    const scratch = await mkdtemp(join(target, 'verify-zcode-run-'));
    try {
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(plugin, 'host', 'entry.mjs')], stderr: 'pipe',
        env: { ...scrubSecrets(process.env), DSH_HOME: join(scratch, 'home'), STUDYHUB_LIBRARY: join(scratch, 'library') } });
      const client = new Client({ name: 'release-zcode-check', version });
      await client.connect(transport);
      try {
        const tools = (await client.listTools()).tools.map((tool) => tool.name);
        for (const name of ['study_workspace', 'study_call', 'studyhub_open', 'studyhub_status']) assert.ok(tools.includes(name), name);
        const panel = (await client.readResource({ uri: 'ui://studyhub/panel.html' })).contents[0].text;
        assert.match(panel, /__studyShell/);
        const snapshot = JSON.parse((await client.callTool({ name: 'study_call', arguments: { action: 'snapshot' } })).content[0].text);
        assert.equal(snapshot.ok, true, snapshot.error);
        const running = JSON.parse((await client.callTool({ name: 'study_call', arguments: { action: 'binding.get' } })).content[0].text);
        assert.equal(running.value.host.edition, 'zcode');
      } finally { await client.close(); }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  } finally {
    assert.equal(dirname(resolve(unpacked)), target, 'cleanup stays inside the release directory');
    await rm(unpacked, { recursive: true, force: true });
  }
  const result = { version, zcode: { filename: receipt.zcode.filename, bytes: bytes.length, sha256 }, status: 'passed' };
  await writeFile(join(target, 'verification-zcode.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outdir = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice(9);
  console.log(JSON.stringify(await checkZcodeRelease({ outdir }), null, 2));
}

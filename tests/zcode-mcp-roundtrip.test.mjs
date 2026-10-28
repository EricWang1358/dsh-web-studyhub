import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scrubSecrets } from '../scripts/qa/env.mjs';
import { buildZcodePanel } from '../scripts/build-zcode.mjs';

/* The ZCode MCP server end to end, the way ZCode starts it: spawned over stdio against a temporary library and home.
   Tools and resources are listed, the panel page is read back, the snapshot answers through the model's gateway, and
   an action the assistant may not call is refused there while the panel may call it. */
const entry = fileURLToPath(new URL('../packages/studyhub-zcode/host/entry.mjs', import.meta.url));
const parse = (result) => JSON.parse(result.content[0].text);

test('the ZCode MCP server answers the panel and the model as ZCode would use it', { timeout: 120_000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'zcode-mcp-'));
  const ui = join(scratch, 'ui');
  await buildZcodePanel({ outdir: ui });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe',
    env: { ...scrubSecrets(process.env), DSH_HOME: join(scratch, 'home'), STUDYHUB_LIBRARY: join(scratch, 'library'), STUDYHUB_ZCODE_UI_DIR: ui } });
  const client = new Client({ name: 'zcode-roundtrip-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); await rm(scratch, { recursive: true, force: true }); });

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const name of ['study_workspace', 'study_call', 'studyhub_open', 'studyhub_status', 'study_materials', 'study_capabilities'])
    assert.ok(names.includes(name), `${name} is listed`);
  assert.deepEqual(tools.find((tool) => tool.name === 'study_call')._meta?.ui?.visibility, ['app'], 'study_call is page-only');
  assert.equal(tools.find((tool) => tool.name === 'studyhub_open')._meta?.ui?.resourceUri, 'ui://studyhub/panel.html');

  const { resources } = await client.listResources();
  assert.ok(resources.some((resource) => resource.uri === 'ui://studyhub/panel.html'));
  assert.ok(!resources.some((resource) => resource.uri.endsWith('panel.test.html')), 'the browser-test page is never served');
  const read = async (uri) => (await client.readResource({ uri })).contents[0].text;
  const panel = await read('ui://studyhub/panel.html');
  assert.match(panel, /__studyShell/, 'the panel page carries the shell loader');
  const manifest = JSON.parse(await read('ui://studyhub/manifest.json'));
  assert.equal(manifest.entry, 'app.js');
  assert.ok(manifest.chunks.length > 0);
  assert.ok((await read(`ui://studyhub/${manifest.chunks[0]}`)).length > 0);

  const snapshot = parse(await client.callTool({ name: 'study_workspace', arguments: { action: 'snapshot' } }));
  assert.ok(Array.isArray(snapshot.decks), 'the model reads the snapshot');
  assert.equal(snapshot.modelReady, false, 'no endpoint saved: no model');
  const context = parse(await client.callTool({ name: 'study_workspace', arguments: { action: 'library.context' } }));
  assert.ok(context && typeof context === 'object');

  // usage.frequency.* is the learner's own record (lib/assistant-boundary.js): the panel reads it, the assistant is refused.
  const refused = await client.callTool({ name: 'study_workspace', arguments: { action: 'usage.frequency.status' } });
  assert.equal(refused.isError, true);
  assert.match(parse(refused).error, /not available to the assistant/);
  const panelRead = parse(await client.callTool({ name: 'study_call', arguments: { action: 'usage.frequency.status' } }));
  assert.equal(panelRead.ok, true, 'the panel may read it');
  // The endpoint and its key are the panel's alone.
  const modelRefused = await client.callTool({ name: 'study_workspace', arguments: { action: 'model.config.get' } });
  assert.equal(modelRefused.isError, true);

  const binding = parse(await client.callTool({ name: 'study_call', arguments: { action: 'binding.get' } }));
  assert.equal(binding.ok, true);
  assert.equal(binding.value.root, join(scratch, 'library'));
  assert.equal(binding.value.host.edition, 'zcode');

  const unknown = await client.callTool({ name: 'study_call', arguments: { action: 'definitely.not.an.action' } });
  assert.equal(unknown.isError, true);
  assert.equal(parse(unknown).ok, false);

  const badLink = parse(await client.callTool({ name: 'study_call', arguments: { action: 'app.open', args: { url: 'file:///C:/Windows/System32/calc.exe' } } }));
  assert.equal(badLink.ok, false, 'only http(s) addresses open');

  const opened = parse(await client.callTool({ name: 'studyhub_open', arguments: {} }));
  assert.equal(opened.opened, true);
  assert.equal(opened.root, join(scratch, 'library'));
  assert.equal(opened.dueToday, 0);
  const status = parse(await client.callTool({ name: 'studyhub_status', arguments: {} }));
  assert.equal(status.decks, 0);

  const capabilities = parse(await client.callTool({ name: 'study_capabilities', arguments: {} }));
  assert.ok(Array.isArray(capabilities.contexts) && capabilities.contexts.length > 0, 'the domain tools see the installed contexts');
});

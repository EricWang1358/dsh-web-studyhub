import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantRefusal } from '../lib/assistant-boundary.js';

/* The assistant's door in ZCode is DSH's study_workspace tool (lib/index.js runStudyTool), not the panel's host handler
   (lib/host.js createHostHandler), which also answers panel-only actions (samples, library usage, audio files, the
   panel's own reports, assist tasks, reasoning levels, extension installs, the one-click upgrade). The action sets are
   read from both sources, so a new panel-only action in lib/host.js is checked here without editing this test. */
const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const hostText = await source('lib/host.js');
const indexText = await source('lib/index.js');
const toolBlock = indexText.slice(indexText.indexOf('async function runStudyTool'), indexText.indexOf('// The skills StudyHub ships'));
const namedIn = (text, prefix) => {
  const exact = [...text.matchAll(new RegExp(`${prefix}action === "([a-z.]+)"`, 'g'))].map((match) => match[1]);
  const families = [...text.matchAll(new RegExp(`${prefix}action\\.startsWith\\("([a-z.]+)"\\)`, 'g'))].map((match) => match[1]);
  return { exact: new Set(exact), families };
};
const handler = namedIn(hostText, '');
const dshTool = namedIn(toolBlock, 'a\\.');
// One example action for each family the host handler answers as a whole.
const FAMILY_EXAMPLES = { 'board.': 'board.get', 'notebook.': 'notebook.list', 'sample.': 'sample.create' };

async function zcodeHost(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-door-'));
  const previous = process.env.DSH_HOME;
  const { createZcodeHost } = await import('../packages/studyhub-zcode/host/study-host.mjs');
  const host = await createZcodeHost({ env: { DSH_HOME: join(dir, 'home'), STUDYHUB_LIBRARY: join(dir, 'library') }, documents: join(dir, 'Documents'), log: () => {} });
  t.after(async () => { await host.dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  return host;
}

test('the assistant reaches in ZCode exactly what DSH\'s study_workspace tool reaches, never the panel\'s host-only actions', async (t) => {
  const host = await zcodeHost(t);
  const { StudyService } = await import('../lib/service.js');
  const probe = new StudyService(join(tmpdir(), `zcode-door-probe-${process.pid}`), {});
  t.after(() => probe.dispose());
  const runtimeHas = (action) => probe.runtime.hasAction(action);
  const dshReaches = (action) => !assistantRefusal(action) && (dshTool.exact.has(action) || dshTool.families.some((family) => action.startsWith(family)) || runtimeHas(action));
  const candidates = [...handler.exact, ...handler.families.map((family) => FAMILY_EXAMPLES[family] || `${family}x`), 'model.config.get', 'model.config.set', 'model.config.test', 'app.open'];
  const differences = [];
  for (const action of new Set(candidates)) {
    const answer = await host.call(action, {}, { from: 'agent' });
    const refused = !answer.ok && (answer.code === 'assistant-refused' || /^Unknown study action/.test(answer.error));
    // ZCode refuses two more than DSH on purpose: binding.set (it moves the library of every ZCode chat) and panel.open (no panel queue).
    const expected = dshReaches(action) && !['binding.set', 'panel.open'].includes(action);
    if (refused === expected) differences.push(`${action}: DSH ${expected ? 'reaches' : 'refuses'} it, ZCode ${refused ? 'refuses' : 'reaches'} it`);
  }
  assert.deepEqual(differences, []);
  // The panel-only actions the gate review named, explicitly.
  for (const action of ['sample.create', 'library.usage', 'audio.files', 'panel.visible', 'panel.intent.next', 'assist.start', 'model.efforts',
    'retrieval.extension.install', 'update.install', 'binding.set', 'model.config.set', 'usage.frequency.status']) {
    const answer = await host.call(action, {}, { from: 'agent' });
    assert.equal(answer.ok, false, action);
  }
  // And the default door is the assistant's.
  assert.equal((await host.call('model.config.get', {})).ok, false, 'a call that names no door is the assistant\'s');
  assert.equal((await host.call('snapshot', {})).value.decks.length, 0);
});

test('a domain tool call keeps the library it started on', async (t) => {
  const host = await zcodeHost(t);
  const tools = host.domainTools();
  const bank = tools.find((tool) => tool.name === 'study_bank');
  const capabilities = tools.find((tool) => tool.name === 'study_capabilities');
  assert.ok(bank && capabilities);
  const index = await capabilities.execute({}, {});
  assert.ok(index.contexts.length > 0);
  const first = await bank.execute({ operation: 'list' }, {});
  assert.ok(first && typeof first === 'object');
});

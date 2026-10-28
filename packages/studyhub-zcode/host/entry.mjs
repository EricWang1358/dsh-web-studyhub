/* The StudyHub MCP server for ZCode (stdio). Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   Tools:
     study_workspace   the model's study gateway, the same contract as under DSH (lib/study-contracts.js), with the
                       assistant boundary (lib/assistant-boundary.js) applied, so the shipped skills work unchanged
     study_call        the panel's transport, one study action per call; page-only (_meta.ui.visibility ['app']);
                       app.open hands an http(s) link to the system browser
     studyhub_open     opens the panel (ui://studyhub/panel.html) and says what is due today
     studyhub_status   a read-only summary of the bound library
     study_materials, study_bank, study_practice, study_audio, study_generate_selection, study_capabilities
                       DSH's typed domain tools (lib/runtime/tools.js), which the shipped skills also name
   Resources: every file of dist/ui as ui://studyhub/<name> (the panel page, its manifest and its chunks; built by
   scripts/build-zcode.mjs). */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { applyHome } from './workspace.mjs';
import { importLib, pluginPath, studyhubRoot } from './lib-root.mjs';
import { zcodeErrorText } from './messages.mjs';

applyHome(process.env);
const [{ createZcodeHost }, { openExternal }, { dueSummary }, { studyToolDescription }, { currentVersion }] = await Promise.all([
  import('./study-host.mjs'), import('./app-open.mjs'), import('./due.mjs'), importLib('study-contracts.js'), importLib('update-check.js'),
]);

export const PANEL_URI = 'ui://studyhub/panel.html';
// STUDYHUB_ZCODE_UI_DIR: another panel build (tests build one into a temporary folder).
const UI_DIR = process.env.STUDYHUB_ZCODE_UI_DIR?.trim() || join(pluginPath, 'dist', 'ui');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/* STUDY_FAKE_MODEL=1 (development and tests only): the repository's fake model instead of the learner's endpoint. A
   release has no scripts/fake-model.mjs, so there it changes nothing. */
async function fakeModel() {
  if (!process.env.STUDY_FAKE_MODEL) return undefined;
  try { return (await import(new URL('scripts/fake-model.mjs', studyhubRoot).href)).createFakeModel({ latencyMs: Number(process.env.STUDY_FAKE_LATENCY_MS || 300) }); }
  catch { return undefined; }
}
const host = await createZcodeHost({ complete: await fakeModel() });
// The running StudyHub version, so the MCP handshake reports what is really running.
const server = new McpServer({ name: 'studyhub', version: currentVersion() }, { capabilities: { resources: {} } });

server.registerTool('study_workspace', {
  title: 'Study workspace',
  description: studyToolDescription,
  inputSchema: {
    action: z.string().describe('The study action name, e.g. library.context, snapshot, review.start, book.toc'),
    payload_json: z.string().optional().describe('JSON object of action arguments; omit for read actions'),
  },
}, async ({ action, payload_json }) => {
  let args = {};
  if (payload_json) {
    try { args = JSON.parse(payload_json); } catch (error) {
      return { isError: true, ...text({ error: `payload_json is not valid JSON (${error.message}); send the action arguments as a JSON object string` }) };
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { isError: true, ...text({ error: 'payload_json must be a JSON object' }) };
  }
  const answer = await host.call(action, args, { from: 'agent' });
  if (!answer.ok) return { isError: true, ...text({ error: answer.error, ...(answer.code ? { code: answer.code } : {}) }) };
  const value = answer.value;
  return text(value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value });
});

/* The panel's transport. The envelope mirrors DSH's /api/study-workspace/call: {ok:true,value} or {ok:false,error,code}. */
server.registerTool('study_call', {
  title: 'Study panel call',
  description: 'The StudyHub panel transport: one study action per call. Page-only.',
  inputSchema: { action: z.string(), args: z.record(z.string(), z.unknown()).optional() },
  _meta: { ui: { visibility: ['app'] } },
}, async ({ action, args }) => {
  let answer;
  if (action === 'app.open') {
    try { answer = { ok: true, value: openExternal(args?.url) }; }
    catch (error) { answer = { ok: false, error: zcodeErrorText(error, args?.uiLanguage), code: error.code }; }
  } else answer = await host.call(action, args ?? {}, { from: 'panel' });
  return answer.ok ? text(answer) : { isError: true, ...text(answer) };
});

async function libraryLine() {
  const root = host.config.libraryRoot;
  let summary = { due: null, cards: null, decks: null };
  try { summary = await dueSummary(root); } catch { /* an unreadable library still opens the panel, which says why */ }
  return { root, dueToday: summary.due, cards: summary.cards, decks: summary.decks };
}

server.registerTool('studyhub_open', {
  title: 'Open the StudyHub panel',
  description: 'Open the StudyHub study panel (courses, decks, review) in the side panel. No arguments. '
    + 'ZCode\'s main-area full view is host chrome (Ctrl+Shift+F / Cmd+Shift+F); the panel cannot switch itself there.',
  inputSchema: {},
  _meta: { ui: { resourceUri: PANEL_URI, surface: 'studyhub', visibility: ['model', 'app'] }, 'openai/ui': { preferredModelDisplayMode: 'fullscreen' } },
}, async () => text({ opened: true, ...(await libraryLine()),
  fullViewHint: 'The panel opens in the right side pane. For the main-area full view press Ctrl+Shift+F (Cmd+Shift+F on macOS) or the expand button of the side pane.' }));

server.registerTool('studyhub_status', {
  title: 'StudyHub status',
  description: 'Read-only summary of the bound study library: its folder, the number of decks and cards, and how many cards are due for review today (the dashboard’s 到期待复习). No arguments.',
  inputSchema: {},
}, async () => text(await libraryLine()));

/* DSH's typed domain tools, as lib/runtime/tools.js defines them. Their JSON-schema parameters become permissive zod fields. */
const zodOf = (schema = {}) => {
  if (Array.isArray(schema.enum) && schema.enum.length) return z.enum(schema.enum);
  switch (schema.type) {
    case 'string': return z.string();
    case 'integer': return z.number().int();
    case 'number': return z.number();
    case 'boolean': return z.boolean();
    case 'array': return z.array(z.unknown());
    case 'object': return z.record(z.string(), z.unknown());
    default: return z.unknown();
  }
};
for (const tool of host.domainTools()) {
  const parameters = tool.parameters?.type === 'object' ? tool.parameters.properties || {} : tool.parameters || {};
  const required = new Set(tool.parameters?.required || Object.entries(parameters).filter(([, value]) => value?.required).map(([name]) => name));
  const shape = Object.fromEntries(Object.entries(parameters).map(([name, schema]) => [name, required.has(name) ? zodOf(schema) : zodOf(schema).optional()]));
  server.registerTool(tool.name, { title: tool.name, description: tool.description, inputSchema: shape }, async (input) => {
    try { return text(await tool.execute(input, {})); }
    catch (error) { return { isError: true, ...text({ error: error?.message || String(error), ...(error?.code ? { code: error.code } : {}) }) }; }
  });
}

/* The panel and its bundle: one resource per file. The panel needs wasm (pdf.js decoders). */
let served = 0;
let names = [];
try { names = await readdir(UI_DIR); } catch { console.error(`[studyhub] no panel build at ${UI_DIR}; run npm run build:zcode`); }
for (const name of names) {
  const mimeType = MIME[name.slice(name.lastIndexOf('.'))];
  if (!mimeType || name === 'panel.test.html') continue;
  const uri = `ui://studyhub/${name}`;
  server.registerResource(name.replace(/[^a-z0-9]+/gi, '-'), uri,
    { mimeType, ...(name === 'panel.html' ? { _meta: { 'zcode/csp': { wasmUnsafeEval: true } } } : {}) },
    async () => ({ contents: [{ uri, mimeType, text: await readFile(join(UI_DIR, name), 'utf8') }] }));
  served += 1;
}

const shutdown = async () => {
  try { await host.dispose(); } catch { /* already gone */ }
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error(`[studyhub] library ${host.config.libraryRoot}, home ${process.env.DSH_HOME}, ${served} panel resources`);

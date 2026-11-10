import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { classifyFailure } from '../lib/tool-install.js';
import { LIVE_LOCAL_MESSAGES } from '../lib/live-local-install-text.js';
import { LIVE_LOOPBACK_MESSAGES } from '../lib/live-loopback-install-text.js';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { default as DiagnosticActions, DiagnosticBar } from './ui/install/DiagnosticActions.jsx';
  export {
    redactDiagnosticText,
    joinLogBlocks,
    formatDiagnosticReport,
    mineruDiagnostic,
    markerDiagnostic,
    liveLocalDiagnostic,
    liveLoopbackDiagnostic,
    extensionDiagnostic,
  } from './ui/install/install-diagnostics.js';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { default as LiveLocalCard } from './ui/LiveLocalCard.jsx';
  export { default as LiveLoopbackCard } from './ui/LiveLoopbackCard.jsx';
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { default as ExtensionNotStarted } from './ui/ExtensionNotStarted.jsx';
  export { default as MarkerSettings } from './ui/MarkerSettings.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const han = /[\u3400-\u9fff]/;
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const primaries = html => (html.match(/class="sh-btn sh-btn--primary/g) || []).length;
const render = (el, lang = 'zh') => { uiMod.setUiLanguage(lang); try { return renderToStaticMarkup(el); } finally { uiMod.setUiLanguage('zh'); } };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function mountCopyHarness() {
  const states = [], refs = [], deps = [], cleanups = [];
  let stateAt = 0, refAt = 0, effectAt = 0, pending = [];
  const hooks = {
    ...React,
    useId: () => 'diag',
    useContext: () => null,
    useSyncExternalStore: (_sub, get) => get(),
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef: initial => refs[refAt++] ||= { current: initial },
    useState: initial => {
      const idx = stateAt++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
      return [states[idx], value => { states[idx] = typeof value === 'function' ? value(states[idx]) : value; }];
    },
    useEffect: (effect, dependencies) => {
      const idx = effectAt++;
      if (!deps[idx] || !dependencies || dependencies.some((v, pos) => v !== deps[idx][pos])) {
        deps[idx] = dependencies;
        pending.push(() => { cleanups[idx]?.(); cleanups[idx] = effect(); });
      }
    },
  };
  const require = createRequire(import.meta.url);
  const compiled = await build({
    stdin: {
      contents: `
        export { default as DiagnosticActions, DiagnosticBar } from './ui/install/DiagnosticActions.jsx';
        export { useCopyFeedback } from './ui/use-copy-feedback.js';
        export { CopyDiagnosticsButton } from './ui/components/ErrorState.jsx';
      `,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
    loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => (name === 'react' ? hooks : require(name)), mod, mod.exports);
  return {
    exports: mod.exports,
    run(fn) {
      stateAt = 0; refAt = 0; effectAt = 0; pending = [];
      const out = fn(mod.exports);
      pending.forEach(effect => effect());
      return out;
    },
    close() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}

test('tool-install classifyFailure detects ENAMETOOLONG and Windows/POSIX access-denied messages', () => {
  assert.equal(classifyFailure('Error: ENAMETOOLONG: name too long, open C:\\deep\\file'), 'path-too-long');
  assert.equal(classifyFailure("error CS0016: Access to the path 'D:\\Locked\\out.exe' is denied."), 'not-writable');
  assert.equal(classifyFailure('Error: EACCES: permission denied, mkdir /opt/locked'), 'not-writable');
});

test('DiagnosticBar copies through the one CopyDiagnosticsButton: text read when asked, a fresh button per resetKey, an honest note and selectable text when the clipboard refuses', async t => {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let written = '', shouldFail = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async value => { if (shouldFail) throw new Error('denied'); written = value; } } },
  });
  t.after(() => { if (prevDescriptor) Object.defineProperty(globalThis, 'navigator', prevDescriptor); else delete globalThis.navigator; });

  const harness = await mountCopyHarness();
  t.after(() => harness.close());

  const find = (node, match) => {
    if (!node || typeof node !== 'object') return null;
    if (match(node)) return node;
    for (const child of [node.props?.children].flat()) { const hit = find(child, match); if (hit) return hit; }
    return null;
  };
  // The bar hands its text to the app's one CopyDiagnosticsButton, read only when the button asks; a new resetKey is a new button.
  let count = 0;
  const bar = harness.run(({ DiagnosticBar }) => DiagnosticBar({ text: () => `lazy-report-${++count}`, resetKey: 'a', children: null }));
  const button = find(bar, node => node.type === harness.exports.CopyDiagnosticsButton);
  assert.ok(button, 'DiagnosticBar renders CopyDiagnosticsButton');
  assert.equal(button.key, 'a');
  assert.equal(count, 0, 'the text is not read before the button asks for it');
  assert.equal(button.props.describe(), 'lazy-report-1');
  const fromDiagnostic = harness.run(({ DiagnosticBar }) => DiagnosticBar({ diagnostic: () => ({ text: 'the report', input: {} }), resetKey: 'b', children: null }));
  assert.equal(find(fromDiagnostic, node => node.type === harness.exports.CopyDiagnosticsButton).props.describe(), 'the report');

  // The button: copies, says so, and when the clipboard refuses, says so (role="status") and opens the text to select by hand.
  const onClickOf = tree => find(tree, node => typeof node.props?.onClick === 'function');
  let copy = harness.run(({ CopyDiagnosticsButton }) => CopyDiagnosticsButton({ describe: () => 'the report' }));
  await onClickOf(copy).props.onClick();
  await flush();
  assert.equal(written, 'the report');
  copy = harness.run(({ CopyDiagnosticsButton }) => CopyDiagnosticsButton({ describe: () => 'the report' }));
  assert.equal(onClickOf(copy).props.children, '已复制');
  shouldFail = true;
  await onClickOf(copy).props.onClick();
  await flush();
  copy = harness.run(({ CopyDiagnosticsButton }) => CopyDiagnosticsButton({ describe: () => 'the report' }));
  const refused = find(copy, node => node.props?.role === 'status');
  assert.match(JSON.stringify(refused), /没能复制，请选中下面的文字再复制/);
  assert.equal(find(copy, node => node.type === 'textarea').props.value, 'the report');
  assert.ok(!JSON.stringify(copy).includes('发给主会话'), 'no promise that the hand-off shows the same text');
});

test('redactDiagnosticText and all 5 setup.failed tool prompts stay credential-free, fence-safe, and Han-free in English', () => {
  const dirty = 'GET https://alice:s3cret-pass@mirror.example.com/pkg Authorization: Bearer sk-live-1234567890abcdef api_key="tok_abcdef123456"';
  const clean = uiMod.redactDiagnosticText(dirty);
  assert.ok(!clean.includes('s3cret-pass') && !clean.includes('sk-live-1234567890abcdef') && !clean.includes('tok_abcdef123456'), clean);
  assert.match(clean, /https:\/\/\*\*\*@mirror\.example\.com\/pkg/);

  const bundles = [
    uiMod.mineruDiagnostic({
      plan: { platform: 'win32' },
      shown: { state: 'error', code: 'not-writable', origin: 'install' },
      install: { step: 5, stage: 'enable', folder: 'D:\\StudyHub\\MinerU', tier: 'basic', source: { id: 'mainland' }, log: [dirty] },
      summary: 'Permission denied on home folder',
      stageLabel: 'Enable local service',
    }),
    uiMod.markerDiagnostic({
      plan: { platform: 'win32', maxPython: '3.13', tooNewPython: '3.14.2' },
      install: { status: 'failed', stage: 'install', folder: 'D:\\StudyHub\\Marker', mirror: 'tsinghua', error: { code: 'pip-build', message: 'Build failed' }, log: [dirty] },
      summary: 'Pillow wheel build failed',
      stageLabel: 'Install marker-pdf',
    }),
    uiMod.liveLocalDiagnostic({
      plan: { platform: 'win32', arch: 'x64' },
      shown: { state: 'error', code: 'vc-runtime' },
      status: { step: 3, of: 3, stage: 'check', folder: 'D:\\StudyHub\\LiveLocal', engineVersion: '1.13.8', log: [dirty] },
      modelId: 'sense-voice',
      summary: 'Missing Microsoft VC++ runtime',
      stageLabel: 'Check engine',
    }),
    uiMod.liveLoopbackDiagnostic({
      plan: { platform: 'win32', arch: 'x64' },
      shown: { state: 'error', code: 'not-writable' },
      status: { step: 1, of: 2, stage: 'compile', folder: 'D:\\StudyHub\\LiveLoopback', helperVersion: '1.0.0', log: [dirty] },
      summary: 'Folder cannot be written to',
      stageLabel: 'Build audio helper',
    }),
    uiMod.extensionDiagnostic({
      status: { extension: { version: '2.1.2', outdated: true, expected: '2.1.3' }, companion: { id: 'mcp:rag', notStarted: true, reset: { reason: 'corrupt' } } },
      run: { status: 'failed', stage: 'model', errorCode: 'retrieval-model-download', error: dirty, failed: [{ id: 'p1', message: 'timeout' }] },
      course: 'OS',
      summary: 'Model download timed out',
    }),
  ];

  for (const { input, text } of bundles) {
    assert.ok(!text.includes('s3cret-pass') && !input.log.includes('s3cret-pass'), `${input.tool} redacts secrets`);
    const zh = uiMod.handOffText('setup.failed', input, 'zh');
    const en = uiMod.handOffText('setup.failed', input, 'en');
    assert.match(zh, /^我在 StudyHub 的「.+」想排查/);
    assert.match(en, /^In StudyHub’s .+ I want to find out why/);
    assert.doesNotMatch(en, han, `${input.tool} English prompt contains Han: ${en}`);
  }
});

/* Every kind of secret the review found surviving the installer redactors, with the secret part that must be gone. */
const SECRETS = [
  ['Authorization: Bearer abc.def', 'abc.def'],
  ['{"token": "xxxxxxxxxxxx"}', 'xxxxxxxxxxxx'],
  ['{"api_key": "sk-abcdefghijkl"}', 'sk-abcdefghijkl'],
  ['using ghp_0123456789abcdefABCDEF0123456789abcd now', 'ghp_0123456789abcdefABCDEF0123456789abcd'],
  ['key sk-proj-AbCdEf0123456789xyzXYZ in env', 'sk-proj-AbCdEf0123456789xyzXYZ'],
  ['hf token hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345 here', 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
  ['password=hunter2', 'hunter2'],
  ['secret_key=abc123', 'abc123'],
  ['PermissionError: C:\\Users\\EricW\\.mineru\\config.yaml', 'EricW'],
  ['open /home/ericw/.mineru/config.yaml failed', 'ericw'],
  ['open /Users/ericw/Library/x failed', 'ericw'],
  ['blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams= end', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpams='],
  ['GET https://alice:s3cret-pass@mirror.example.com/pkg', 's3cret-pass'],
  ['open C:\\Users\\Eric Wang\\x failed', 'Wang'],
  ['HF_TOKEN=hf_live_value_123', 'hf_live_value_123'],
  ['client_secret: abcdef123', 'abcdef123'],
  ['x-api-key: k-123456', 'k-123456'],
];

test('redactSecrets keeps a path its drive and depth and a model URL whole, still removes a base64 token and a JWT, and is linear on a long line', async () => {
  const { redactSecrets } = await import('../lib/plain-reason.js');
  assert.equal(redactSecrets('File "/home/eric/StudyHub/mineru/venv/lib/python3/site/x.py", line 3'), 'File "~/StudyHub/mineru/venv/lib/python3/site/x.py", line 3');
  const url = 'https://huggingface.co/opendatalab/PDF-Extract-Kit-1.0/resolve/main/models/Layout/YOLO/doclayout_yolo_docstructbench_imgsz1280_2501.pt';
  assert.equal(redactSecrets(`GET ${url}`), `GET ${url}`);
  const dll = 'D:/StudyHub/mineru/venv/Lib/site-packages/nvidia/Torch2Cuda12Runtime/x.dll';
  assert.equal(redactSecrets(dll), dll);
  const token = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';
  assert.equal(token.length, 48);
  assert.equal(redactSecrets(`cookie value ${token} end`), 'cookie value *** end');
  assert.equal(redactSecrets('id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl end'), 'id *** end');
  const line = 'a-'.repeat(30_000);
  const started = performance.now();
  redactSecrets(line);
  assert.ok(performance.now() - started < 200, `a 60 KB line took ${Math.round(performance.now() - started)} ms`);
});

test('one redactor (lib/plain-reason.js redactSecrets) for the copied report, the hand-off and the MinerU daemon log: no secret survives, an ordinary line does', async t => {
  const { redactSecrets } = await import('../lib/plain-reason.js');
  for (const [text, secret] of SECRETS) {
    assert.ok(!redactSecrets(text).includes(secret), `${text} -> ${redactSecrets(text)}`);
    assert.ok(!uiMod.redactDiagnosticText(text).includes(secret), `copied report: ${text}`);
  }
  // A log line is kept as it was, and a path keeps its drive and depth: path-too-long and not-writable are read from it.
  for (const line of ["  Building wheel for pillow (pyproject.toml): finished with status 'done'", 'D:\\StudyHub\\MinerU\\home\\config.yaml', 'max_tokens=4096 tokenizer: bert-base', 'Basic setup complete',
    'File "site-packages/huggingface_hub/file_download.py", line 1010, in hf_hub_download'])
    assert.equal(redactSecrets(line), line);
  assert.equal(redactSecrets('C:\\Users\\EricW\\AppData\\Local\\x.log'), '%USERPROFILE%\\AppData\\Local\\x.log');
  assert.equal(redactSecrets('/home/ericw/.mineru/x'), '~/.mineru/x');
  // The hand-off input says nothing a summary could hide either: status, stage and code go through the same redactor.
  const { input } = uiMod.mineruDiagnostic({ shown: { state: 'error password=hunter2', code: 'token=abcdefgh', origin: 'install' }, install: { step: 5, stage: 'enable' }, stageLabel: 'secret_key=abc123' });
  assert.ok(!JSON.stringify(input).includes('hunter2') && !JSON.stringify(input).includes('abcdefgh') && !JSON.stringify(input).includes('abc123'), JSON.stringify(input));
  // The daemon log the MinerU install shows is redacted by the same rules.
  const { mkdtemp, mkdir: makeDir, writeFile: write, rm: remove } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { readMineruServerLogs } = await import('../lib/mineru-local.js');
  const home = await mkdtemp(join(tmpdir(), 'study-redact-home-'));
  t.after(() => remove(home, { recursive: true, force: true }));
  await makeDir(join(home, 'logs'), { recursive: true });
  await write(join(home, 'logs', 'doclib.stderr.log'), `${SECRETS.map(([text]) => text).join('\n')}\n`, 'utf8');
  const shown = await readMineruServerLogs(home, { maxLines: 100, maxChars: 100_000 });
  for (const [text, secret] of SECRETS) assert.ok(!shown.includes(secret), `daemon log: ${text}`);
});

test('the log tail of a report is bounded in characters too: each line and the whole log keep their END', () => {
  const long = `${'x'.repeat(5000)}END-OF-LINE`;
  const report = uiMod.mineruDiagnostic({ shown: { state: 'error', code: 'service-failed', origin: 'install' }, install: { log: [long, ...Array.from({ length: 39 }, (_, at) => `${'y'.repeat(390)} line ${at}`)] } });
  assert.ok(report.input.log.length <= 6000, `log is ${report.input.log.length} characters`);
  assert.ok(report.input.log.endsWith('line 38'), 'the end of the log is kept');
  assert.ok(report.input.log.split('\n').every(line => line.length <= 400), 'no line is longer than 400 characters');
  const one = uiMod.mineruDiagnostic({ shown: { state: 'error', code: 'service-failed', origin: 'install' }, install: { log: [long] } });
  assert.ok(one.input.log.endsWith('END-OF-LINE') && one.input.log.length <= 400, 'a long line keeps its end');
});

test('the live-local hand-off names the tool that owns audio.import (study_audio) and asks before sending a recording to cloud transcription', () => {
  const zh = uiMod.handOffText('setup.failed', { tool: 'live-local', status: 'error' }, 'zh');
  const en = uiMod.handOffText('setup.failed', { tool: 'live-local', status: 'error' }, 'en');
  assert.match(zh, /先问我是否改用云端转写，再用 study_audio 的 audio\.import 导入/);
  assert.match(en, /ask me whether to use cloud transcription instead, then import it with study_audio audio\.import/);
  assert.doesNotMatch(`${zh}\n${en}`, /study_materials\S* (?:的 )?audio\.import/);
});

test('LiveLocalCard, LiveLoopbackCard, ExtensionPanel, ExtensionNotStarted, and MarkerSettings wire 复制诊断信息 + setup.failed without extra primary buttons or Chinese in English', () => {
  const callStub = async () => ({});
  const localBase = {
    status: 'failed', stage: 'check', stages: ['engine', 'model', 'check'], done: ['engine', 'model'], step: 3, of: 3,
    folder: 'D:\\StudyHub\\LiveLocal', installedFolder: '', installed: false, ready: false, supported: true, tested: true,
    engineVersion: '1.13.8', downloadMb: 239, diskMb: 253, modelMb: 228, log: ['vcruntime140.dll missing'],
    error: { code: 'vc-runtime', message: LIVE_LOCAL_MESSAGES.vcRuntime },
  };
  const localPlan = { ok: true, problems: [], warnings: [], folder: 'D:\\StudyHub\\LiveLocal', defaultFolder: 'D:\\StudyHub\\LiveLocal', platform: 'win32', supported: true, tested: true, drives: [], disk: { freeMb: 50_000, neededMb: 600, drive: 'D:' }, estimate: { downloadMb: 239, diskMb: 253 }, files: [] };

  const vcZh = render(h(uiMod.LiveLocalCard, { call: callStub, initialStatus: localBase, initialPlan: localPlan }));
  assert.equal(primaries(vcZh), 1);
  assert.match(textOf(vcZh), /下载 VC\+\+ 运行库[\s\S]*重试[\s\S]*复制诊断信息[\s\S]*发给主会话/);
  assert.match(vcZh, /data-hand-off="setup\.failed"/);
  assert.doesNotMatch(textOf(render(h(uiMod.LiveLocalCard, { call: callStub, initialStatus: localBase, initialPlan: localPlan }), 'en')), han);

  const longPathLocalZh = render(h(uiMod.LiveLocalCard, {
    call: callStub,
    initialStatus: { ...localBase, error: { code: 'path-too-long', message: LIVE_LOCAL_MESSAGES.pathTooLong } },
    initialPlan: localPlan,
  }));
  assert.match(textOf(longPathLocalZh), /换位置/);
  assert.doesNotMatch(textOf(render(h(uiMod.LiveLocalCard, {
    call: callStub,
    initialStatus: { ...localBase, error: { code: 'path-too-long', message: LIVE_LOCAL_MESSAGES.pathTooLong } },
    initialPlan: localPlan,
  }), 'en')), han);

  const loopbackFailed = {
    status: 'failed', stage: 'compile', stages: ['compile', 'check'], done: [], step: 1, of: 2,
    folder: 'D:\\StudyHub\\LiveLoopback', installedFolder: '', installed: false, ready: false, supported: true, tested: true,
    helperVersion: '1.0.0', downloadMb: 0, diskMb: 1, log: ['CS0016'],
    error: { code: 'path-too-long', message: LIVE_LOOPBACK_MESSAGES.pathTooLong },
  };
  const loopZh = render(h(uiMod.LiveLoopbackCard, { call: callStub, initialStatus: loopbackFailed, initialPlan: localPlan }));
  assert.equal(primaries(loopZh), 1);
  assert.match(textOf(loopZh), /换位置[\s\S]*复制诊断信息[\s\S]*发给主会话/);
  assert.match(loopZh, /data-hand-off="setup\.failed"/);
  assert.doesNotMatch(textOf(render(h(uiMod.LiveLoopbackCard, { call: callStub, initialStatus: loopbackFailed, initialPlan: localPlan }), 'en')), han);

  const extRunning = { selected: 'builtin', effective: 'builtin', hostCanSearch: true, providers: [], otherTools: [], extension: { canInstall: true, installed: true, enabled: true, version: '2.1.1', desktop: false }, companion: { id: 'mcp:q', running: true } };
  const extFailedZh = render(h(uiMod.ExtensionPanel, {
    status: extRunning, courses: ['OS'], defaultCourse: 'OS',
    initialPlan: { course: 'OS', pages: 10, toIndex: 10, unchanged: 0, toRemove: 0, chars: 5000, firstRun: true, modelMb: 90, canIndex: true },
    initialRun: { status: 'failed', error: 'network reset', errorCode: 'retrieval-model-download' },
  }));
  assert.match(textOf(extFailedZh), /复制诊断信息[\s\S]*发给主会话/);
  assert.match(extFailedZh, /data-hand-off="setup\.failed"/);

  const notStartedStatus = { ...extRunning, companion: { id: 'mcp:q', running: false, notStarted: true } };
  const notStartedZh = render(h(uiMod.ExtensionNotStarted, { status: notStartedStatus, refresh: callStub, repair: callStub }));
  assert.match(textOf(notStartedZh), /复制诊断信息[\s\S]*发给主会话/);
  assert.doesNotMatch(textOf(render(h(uiMod.ExtensionNotStarted, { status: notStartedStatus, refresh: callStub, repair: callStub }), 'en')), han);

  const markerSettingsEn = render(h(uiMod.MarkerSettings, { available: true }), 'en');
  assert.doesNotMatch(textOf(markerSettingsEn), han);
});

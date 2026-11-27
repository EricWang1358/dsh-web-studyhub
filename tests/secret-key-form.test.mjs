import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

// #118: one key form for every secret (audio providers, Jev, later MinerU): paste, save (and check), check a saved
// key, clear it unless the environment supplies it.
const m = await loadUi(`
  export * from './ui/components/index.js';
  export { submitSecret, clearSecret } from './ui/components/SecretKeyForm.jsx';
  export { default as AudioSettings } from './ui/AudioSettings.jsx';
  export { default as JevSettings } from './ui/JevSettings.jsx';
  export { default as MineruSettings } from './ui/MineruSettings.jsx';
  export { default as MineruInstallCard } from './ui/MineruInstallCard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (props, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(h(m.SecretKeyForm, { name: 'audio-key', label: '密钥', placeholder: '粘贴密钥', onSave() {}, ...props })); } finally { m.setUiLanguage('zh'); } };
const saved = (extra = {}) => ({ set: true, hint: '••••abcd', source: 'file', ...extra });
const resultText = (result) => (result.ok ? '可用' : `不可用：${result.message}`);

test('the library exports the secret key form', () => {
  assert.equal(typeof m.SecretKeyForm, 'function');
});

test('an empty form is one password field with a disabled save button and nothing else to do', () => {
  const out = render({ saved: { set: false, hint: '' } });
  assert.equal((out.match(/type="password"/g) || []).length, 1);
  assert.match(out, /name="audio-key"/);
  assert.match(out, /aria-label="密钥"/);
  assert.match(out, /placeholder="粘贴密钥"/);
  assert.match(out, /autoComplete="off"|autocomplete="off"/i);
  assert.match(out, /<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/, 'nothing pasted yet');
  assert.doesNotMatch(out, />验证</);
  assert.doesNotMatch(out, /清除/);
});

test('a saved key shows its hint in the placeholder and offers check and clear', () => {
  const out = render({ saved: saved(), onVerify() {}, onClear() {} });
  assert.match(out, /placeholder="已保存 ••••abcd；粘贴新的会替换它"/);
  assert.match(out, />验证</);
  assert.match(out, />清除已保存的密钥</);
  assert.match(out, /sh-secret__clear/);
});

test('without a check function there is no check button; without a clear function no clear button', () => {
  const out = render({ saved: saved() });
  assert.doesNotMatch(out, />验证</);
  assert.doesNotMatch(out, /清除/);
});

test('a key from the environment cannot be cleared here, and the form says why', () => {
  const out = render({ saved: saved({ source: 'env' }), onVerify() {}, onClear() {} });
  assert.doesNotMatch(out, /清除已保存的密钥/);
  assert.match(out, /来自环境变量/);
  assert.match(out, />验证</, 'it can still be checked');
  const quiet = render({ saved: saved({ source: 'env' }), onVerify() {}, onClear() {}, envNote: false });
  assert.doesNotMatch(quiet, /来自环境变量/, 'a page that explains the source itself can turn the note off');
});

test('canClear: false hides the clear button for any other reason', () => {
  assert.doesNotMatch(render({ saved: saved(), onClear() {}, canClear: false }), /清除已保存的密钥/);
});

test('labels of the buttons can be named by the page', () => {
  const out = render({ saved: saved(), onVerify() {}, onClear() {}, saveLabel: '保存 Jev 密钥', verifyLabel: '验证 Jev 密钥', clearLabel: '清除令牌' });
  assert.match(out, />保存 Jev 密钥</);
  assert.match(out, />验证 Jev 密钥</);
  assert.match(out, />清除令牌</);
});

test('a check result is shown through resultText, as an alert when it failed and as status when it passed', () => {
  const ok = render({ saved: saved(), onVerify() {}, resultText, initialResult: { ok: true } });
  assert.match(ok, /role="status"[^>]*>|sh-inline--success/);
  assert.match(ok, />可用</);
  const bad = render({ saved: saved(), onVerify() {}, resultText, initialResult: { ok: false, message: '密钥无效' } });
  assert.match(bad, /role="alert"/);
  assert.match(bad, /不可用：密钥无效/);
  assert.match(bad, /aria-describedby="[^"]+"/, 'the field points at the message');
});

test('a page that runs the steps itself passes the result and what is working; the form only shows them', () => {
  const out = render({ saved: saved(), onVerify() {}, resultText, result: { ok: false, message: '被拒绝' }, working: 'verify' });
  assert.match(out, /不可用：被拒绝/);
  assert.match(out, /aria-busy="true"/, 'the verify button shows it is working');
  assert.match(out, /<input[^>]*disabled=""/, 'and nothing else can be started meanwhile');
  assert.doesNotMatch(render({ saved: saved(), onVerify() {}, resultText, result: null, initialResult: { ok: true } }), /可用/, 'a passed result wins over the first-render one');
});

test('a key without a hint (it comes from the environment) shows the page placeholder, not an empty hint', () => {
  const out = render({ saved: { set: true, hint: '', source: 'env' }, placeholder: '粘贴密钥', onVerify() {} });
  assert.match(out, /placeholder="粘贴密钥"/);
  assert.doesNotMatch(out, /已保存/);
});

test('a footnote sits under the form and the whole form can be disabled', () => {
  const out = render({ saved: saved(), onVerify() {}, onClear() {}, footnote: h('p', { className: 'extra-note' }, '只保存在这台电脑'), busy: true });
  assert.match(out, /extra-note[^>]*>只保存在这台电脑/);
  assert.match(out, /<input[^>]*disabled=""/);
  assert.equal((out.match(/disabled=""/g) || []).length >= 4, true, 'input and every button');
});

test('English: nothing in the form itself is Chinese', () => {
  const out = render({ saved: saved({ source: 'env' }), onVerify() {}, onClear() {}, label: 'Key', placeholder: 'Paste', resultText: () => 'ok', initialResult: { ok: true } }, 'en');
  assert.doesNotMatch(out, han);
  assert.doesNotMatch(render({ saved: saved(), onVerify() {}, onClear() {}, label: 'Key', placeholder: 'Paste' }, 'en'), han);
});

test('submitSecret saves, then checks the saved key and returns the result', async () => {
  const log = [];
  const outcome = await m.submitSecret({ key: '  sk-123  ', onSave: async key => { log.push(['save', key]); return { ok: 1 }; }, onVerify: async () => { log.push(['verify']); return { ok: true }; } });
  assert.deepEqual(log, [['save', 'sk-123'], ['verify']], 'the key is trimmed, saved, then checked');
  assert.deepEqual(outcome, { saved: { ok: 1 }, result: { ok: true } });
});

test('the field is emptied as soon as the key is saved, even when the check then fails', async () => {
  const log = [];
  await assert.rejects(m.submitSecret({ key: 'k', onSave: async () => log.push('save'), afterSave: () => log.push('empty'), onVerify: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(log, ['save', 'empty']);
});

test('submitSecret does not check when the page says not to, or has nothing to check with', async () => {
  const log = [];
  const quiet = await m.submitSecret({ key: 'k', onSave: async () => log.push('save'), onVerify: async () => log.push('verify'), verifyAfterSave: false });
  assert.deepEqual(log, ['save']);
  assert.equal(quiet.result, null);
  assert.equal((await m.submitSecret({ key: 'k', onSave: async () => {} })).result, null);
});

test('submitSecret ignores an empty paste and lets a failed save fail the whole step', async () => {
  let calls = 0;
  assert.equal(await m.submitSecret({ key: '   ', onSave: async () => { calls += 1; } }), null);
  assert.equal(calls, 0);
  const log = [];
  await assert.rejects(m.submitSecret({ key: 'k', onSave: async () => { throw new Error('format'); }, onVerify: async () => log.push('verify') }), /format/);
  assert.deepEqual(log, [], 'a key that did not save is not checked');
});

test('clearSecret clears through the page callback and refuses an environment key', async () => {
  const log = [];
  await m.clearSecret({ saved: saved(), onClear: async () => log.push('clear') });
  assert.deepEqual(log, ['clear']);
  await m.clearSecret({ saved: saved({ source: 'env' }), onClear: async () => log.push('again') });
  await m.clearSecret({ saved: saved(), onClear: async () => log.push('never'), canClear: false });
  assert.deepEqual(log, ['clear'], 'an environment key or canClear:false is never cleared');
});

test('the audio and Jev settings use the shared form; MinerU has no key at all (its token went with the cloud route in 3.5.5)', () => {
  const renderWithStudy = (element) => renderToStaticMarkup(withStudy(m.StudyServicesContext, element));

  const audioView = {
    freeKey: { set: false, hint: '' },
    paidKey: { set: false, hint: '' },
    groqKey: { set: false, hint: '' },
    siliconflowKey: { set: false, hint: '' },
    settingsFile: '',
    textProvider: 'auto',
    mode: 'SMART',
    partMinutes: 45,
    textConcurrency: 3,
    proofreadReasoning: 'default',
    translateReasoning: 'low',
    transcribeModel: 'gemini-2.5-flash',
    textModel: 'gemini-2.5-flash',
    groqTranscribeModel: 'whisper-large-v3',
    groqTextModel: 'openai/gpt-oss-120b',
    siliconflowTranscribeModel: 'FunAudioLLM/SenseVoiceSmall',
    liveModel: 'gemini-2.5-flash-live',
    liveTranslateModel: 'gemini-2.5-flash-lite',
    liveCorrectionReasoning: 'low',
    liveProvider: 'auto',
    liveSentencePause: 'standard',
    dailyLimits: {},
  };
  const audioHtml = renderWithStudy(h(m.AudioSettings, { initialView: audioView, initialLocal: null, initialLoopback: null }));
  assert.equal((audioHtml.match(/class="sh-secret(?:\s|")/g) || []).length, 4, 'AudioSettings renders shared SecretKeyForm for 3 providers + paid key');
  assert.equal((audioHtml.match(/type="password"/g) || []).length, 4, 'AudioSettings renders exactly 4 password inputs via SecretKeyForm');
  assert.doesNotMatch(audioHtml, /audio-key-(form|input|actions|foot|clear)/, 'the audio page does not reuse the old form classes');

  const jevSettings = {
    key: { set: false, hint: '', source: '' },
    confirmed: false,
    confirmedAt: '',
    enabled: false,
    features: { courseSuggest: false, preReview: false, outlineNoise: false, levelCheck: false },
    threshold: 0.8,
    privacyUrl: 'https://docs.typesafe.ai/legal',
    docsUrl: 'https://docs.typesafe.ai',
    settingsFile: '',
  };
  const jevHtml = renderWithStudy(h(m.JevSettings, { initial: { settings: jevSettings, usage: null, failure: null } }));
  assert.equal((jevHtml.match(/class="sh-secret(?:\s|")/g) || []).length, 1, 'JevSettings renders shared SecretKeyForm');
  assert.equal((jevHtml.match(/type="password"/g) || []).length, 1, 'JevSettings renders exactly 1 password input via SecretKeyForm');
  assert.match(jevHtml, /name="jev-key"/, 'JevSettings password input uses jev-key');

  const mineruLocal = {
    state: 'not-installed',
    next: 'install',
    origin: null,
    install: { status: 'idle', stage: '', stages: ['tools', 'python', 'package', 'models', 'enable', 'check'], done: [], step: 0, of: 6, folder: '', installedFolder: '', installed: false, tier: '', source: null, log: [], error: null },
    lastError: null,
    external: null,
  };
  const mineruPlan = {
    ok: true,
    problems: [],
    warnings: [],
    folder: '/tmp/StudyHub-MinerU',
    adjusted: false,
    existing: false,
    defaultFolder: '/tmp/StudyHub-MinerU',
    defaultReason: 'largest-data-drive',
    platform: 'linux',
    drives: [],
    disk: { freeMb: 50_000, neededMb: 4000, drive: '/' },
    estimate: { downloadMb: 1300, minutes: [10, 30] },
    tier: 'basic',
    tiers: [{ id: 'basic', modelsMb: 800, secondsPerPage: 1.6 }, { id: 'standard', modelsMb: 2000, secondsPerPage: 2.5 }],
    ramMb: 16_384,
    source: { id: 'mainland', chosenBy: 'auto', reason: 'faster', hosts: [] },
    pythons: [],
    python: '',
    external: null,
    commands: [],
  };
  // The install card is a different screen in every state (offer, progress, problem, ready): none of them may grow a key field.
  const mineruScenarios = [
    ['not-installed', { state: 'not-installed' }],
    ['installing', { state: 'installing', install: { ...mineruLocal.install, status: 'running', stage: 'package', done: ['tools', 'python'], step: 2 } }],
    ['paused', { state: 'not-installed', install: { ...mineruLocal.install, status: 'cancelled', stage: 'package', done: ['tools', 'python'], step: 2 } }],
    ['stopped', { state: 'server-stopped', next: 'start' }],
    ['ready', { state: 'ready', next: 'parse' }],
    ['error', { state: 'server-stopped', lastError: { code: 'start-failed', message: 'boom' } }],
  ];
  for (const [state, overrides] of mineruScenarios) {
    const local = { ...mineruLocal, ...overrides };
    for (const initialMore of [false, true]) {
      const where = `state=${state}, initialMore=${initialMore}`;
      const mineruSettingsHtml = renderWithStudy(h(m.MineruSettings, { initialLocal: local, initialPlan: mineruPlan, initialMore }));
      assert.match(mineruSettingsHtml, /class="[^"]*mineru-settings/, `MineruSettings renders (${where})`);
      assert.match(mineruSettingsHtml, new RegExp(`data-state="${state}"`), `MineruSettings shows the ${state} card (${where})`);
      assert.doesNotMatch(mineruSettingsHtml, /type="password"/, `MineruSettings has no password input (${where})`);
      assert.doesNotMatch(mineruSettingsHtml, /sh-secret/, `MineruSettings has no SecretKeyForm (${where})`);

      const mineruCardHtml = renderWithStudy(h(m.MineruInstallCard, { initialLocal: local, initialPlan: mineruPlan, initialMore }));
      assert.match(mineruCardHtml, /class="[^"]*mineru-install/, `MineruInstallCard renders (${where})`);
      assert.match(mineruCardHtml, new RegExp(`data-state="${state}"`), `MineruInstallCard shows the ${state} card (${where})`);
      assert.doesNotMatch(mineruCardHtml, /type="password"/, `MineruInstallCard has no password input (${where})`);
      assert.doesNotMatch(mineruCardHtml, /sh-secret/, `MineruInstallCard has no SecretKeyForm (${where})`);
    }
  }
});

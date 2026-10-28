/* The live class's local engine gallery (QA only), built and screenshotted by scripts/qa/live-local-shots.mjs.
   Query: ?lang=zh|en&theme=dark|light&scene=live|settings|flow&case=<key>
   scene=live&case=<key>: 课堂实录 with fixed answers (no backend): gate (no key, local not installed), gate-installing, gate-failed, gate-gemini (no local engine
     for this computer), choice (a key and the local engine: the per-class choice), local (the local engine only: the start form says so);
   scene=settings&case=<key>: Settings › 音频转写's live engine choice with the local card: missing, installing, ready, checksum;
   scene=flow: 课堂实录's gate talking to the QA server, where the REAL installer (lib/live-local-install.js) runs with tiny pinned files and a slow fake fetch. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage } from '../../ui/i18n.js';
import LiveClass from '../../ui/LiveClass.jsx';
import { LiveEngineChoice } from '../../ui/AudioSettings.jsx';
import { StudyServicesContext } from '../../ui/study-context.jsx';
import { AppContext } from '../../ui/app/app-context.js';
import { fakeApp } from '../../tests/helpers/fake-app.mjs';
import { LIVE_LOCAL_MESSAGES as TEXT } from '../../lib/live-local-install-text.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'live';
const which = params.get('case') || 'gate';
setUiLanguage(lang);

const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { min-height: 100%; margin: 0; }
  .gallery { max-width: 960px; margin: 0 auto; padding: 24px 20px 64px; }
  @media (max-width: 480px) { .gallery { padding: 16px 16px 48px; } }`;
document.head.appendChild(style);

const FOLDER = 'D:\\StudyHub\\LiveLocal';
const drives = [{ root: 'C:\\', freeMb: 41_000, totalMb: 255_000, system: true, recommended: false, folder: 'C:\\StudyHub\\LiveLocal' },
  { root: 'D:\\', freeMb: 118 * 1024, totalMb: 476_000, system: false, recommended: true, folder: FOLDER }];
const plan = { ok: true, problems: [], warnings: [], folder: FOLDER, defaultFolder: FOLDER, defaultReason: 'largest-data-drive', platform: 'win32', supported: true, tested: true,
  drives, disk: { freeMb: 118 * 1024, neededMb: 600, drive: 'D:' }, estimate: { downloadMb: 239, diskMb: 253 }, files: [] };
const idle = { status: 'idle', stage: '', stages: ['engine', 'model', 'check'], done: [], step: 0, of: 3, folder: '', installedFolder: '', installed: false, ready: false,
  supported: true, tested: true, engineVersion: '1.13.8', downloadMb: 239, diskMb: 253, modelMb: 228, log: [], error: null };
const STATUS = {
  missing: idle,
  installing: { ...idle, status: 'running', stage: 'model', step: 2, done: ['engine'], folder: FOLDER, stageFraction: 0.46 },
  checksum: { ...idle, status: 'failed', stage: 'model', step: 2, done: ['engine'], folder: FOLDER, error: { code: 'checksum', message: TEXT.checksum } },
  ready: { ...idle, status: 'complete', stage: 'done', step: 3, done: ['engine', 'model', 'check'], folder: FOLDER, installedFolder: FOLDER, installed: true, ready: true },
  unsupported: { ...idle, supported: false },
};
const readiness = (extra) => ({ providers: { free: false, siliconflow: false, groq: false, paid: false }, transcription: false, textProvider: 'host', liveChoice: 'auto', ...extra });
const LIVE = {
  gate: { readiness: readiness({ live: false, liveProvider: null, liveReason: 'no-provider', liveLocal: { supported: true, ready: false } }), local: STATUS.missing },
  'gate-installing': { readiness: readiness({ live: false, liveProvider: null, liveReason: 'no-provider', liveLocal: { supported: true, ready: false } }), local: STATUS.installing },
  'gate-failed': { readiness: readiness({ live: false, liveProvider: null, liveReason: 'no-provider', liveLocal: { supported: true, ready: false } }), local: STATUS.checksum },
  'gate-gemini': { readiness: readiness({ live: false, liveProvider: null, liveReason: 'no-provider', liveLocal: { supported: false, ready: false } }), local: STATUS.unsupported },
  choice: { readiness: readiness({ live: true, liveProvider: 'gemini', providers: { free: true, siliconflow: false, groq: false, paid: false }, liveLocal: { supported: true, ready: true } }), local: STATUS.ready },
  local: { readiness: readiness({ live: true, liveProvider: 'local', liveLocal: { supported: true, ready: true } }), local: STATUS.ready },
};

const never = new Promise(() => {});
function fixedCall(local) {
  return async (action) => {
    if (action === 'live.local.status') return local ?? never;
    if (action === 'live.local.plan') return plan;
    if (action === 'live.list') return { sessions: [] };
    if (action === 'audio.preflight') return LIVE[which]?.readiness;
    return {};
  };
}
async function postCall(action, args) {
  const response = await fetch('/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
  const body = await response.json();
  if (!body.ok) throw Object.assign(new Error(body.error), { code: body.code });
  return body.value;
}

const spec = scene === 'settings' ? { local: STATUS[which] } : LIVE[which] || LIVE.gate;
const call = scene === 'flow' ? postCall : fixedCall(spec.local);
const services = { call, act: async (action, args) => call(action, args), busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {} };
const data = { root: '/library', focus: { course: '', courses: [] } };
const flowReadiness = readiness({ live: false, liveProvider: null, liveReason: 'no-provider', liveLocal: { supported: true, ready: false } });

function Scene() {
  if (scene === 'settings') return <main className="gallery"><section className="audio-settings">
    <LiveEngineChoice view={{ liveProvider: 'auto' }} onSave={() => {}} initialLocal={spec.local} /></section></main>;
  return <main className="gallery"><AppContext.Provider value={fakeApp({ data, call })}>
    <LiveClass call={call} data={data} visible onSettings={() => {}} initialReadiness={scene === 'flow' ? flowReadiness : spec.readiness}
      initialLocal={scene === 'flow' ? null : spec.local} /></AppContext.Provider></main>;
}

createRoot(document.getElementById('root')).render(<div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'}>
  <StudyServicesContext.Provider value={services}><Scene /></StudyServicesContext.Provider></div>);

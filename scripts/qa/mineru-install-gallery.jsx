/* One-click MinerU gallery (QA only), built and screenshotted by scripts/qa/mineru-install-shots.mjs.
   Query: ?lang=zh|en&theme=dark|light&scene=settings|import|job|large|flow&case=<key>
   scene=settings&case=<key>: 设置 › PDF 转换 in ONE state, with fixed answers (no backend);
   scene=import&case=<key>: the import dialog's PDF conversion with a PDF chosen, MinerU in that state (the compact card inline);
   scene=job: a conversion card while the run starts the stopped service; scene=large: the large-textbook card's converter;
   scene=flow: Settings talking to the QA server, where the REAL installer (lib/mineru-install.js) runs against a local index, a fake uv and the fake mineru. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage } from '../../ui/i18n.js';
import MineruSettings from '../../ui/MineruSettings.jsx';
import PdfConversion from '../../ui/PdfConversion.jsx';
import { PdfConvertJobs, PdfDetail } from '../../ui/PdfConvertJob.jsx';
import { ConverterMain } from '../../ui/LargeDocumentCard.jsx';
import { StudyServicesContext } from '../../ui/study-context.jsx';
import { MINERU_INSTALL_MESSAGES as TEXT } from '../../lib/mineru-install-text.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'settings';
const which = params.get('case') || 'missing';
setUiLanguage(lang);

const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { min-height: 100%; margin: 0; }
  .gallery { max-width: 880px; margin: 0 auto; padding: 24px 20px 64px; }
  @media (max-width: 480px) { .gallery { padding: 16px 16px 48px; } }`;
document.head.appendChild(style);

const FOLDER = 'D:\\StudyHub\\MinerU';
const STAGES = ['tools', 'python', 'package', 'models', 'enable', 'check'];
const drives = [{ root: 'C:\\', freeMb: 41_000, totalMb: 255_000, system: true, recommended: false, folder: 'C:\\StudyHub\\MinerU' },
  { root: 'D:\\', freeMb: 118 * 1024, totalMb: 476_000, system: false, recommended: true, folder: FOLDER },
  { root: 'E:\\', freeMb: 2100, totalMb: 30_000, system: false, recommended: false, folder: 'E:\\StudyHub\\MinerU' }];
const plan = (extra = {}) => ({ ok: true, problems: [], warnings: [], folder: FOLDER, adjusted: false, existing: false, defaultFolder: FOLDER, defaultReason: 'largest-data-drive', platform: 'win32',
  drives, disk: { freeMb: 118 * 1024, neededMb: 4000, drive: 'D:' }, estimate: { downloadMb: 1300, minutes: [10, 30] }, tier: 'basic',
  tiers: [{ id: 'basic', modelsMb: 800, secondsPerPage: 1.6 }, { id: 'standard', modelsMb: 2000, secondsPerPage: 2.5 }], ramMb: 8 * 1024,
  source: { id: 'mainland', chosenBy: 'auto', reason: 'overseas-unreachable', hosts: [] }, pythons: [{ version: '3.11.9', path: 'C:\\Users\\student\\AppData\\Local\\Programs\\Python\\Python311\\python.exe' }],
  python: '', external: null,
  commands: [
    { stage: 'tools', command: 'GET https://pypi.tuna.tsinghua.edu.cn/simple/uv/uv-0.13.1-py3-none-win_amd64.whl  (sha256) -> "D:\\StudyHub\\MinerU\\tools\\uv.exe"' },
    { stage: 'python', command: '"D:\\StudyHub\\MinerU\\tools\\uv.exe" venv "D:\\StudyHub\\MinerU\\venv" --python 3.12' },
    { stage: 'package', command: '"D:\\StudyHub\\MinerU\\tools\\uv.exe" pip install --python "D:\\StudyHub\\MinerU\\venv\\Scripts\\python.exe" "mineru>=4.0,<5"' },
    { stage: 'models', command: '"D:\\StudyHub\\MinerU\\venv\\Scripts\\mineru-kit.exe" models download --tier basic --source modelscope' }], ...extra });
const onlyC = plan({ folder: 'C:\\StudyHub\\MinerU', defaultFolder: 'C:\\StudyHub\\MinerU', defaultReason: 'only-system-drive', drives: [drives[0]], disk: { freeMb: 41_000, neededMb: 4000, drive: 'C:' } });
const noSpace = plan({ ok: false, folder: 'E:\\StudyHub\\MinerU', disk: { freeMb: 2100, neededMb: 4000, drive: 'E:' },
  problems: [{ code: 'no-space', message: TEXT.noSpace('E:', '2.1 GB', '3.9 GB') }] });
const idle = { status: 'idle', stage: '', stages: STAGES, done: [], step: 0, of: 6, folder: '', installedFolder: '', installed: false, tier: '', source: null, log: [], error: null };
const at = stage => STAGES.indexOf(stage);
const running = (stage, extra = {}) => ({ ...idle, status: 'running', stage, step: at(stage) + 1, done: STAGES.slice(0, at(stage)), folder: FOLDER, tier: 'basic', source: { id: 'mainland' },
  startedAt: new Date(Date.now() - 140_000).toISOString(), log: ['== tools ==', `== ${stage} ==`], ...extra });
const ended = (status, code, stage, message, extra = {}) => ({ ...idle, status, stage, step: at(stage) + 1, done: STAGES.slice(0, at(stage)), folder: FOLDER, tier: 'basic', source: { id: 'mainland' },
  error: { code, message }, log: ['== tools ==', '(tools: already done)', `== ${stage} ==`, message], ...extra });
const complete = { ...idle, status: 'complete', stage: 'done', step: 6, done: [...STAGES], folder: FOLDER, installedFolder: FOLDER, installed: true, tier: 'basic', mineruVersion: '4.0.12', source: { id: 'mainland' },
  log: ['== check ==', 'mineru server status: ready (basic)'] };
const NETWORK = TEXT.network;
const est = { basic: 1.6, standard: 2.5 };
const local = (state, extra = {}) => ({ state, next: null, origin: null, folder: '', install: idle, lastError: null, external: null, estimates: est, windowPages: 50, ...extra });
const CASES = {
  checking: { local: null },
  missing: { local: local('not-installed'), plan: plan() },
  'only-c': { local: local('not-installed'), plan: onlyC },
  chooser: { local: local('not-installed'), plan: plan(), click: 'choose' },
  'no-space': { local: local('not-installed'), plan: noSpace },
  'installing-2': { local: local('installing', { install: running('python', { lastLine: 'Downloading cpython-3.12.15-windows-x86_64 (21.9MiB)  42%|####      | 9.2M/21.9M', stageFraction: 0.42 }) }) },
  'installing-4': { local: local('installing', { install: running('models', { lastLine: 'Downloading basic models from modelscope  45%|####5     | 360M/800M', stageFraction: 0.45 }) }) },
  cancelled: { local: local('not-installed', { install: ended('cancelled', 'cancelled', 'models', TEXT.cancelled) }) },
  'network-1': { local: local('not-installed', { install: { ...ended('failed', 'network', 'package', NETWORK), attempts: 1 } }), plan: plan() },
  'network-2': { local: local('not-installed', { install: { ...ended('failed', 'network', 'package', NETWORK), attempts: 2 } }), plan: plan() },
  'vc-runtime': { local: local('not-installed', { install: ended('failed', 'vc-runtime', 'enable', TEXT.vcRuntime) }), plan: plan() },
  stopped: { local: local('server-stopped', { origin: 'installed', folder: FOLDER, install: complete, version: '4.0.12' }) },
  ready: { local: local('ready', { origin: 'installed', folder: FOLDER, install: complete, version: '4.0.12', tier: 'basic', running: true }) },
  external: { local: local('ready', { origin: 'search', exe: 'C:\\Users\\student\\.local\\bin\\mineru.exe', version: '4.0.10', tier: 'standard', running: true }) },
  more: { local: local('ready', { origin: 'installed', folder: FOLDER, install: complete, version: '4.0.12', tier: 'basic', running: true }), plan: plan(), more: true },
};
const spec = CASES[which] || CASES.missing;

const never = new Promise(() => {});
function caseCall(entry) {
  return async (action, args = {}) => {
    if (action === 'mineru.local.status') return entry.local === null ? never : entry.local;
    if (action === 'mineru.install.status') return entry.local?.install || idle;
    if (action === 'mineru.install.plan') { const base = entry.plan || plan(); const folder = args.location || base.folder; return { ...base, folder, disk: { ...base.disk, drive: folder.slice(0, 2).toUpperCase() } }; }
    if (action === 'mineru.upload.start') return { uploadId: 'u1', chunkBytes: 64 * 1024 * 1024 };
    if (action === 'mineru.plan') return { name: 'Operating Systems.pdf', pages: 422, bytes: 96 * 1024 * 1024, windows: [], adaptive: { firstPages: 10, rampPages: [10, 20, 20], targetSeconds: 75, minPages: 5, maxPages: 50 } };
    if (action === 'marker.local.status') return { state: 'not-installed', next: 'install' };
    if (action === 'mineru.history.list') return { records: [], total: 0, keepLatest: 50, keepDays: 90 };
    return {};
  };
}
async function postCall(action, args) {
  const response = await fetch('/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
  const body = await response.json();
  if (!body.ok) throw Object.assign(new Error(body.error), { code: body.code });
  return body.value;
}
const call = scene === 'flow' ? postCall : caseCall(spec);
const services = { call, act: async (action, args) => call(action, args), busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {} };
const pdf = new File([new Uint8Array(2048)], 'Operating Systems.pdf', { type: 'application/pdf' });
const noop = () => {};
const startService = { id: 'job-start', type: 'pdf-convert', route: 'local', converter: 'mineru', filename: 'Operating Systems.pdf', status: 'running', phase: 'start-service',
  stage: '正在启动本机 MinerU 服务（第一次约 1 分钟）', done: 0, total: 422, chunk: { index: 0, count: 0 }, chunks: [], warnings: [], note: '', local: { adaptive: true },
  env: { kind: 'local', mineruVersion: '4.0.12', tier: 'basic', model: 'MinerU-4_models_onnx', windows: { kind: 'adaptive', firstPages: 10, targetSeconds: 75, minPages: 5, maxPages: 50 } },
  service: { state: 'stopped', basis: 'check', at: new Date().toISOString() }, startedAt: new Date(Date.now() - 20_000).toISOString() };

function Scene() {
  if (scene === 'import') return <main className="gallery"><PdfConversion file={pdf} call={call} onFile={noop} onOpenSettings={noop} initialLocal={spec.local || undefined} /></main>;
  if (scene === 'job') return <main className="gallery"><PdfConvertJobs call={call} jobs={[startService]} onOpenSettings={noop} /><PdfDetail job={startService} /></main>;
  if (scene === 'large') return <main className="gallery"><ConverterMain call={call} file={pdf} onOpenSettings={noop} /></main>;
  return <main className="gallery"><MineruSettings call={call} initialLocal={scene === 'flow' ? null : spec.local} initialMore={!!spec.more} /></main>;
}
createRoot(document.getElementById('root')).render(<div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'}>
  <StudyServicesContext.Provider value={services}><Scene /></StudyServicesContext.Provider></div>);

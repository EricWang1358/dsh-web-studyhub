/* Marker one-click install gallery (QA only), built and screenshotted by scripts/qa/marker-install-shots.mjs.
   Query: ?lang=zh|en&theme=dark|light&scene=case|flow
   scene=case&case=<key>: the Marker settings in ONE state with fixed answers (no backend).
   scene=flow: the settings with a stand-in transport that posts every call to the QA server, where the REAL installer runs
   against a fake python/pip (no network), so the clicks go through plan, install, cancel, retry, failure, done and uninstall. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage, ui } from '../../ui/i18n.js';
import { SettingsSection } from '../../ui/components/index.js';
import MarkerSettings from '../../ui/MarkerSettings.jsx';
import { StudyServicesContext } from '../../ui/study-context.jsx';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'case';
const which = params.get('case') || 'before';
setUiLanguage(lang);

const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { height: 100%; margin: 0; }
  .gallery { max-width: 760px; margin: 0 auto; padding: 24px 20px 64px; }`;
document.head.appendChild(style);

const FOLDER = 'C:\\Users\\lee\\.dsh\\studyhub\\marker';
const idle = { status: 'idle', stage: '', stages: ['create-venv', 'install', 'verify', 'configure'], folder: '', mirror: '', log: [], error: null, installed: false, installedFolder: '', defaultFolder: FOLDER };
const plan = (extra = {}) => ({ ok: true, problems: [], folder: FOLDER, adjusted: false, existing: false, defaultFolder: FOLDER, platform: 'win32', python: { version: '3.11.4', command: 'py -3' },
  minPython: '3.10', recommendedPython: '3.12', disk: { freeMb: 52_000, neededMb: 4000 }, estimate: { downloadMb: 1500, minutes: [5, 20] }, mirror: 'tsinghua',
  mirrors: [{ id: 'tsinghua', reach: 'mainland', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' }, { id: 'official', reach: 'overseas', url: null }],
  commands: [{ stage: 'create-venv', command: `py -3 -m venv "${FOLDER}\\venv"` }, { stage: 'install', command: `"${FOLDER}\\venv\\Scripts\\python.exe" -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple marker-pdf` }, { stage: 'verify', command: `"${FOLDER}\\venv\\Scripts\\marker_single.exe" --help` }], ...extra });
const channels = [{ id: 'npmmirror', reach: 'mainland', url: 'https://registry.npmmirror.com/binary.html?path=python/' }, { id: 'huawei', reach: 'mainland', url: 'https://mirrors.huaweicloud.com/python/' }, { id: 'official', reach: 'overseas', url: 'https://www.python.org/downloads/' }];
const log = ['$ py -3 -m venv "C:\\Users\\lee\\.dsh\\studyhub\\marker\\venv"', '== install ==', '$ python -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple marker-pdf', 'Collecting marker-pdf', '  Downloading marker_pdf-1.9.0-py3-none-any.whl (200 kB)', 'Collecting torch<3.0.0,>=2.7.0', '  Downloading torch-2.8.0-cp311-cp311-win_amd64.whl (190.4 MB)'];
const marker = `${FOLDER}\\venv\\Scripts\\marker_single.exe`;
const CASES = {
  before: { install: idle, plan: plan(), command: '', state: 'not-installed' },
  missing: { install: idle, plan: plan({ ok: false, python: null, problems: [{ code: 'python-missing', message: '没有找到 Python。请先安装 Python 3.10 或更新版本，装好后再点「一键安装 Marker」。' }], channels }), command: '', state: 'not-installed' },
  nospace: { install: idle, plan: plan({ ok: false, disk: { freeMb: 900, neededMb: 4000 }, problems: [{ code: 'no-space', message: '安装位置所在磁盘的剩余空间不够。请换一个位置，或清理磁盘后重试。' }] }), command: '', state: 'not-installed' },
  running: { install: { ...idle, status: 'running', stage: 'install', folder: FOLDER, mirror: 'tsinghua', startedAt: new Date(Date.now() - 95_000).toISOString(), lastLine: 'Downloading torch-2.8.0-cp311-cp311-win_amd64.whl (190.4 MB)', log }, plan: plan(), command: '', state: 'not-installed' },
  failed: { install: { ...idle, status: 'failed', stage: 'install', folder: FOLDER, mirror: 'official', log: [...log, 'WARNING: Retrying (Retry(total=4)) after connection broken by ReadTimeoutError', 'ERROR: Could not find a version that satisfies the requirement torch (from versions: none)'],
    error: { code: 'network', message: '下载 marker-pdf 失败，多半是网络不通。可以换用「国内直连」的下载源后重试。' } }, plan: plan(), command: '', state: 'not-installed' },
  cancelled: { install: { ...idle, status: 'cancelled', stage: 'install', folder: FOLDER, log, error: { code: 'cancelled', message: '已取消安装。' } }, plan: plan(), command: '', state: 'not-installed' },
  done: { install: { ...idle, status: 'complete', stage: 'done', folder: FOLDER, command: marker, installed: true, installedFolder: FOLDER, needsModels: true, log: ['Successfully installed marker-pdf-1.9.0'] }, plan: plan(), command: marker, state: 'ready' },
  manual: { install: idle, plan: plan(), command: 'C:\\tools\\marker\\Scripts\\marker_single.exe', state: 'ready' },
};

const pickFolder = params.get('pick') || 'D:\\Tools\\marker';
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify() {}, askInChat() {}, host: { pickDirectory: async () => pickFolder }, openSettings() {}, navigate() {}, openModal() {} };

function caseCall(spec) {
  return async (action, args) => {
    if (action === 'marker.settings.get') return { command: spec.command };
    if (action === 'marker.local.status') return { state: spec.state, ...(spec.state === 'ready' ? {} : { next: 'install' }) };
    if (action === 'marker.install.status') return spec.install;
    if (action === 'marker.install.plan') return { ...spec.plan, folder: args.location || spec.plan.folder, mirror: args.mirror || spec.plan.mirror };
    return spec.install;
  };
}
async function postCall(action, args) {
  const response = await fetch('/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error);
  return body.value;
}

function Scene() {
  const call = scene === 'flow' ? postCall : caseCall(CASES[which] || CASES.before);
  return <StudyServicesContext.Provider value={services}><main className="gallery"><SettingsSection title={ui('Marker：本机解析')} tour="settings-marker"><MarkerSettings call={call} /></SettingsSection></main></StudyServicesContext.Provider>;
}
createRoot(document.getElementById('root')).render(<div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'}><Scene /></div>);

import { ui, uiMessage } from '../i18n.js';
import { redactSecrets } from '../../lib/plain-reason.js';

/* Shared diagnostic report formatter (复制诊断信息) and main-chat hand-off input builder (发给主会话, 'setup.failed') across all
   local tool and extension cards: MinerU, Marker, live-local speech engine, live-loopback system-audio helper, and retrieval extension.
   One redactor, one log tailer, and one declarative report builder keep every surface consistent with zero duplicated formatting logic. */

/** The bounds of a log tail in a report: its last lines, each cut to its end, and the whole cut to its end (the cause of a failure is printed last). */
const MAX_LOG_LINES = 40, MAX_LINE_CHARS = 400, MAX_LOG_CHARS = 6000;

/** The one redactor of the server and the client (lib/plain-reason.js), before copying or handing diagnostics to chat. */
export const redactDiagnosticText = redactSecrets;

const lineEnd = line => (line.length > MAX_LINE_CHARS ? line.slice(-MAX_LINE_CHARS) : line);

function tailLines(lines, max = MAX_LOG_LINES) {
  const list = (Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/))
    .map(line => lineEnd(redactDiagnosticText(line).trimEnd()))
    .filter(Boolean);
  return list.slice(-max).join('\n');
}

/** The last whole lines of `text` that fit in MAX_LOG_CHARS. */
function endOf(text) {
  const lines = text.split('\n');
  let length = text.length;
  while (lines.length > 1 && length > MAX_LOG_CHARS) length -= lines.shift().length + 1;
  return lines.join('\n');
}

export function joinLogBlocks(blocks, max = MAX_LOG_LINES) {
  const seen = new Set(), kept = [];
  for (const raw of blocks || []) {
    const chunk = tailLines(raw, max);
    if (!chunk || seen.has(chunk)) continue;
    seen.add(chunk);
    kept.push(chunk);
  }
  return endOf(kept.join('\n\n'));
}

/** Shared plain-text diagnostic layout (`[Tool] summary`, `key: value` facts, and redacted log tail). */
export function formatDiagnosticReport({ label, summary = '', facts = [], log = '' } = {}) {
  const head = [
    `[${label}] ${redactDiagnosticText(summary) || 'error'}`,
    ...facts
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
      .map(([key, value]) => `${key}: ${redactDiagnosticText(value)}`),
  ].join('\n');
  return [head, log].filter(Boolean).join('\n\n');
}

function buildSetupDiagnostic({ tool, label, platform = '', status = 'error', stage = '', code = '', summary = '', facts = [], reportFacts, logs = [] }) {
  const cleanSummary = redactDiagnosticText(summary);
  const log = joinLogBlocks(logs);
  const input = { tool, status: redactDiagnosticText(status), stage: redactDiagnosticText(stage), code: redactDiagnosticText(code), summary: cleanSummary, log };
  for (const [key, value] of facts) {
    if (value !== undefined && value !== null && String(value) !== '') input[key] = redactDiagnosticText(value);
  }
  const text = formatDiagnosticReport({
    label,
    summary: cleanSummary || code || status,
    facts: [
      ['code', code],
      ['status', status],
      ['stage', stage],
      ['platform', platform],
      ...(reportFacts || facts),
    ],
    log,
  });
  return { input, text };
}

/** The Tooltip sentence for 'setup.failed' hand-offs across local setup and companion error states. */
export const SETUP_FAILED_WHAT = '把报错和诊断信息发给主会话，让它先查清原因；它可以一步步修这台电脑上的环境，结束进程、删除文件或改权限之前会先问你';

/** Diagnostic bundle `{ input, text }` for MinerU install, service, or check errors. */
export function mineruDiagnostic({ view, install, plan, shown, summary = '', stageLabel = '' } = {}) {
  const code = shown?.code || install?.error?.code || view?.lastError?.code || '';
  const status = shown?.origin ? `${shown.state || 'error'} (${shown.origin})` : shown?.state || view?.state || 'error';
  const stage = shown?.origin === 'install' && install?.stage ? `${Math.max(1, install.step || 1)}/6 ${stageLabel || install.stage}` : '';
  const facts = [
    ['folder', install?.folder || install?.installedFolder || view?.folder || plan?.folder || ''],
    ['tier', install?.tier || install?.installedTier || view?.tier || plan?.tier || ''],
    ['source', install?.source?.id || plan?.source?.id || ''],
    ['python', install?.python || plan?.python || ''],
    ['version', view?.version || install?.mineruVersion || ''],
    ['external', view?.external?.exe || ''],
    ['attempts', install?.attempts > 1 ? install.attempts : ''],
    // Who installed the MinerU this failure is about, the card's own `ours` (MineruInstallCard.jsx): StudyHub's unfinished install, or the one it installed, or
    // nothing found yet; otherwise a MinerU found through MINERU_BIN or the PATH, whose folders StudyHub never changes (the prompt's repairs differ, #942).
    ['installedBy', shown?.origin === 'install' || !view?.origin || view.origin === 'installed' ? 'studyhub' : 'other'],
  ];
  return buildSetupDiagnostic({ tool: 'mineru', label: 'MinerU', platform: plan?.platform || '', status, stage, code, summary, facts, logs: [view?.lastError?.detail, install?.log] });
}
export const mineruHandOffInput = (args = {}) => mineruDiagnostic(args).input;
export const mineruDiagnosticText = (args = {}) => mineruDiagnostic(args).text;

/** Diagnostic bundle `{ input, text }` for Marker install, Docker/check, or manual-path errors. */
export function markerDiagnostic({ install, plan, markerStatus, command = '', summary = '', stageLabel = '', mirror = '' } = {}) {
  const problem = plan?.problems?.[0] || null;
  const code = install?.error?.code || (markerStatus?.state && markerStatus.state !== 'ready' ? markerStatus.state : '') || problem?.code || '';
  const status = install?.status && install.status !== 'idle'
    ? install.status
    : markerStatus?.state && markerStatus.state !== 'ready'
      ? markerStatus.state
      : problem ? 'blocked' : 'error';
  const stage = install?.stage && install.stage !== 'done' ? (stageLabel || install.stage) : '';
  const python = plan?.python
    ? `${plan.python.version} (${plan.python.command})`
    : plan?.tooNewPython
      ? `${plan.tooNewPython} (>${plan.maxPython || '3.13'})`
      : '';
  const folder = install?.folder || install?.installedFolder || plan?.folder || '';
  const source = install?.mirror || mirror || plan?.mirror || '';
  const resolvedCommand = command || install?.command || markerStatus?.command || '';
  const cause = summary
    || (install?.error?.message ? uiMessage(install.error.message) : '')
    || (markerStatus?.message ? uiMessage(markerStatus.message) : '')
    || (problem?.message ? uiMessage(problem.message) : '')
    || (markerStatus?.state === 'not-ready' ? ui('Marker 尚未就绪') : '');
  return buildSetupDiagnostic({
    tool: 'marker', label: 'Marker', platform: plan?.platform || '', status, stage, code, summary: cause,
    facts: [['folder', folder], ['source', source], ['python', python], ['command', resolvedCommand]],
    reportFacts: [['folder', folder], ['mirror', source], ['python', python], ['command', resolvedCommand]],
    logs: [install?.log, markerStatus?.detail],
  });
}
export const markerHandOffInput = (args = {}) => markerDiagnostic(args).input;
export const markerDiagnosticText = (args = {}) => markerDiagnostic(args).text;

/** Diagnostic bundle `{ input, text }` for the local live transcription engine (`LiveLocalCard`). */
export function liveLocalDiagnostic({ status: raw, plan, shown, modelId = '', summary = '', stageLabel = '', error = '' } = {}) {
  const problem = plan?.problems?.[0] || null;
  const code = shown?.code || raw?.error?.code || problem?.code || (shown?.state === 'repair' ? 'needs-repair' : '');
  const state = shown?.state && shown.state !== 'not-installed' ? shown.state : problem ? 'blocked' : 'error';
  const stage = raw?.stage ? `${Math.max(1, raw.step || 1)}/${raw.of || 3} ${stageLabel || raw.stage}` : '';
  const folder = raw?.folder || raw?.installedFolder || plan?.folder || '';
  const model = modelId || raw?.modelId || plan?.modelId || '';
  const cause = summary || error || (raw?.error?.message ? uiMessage(raw.error.message) : '') || (problem?.message ? uiMessage(problem.message) : '');
  const platform = [plan?.platform, plan?.arch].filter(Boolean).join('-') || raw?.platformKey || '';
  return buildSetupDiagnostic({
    tool: 'live-local', label: 'LiveLocal', platform, status: state, stage, code, summary: cause,
    facts: [['folder', folder], ['model', model], ['version', raw?.engineVersion || plan?.engineVersion || '']],
    logs: [error && summary ? error : '', raw?.log],
  });
}

/** Diagnostic bundle `{ input, text }` for the Windows WASAPI system-audio helper (`LiveLoopbackCard`). */
export function liveLoopbackDiagnostic({ status: raw, plan, shown, summary = '', stageLabel = '', error = '' } = {}) {
  const problem = plan?.problems?.[0] || null;
  const code = shown?.code || raw?.error?.code || problem?.code || (shown?.state === 'repair' ? 'needs-repair' : '');
  const state = shown?.state && shown.state !== 'not-installed' ? shown.state : problem ? 'blocked' : 'error';
  const stage = raw?.stage ? `${Math.max(1, raw.step || 1)}/${raw.of || 2} ${stageLabel || raw.stage}` : '';
  const folder = raw?.folder || raw?.installedFolder || plan?.folder || '';
  const cause = summary || error || (raw?.error?.message ? uiMessage(raw.error.message) : '') || (problem?.message ? uiMessage(problem.message) : '');
  const platform = [plan?.platform, plan?.arch].filter(Boolean).join('-') || raw?.platformKey || '';
  return buildSetupDiagnostic({
    tool: 'live-loopback', label: 'LiveLoopback', platform, status: state, stage, code, summary: cause,
    facts: [['folder', folder], ['version', raw?.helperVersion || plan?.helperVersion || '']],
    logs: [error && summary ? error : '', raw?.log],
  });
}

/** Diagnostic bundle `{ input, text }` for the search extension install, companion startup, or index build (`ExtensionPanel`, `ExtensionNotStarted`). */
export function extensionDiagnostic({ status: raw, run, stage = '', code = '', summary = '', error = '', course = '' } = {}) {
  const ext = raw?.extension || {}, comp = raw?.companion || {};
  const resolvedCode = code || run?.errorCode || (comp.notStarted ? 'companion-not-started' : '') || (stage === 'index-start' ? 'index-start-failed' : '');
  const state = run?.status === 'failed' ? 'index-failed' : comp.notStarted ? 'not-started' : 'error';
  const cause = summary || error || run?.error || '';
  const version = [ext.version, ext.outdated && ext.expected ? `-> ${ext.expected}` : ''].filter(Boolean).join(' ');
  const reset = comp.reset?.reason ? `reset (${comp.reset.reason})` : '';
  return buildSetupDiagnostic({
    tool: 'retrieval-extension', label: 'RetrievalExtension', status: state, stage: stage || run?.stage || '', code: resolvedCode, summary: cause,
    facts: [['version', version], ['course', course || run?.course || ''], ['external', comp.id || '']],
    logs: [reset, error && summary ? error : '', run?.failed?.map(item => `${item.id}: ${item.message}`)],
  });
}

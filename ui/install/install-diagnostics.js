import { ui, uiMessage } from '../i18n.js';

/* Diagnostic text (复制诊断信息) and main-chat hand-off input (发给主会话, 'converter.failed') for local PDF converter setup errors
   in Settings › PDF 转换 (ui/MineruInstallCard.jsx, ui/MarkerInstall.jsx, ui/MarkerSettings.jsx). Keeps raw tracebacks and tail log
   lines redacted of URL credentials and capped to the last 40 lines so one click either copies a clean report or hands it to the main chat. */

const MAX_LOG_LINES = 40;
const redact = text => String(text ?? '').replace(/\/\/[^/\s@]+@/g, '//***@');

function tailLines(lines, max = MAX_LOG_LINES) {
  const list = (Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/))
    .map(line => redact(line).trimEnd())
    .filter(Boolean);
  return list.slice(-max).join('\n');
}

function joinLogBlocks(blocks) {
  const seen = new Set(), kept = [];
  for (const raw of blocks) {
    const chunk = tailLines(raw);
    if (!chunk || seen.has(chunk)) continue;
    seen.add(chunk);
    kept.push(chunk);
  }
  return kept.join('\n\n');
}

/** The Tooltip sentence of <HandOff id="converter.failed"> on MinerU and Marker error states. */
export const CONVERTER_FAILED_WHAT = '把报错和诊断信息发给主会话排查；动手改环境之前会先问你';

/** Build the input of 'converter.failed' for a MinerU card in `error` state. */
export function mineruHandOffInput({ view, install, plan, shown, summary = '', stageLabel = '' } = {}) {
  const code = shown?.code || install?.error?.code || view?.lastError?.code || '';
  const status = shown?.origin ? `${shown.state || 'error'} (${shown.origin})` : shown?.state || view?.state || 'error';
  const stage = shown?.origin === 'install' && install?.stage ? `${Math.max(1, install.step || 1)}/6 ${stageLabel || install.stage}` : '';
  const folder = install?.folder || install?.installedFolder || view?.folder || plan?.folder || '';
  const tier = install?.tier || install?.installedTier || view?.tier || plan?.tier || '';
  const source = install?.source?.id || plan?.source?.id || '';
  const python = install?.python || plan?.python || '';
  const version = view?.version || install?.mineruVersion || '';
  const external = view?.external?.exe || '';
  const log = joinLogBlocks([view?.lastError?.detail, install?.log]);
  return { tool: 'mineru', status, stage, code, summary: redact(summary), folder, tier, source, python, version, external, log };
}

/** Plain-text report copied by 复制诊断信息 on the MinerU card. */
export function mineruDiagnosticText(args = {}) {
  const info = mineruHandOffInput(args);
  const head = [
    `[MinerU] ${info.summary || info.code || info.status}`,
    info.code && `code: ${info.code}`,
    info.status && `status: ${info.status}`,
    info.stage && `stage: ${info.stage}`,
    args.plan?.platform && `platform: ${args.plan.platform}`,
    info.folder && `folder: ${info.folder}`,
    info.tier && `tier: ${info.tier}`,
    info.source && `source: ${info.source}`,
    info.python && `python: ${info.python}`,
    info.version && `version: ${info.version}`,
    info.external && `external: ${info.external}`,
  ].filter(Boolean).join('\n');
  return [head, info.log].filter(Boolean).join('\n\n');
}

/** Build the input of 'converter.failed' for Marker install, Docker/check, or manual-path failures. */
export function markerHandOffInput({ install, plan, markerStatus, command = '', summary = '', stageLabel = '', mirror = '' } = {}) {
  const problem = plan?.problems?.[0] || null;
  const code = install?.error?.code || (markerStatus?.state && markerStatus.state !== 'ready' ? markerStatus.state : '') || problem?.code || '';
  const status = install?.status && install.status !== 'idle'
    ? install.status
    : markerStatus?.state && markerStatus.state !== 'ready'
      ? markerStatus.state
      : problem ? 'blocked' : 'error';
  const stage = install?.stage && install.stage !== 'done' ? (stageLabel || install.stage) : '';
  const folder = install?.folder || install?.installedFolder || plan?.folder || '';
  const source = install?.mirror || mirror || plan?.mirror || '';
  const python = plan?.python
    ? `${plan.python.version} (${plan.python.command})`
    : plan?.tooNewPython
      ? `${plan.tooNewPython} (>${plan.maxPython || '3.13'})`
      : '';
  const resolvedCommand = command || install?.command || markerStatus?.command || '';
  const cause = summary
    || (install?.error?.message ? uiMessage(install.error.message) : '')
    || (markerStatus?.message ? uiMessage(markerStatus.message) : '')
    || (problem?.message ? uiMessage(problem.message) : '')
    || (markerStatus?.state === 'not-ready' ? ui('Marker 尚未就绪') : '');
  const log = joinLogBlocks([install?.log, markerStatus?.detail]);
  return { tool: 'marker', status, stage, code, summary: redact(cause), folder, source, python, command: resolvedCommand, log };
}

/** Plain-text report copied by 复制诊断信息 on Marker install or settings. */
export function markerDiagnosticText(args = {}) {
  const info = markerHandOffInput(args);
  const head = [
    `[Marker] ${info.summary || info.code || info.status}`,
    info.code && `code: ${info.code}`,
    info.status && `status: ${info.status}`,
    info.stage && `stage: ${info.stage}`,
    args.plan?.platform && `platform: ${args.plan.platform}`,
    info.folder && `folder: ${info.folder}`,
    info.source && `mirror: ${info.source}`,
    info.python && `python: ${info.python}`,
    info.command && `command: ${info.command}`,
  ].filter(Boolean).join('\n');
  return [head, info.log].filter(Boolean).join('\n\n');
}

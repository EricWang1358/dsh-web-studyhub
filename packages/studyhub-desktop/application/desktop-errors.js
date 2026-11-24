import { localizeAppMessage } from '../../../lib/application-messages.js';
import { RETRIEVAL_ERROR_MESSAGES, formatRetrievalError } from '../domain/retrieval-policy.js';

const DESKTOP_ERROR_ZH = Object.freeze({
  'config-corrupt': '配置文件 desktop.json 已损坏，为防止覆盖丢失已暂停保存；请先点击「备份并重置配置」后再保存设置或更换目录。',
});

const DESKTOP_ERROR_EN = Object.freeze({
  'config-corrupt': 'desktop.json is corrupted and cannot be read. Back up and reset the configuration before saving settings or changing the library folder.',
  'invalid-cli': 'This local CLI cannot be opened',
  'cli-not-ready': 'This local CLI is not ready yet; select Rescan first',
  'terminal-unsupported': 'Opening a command-line window is not supported on this system yet',
  'terminal-path-unsafe': 'A path has special characters or is not on a local drive, so the command-line window was not opened. Open a command line yourself, go to the library folder and run the CLI there',
  'terminal-launch-failed': 'Could not open a command-line window',
  BROKEN_SHIM: 'The launch script of this CLI is broken or its target file is missing',
  'invalid-config': 'Configuration payload must be an object',
  'invalid-mode': 'Unsupported model provider mode',
  'invalid-effort': 'Invalid reasoning effort value',
  'model-url-invalid': 'Invalid base URL; please provide a full http:// or https:// URL',
  'model-key-invalid': 'Invalid API key format; spaces and control characters are not allowed',
});

function resolveCallErrorMessage(error, code, language) {
  if (language === 'en') {
    if (Object.hasOwn(DESKTOP_ERROR_EN, code)) return DESKTOP_ERROR_EN[code];
    if (Object.hasOwn(RETRIEVAL_ERROR_MESSAGES, code)) return formatRetrievalError(code, 'en');
  } else if (Object.hasOwn(DESKTOP_ERROR_ZH, code)) {
    return DESKTOP_ERROR_ZH[code];
  }
  return localizeAppMessage(error?.message || String(error), language);
}

export function formatCallError(error, language) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'STUDY_ERROR';
  const details = error?.details && typeof error.details === 'object' ? error.details : undefined;
  return {
    ok: false,
    error: resolveCallErrorMessage(error, code, language),
    code,
    ...(details ? { details } : {}),
  };
}

export function formatForwardAnswer(answer) {
  if (answer.ok) return { ok: true, value: answer.value };
  const details = answer.error?.details && typeof answer.error.details === 'object' ? answer.error.details : undefined;
  return {
    ok: false,
    error: answer.error?.message || 'Study request failed',
    code: answer.error?.code || 'STUDY_ERROR',
    ...(details ? { details } : {}),
  };
}

import { localizeAppMessage } from '../../../lib/application-messages.js';
import { RETRIEVAL_ERROR_MESSAGES, formatRetrievalError } from '../domain/retrieval-policy.js';

const DESKTOP_ERROR_EN = Object.freeze({
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

export function formatCallError(error, language) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'STUDY_ERROR';
  if (language === 'en' && Object.hasOwn(DESKTOP_ERROR_EN, code)) {
    return { ok: false, error: DESKTOP_ERROR_EN[code], code };
  }
  if (language === 'en' && Object.hasOwn(RETRIEVAL_ERROR_MESSAGES, code)) {
    return { ok: false, error: formatRetrievalError(code, 'en'), code };
  }
  const message = localizeAppMessage(error?.message || String(error), language);
  return { ok: false, error: message, code };
}

export function formatForwardAnswer(answer) {
  if (answer.ok) return { ok: true, value: answer.value };
  return {
    ok: false,
    error: answer.error?.message || 'Study request failed',
    code: answer.error?.code || 'STUDY_ERROR',
  };
}

/* The plain sentence of a reason: no file path, token or signed-URL query in it. Pure (no Node module), so the server (the conversion history, the
   converters' output) and the client (the copyable diagnostic text, ui/diagnostics.js) redact in one place. */

export const REASON_LIMIT = 240;

const WINDOWS_PATH = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\s\\/:*?"<>|;,]*/g;
const POSIX_PATH = /(?<![\w:./~-])~?\/(?:[^\s/"'<>|;,]+\/)+[^\s/"'<>|;,]*/g;
const URL_QUERY = /(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g;
const JWT = /eyJ[\w-]{5,}(?:\.[\w-]+){1,2}/g;
const BEARER = /Bearer\s+\S+/gi;
// An API key by its prefix (sk-..., pk-..., ghp_...): long enough that a word like "sk-ill" or "task-list" is not taken for one.
const API_KEY = /(?<![\w-])(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g;

/* redactSecrets: for text that must stay as it was apart from the secrets in it (an install log, a daemon log, a copied diagnostic report): lines, spacing
   and length are kept, and a path keeps its drive and depth (the reason "path too long" or "not writable" is read from it); only the user name of a home
   folder goes. */
const USERINFO = /\/\/[^/\s@]+@/g;
// password=..., "token": "...", Authorization: Basic ...; the key may carry a prefix (access_token, x-api-key, client_secret) and a closing quote before ':'.
const KEY_VALUE = /(\b(?:[\w-]*[_-])?(?:password|passwd|secret\w*|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?)[^\s"',;}&]+/gi;
const BEARER_VALUE = /\b(Bearer\s+)[^\s"',;}&]+/gi;
const HF_TOKEN = /(?<![\w-])hf_[A-Za-z0-9]{30,}/g;
const WINDOWS_HOME = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|:*?]+/gi;
const POSIX_HOME = /(?<![\w.~-])\/(?:home|Users)\/[^/\s"'<>|:;,]+/g;
// A long base64 run with upper case, lower case and digits (a key, a cookie, a signed blob); a hex hash or a word has no such mix.
const BASE64_RUN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g;
const looksEncoded = run => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);

/** `text` with every secret StudyHub knows the shape of replaced by `***` (a home folder's user name by %USERPROFILE% or ~), and nothing else changed. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(USERINFO, '//***@')
    .replace(KEY_VALUE, '$1***')
    .replace(BEARER_VALUE, '$1***')
    .replace(JWT, '***').replace(API_KEY, '***').replace(HF_TOKEN, '***')
    .replace(BASE64_RUN, run => (looksEncoded(run) ? '***' : run))
    .replace(WINDOWS_HOME, '%USERPROFILE%')
    .replace(POSIX_HOME, '~');
}

/**
 * A sentence a learner can read, with nothing that identifies the machine or the account: no file paths, no token (the learner's own,
 * or anything shaped like one), no signed-URL query. `secrets` are exact strings to remove (the saved token).
 * `names`: a path becomes its last part (a traceback's "vllm.py" says where it broke; the folders above it only say who the learner is), else "[path]".
 * `keepEnd`: a text longer than `limit` keeps its end (the last line of a traceback is its cause), else its start.
 */
export function plainReason(value, { secrets = [], limit = REASON_LIMIT, names = false, keepEnd = false } = {}) {
  if (typeof value !== 'string') return '';
  let text = value;
  const hidden = names ? found => found.split(/[\\/]/).filter(Boolean).pop() || '[path]' : '[path]';
  // A path is shortened before the secrets go, so a secret folder inside a longer path never leaves the rest of that path behind.
  if (names) text = text.replace(WINDOWS_PATH, hidden).replace(POSIX_PATH, hidden);
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('');
  text = text.replace(URL_QUERY, '$1').replace(JWT, '').replace(BEARER, '').replace(API_KEY, '').replace(WINDOWS_PATH, hidden).replace(POSIX_PATH, hidden);
  const flat = text.replace(/\s+/g, ' ').trim();
  return keepEnd ? flat.slice(-limit) : flat.slice(0, limit);
}


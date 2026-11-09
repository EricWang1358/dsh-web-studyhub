/* The plain sentence of a reason: no file path, token or signed-URL query in it. Pure (no Node module), so the server (the conversion history, the
   converters' output) and the client (the copyable diagnostic text, ui/diagnostics.js) redact in one place. */

export const REASON_LIMIT = 240;

const WINDOWS_PATH = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\s\\/:*?"<>|;,]*/g;
const POSIX_PATH = /(?<![\w:./~-])~?\/(?:[^\s/"'<>|;,]+\/)+[^\s/"'<>|;,]*/g;
const URL_QUERY = /(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g;
const JWT = /eyJ[\w-]{5,}(?:\.[\w-]+){1,2}/g;
const BEARER = /Bearer\s+\S+/gi;

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
  text = text.replace(URL_QUERY, '$1').replace(JWT, '').replace(BEARER, '').replace(WINDOWS_PATH, hidden).replace(POSIX_PATH, hidden);
  const flat = text.replace(/\s+/g, ' ').trim();
  return keepEnd ? flat.slice(-limit) : flat.slice(0, limit);
}


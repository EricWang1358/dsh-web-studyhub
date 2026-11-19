// @ts-check

const DEFAULT_DETAIL_LIMIT = 300;
const MIN_PREFIX_SECRET_LENGTH = 16;
const SECRET_PREFIX_LENGTH = 12;

/**
 * Redact an API key, Bearer credential, and key prefix from error/diagnostic text.
 * @param {unknown} text
 * @param {string} [secret]
 * @returns {string}
 */
export function redactSecret(text, secret = '') {
  let clean = String(text ?? '');
  clean = clean.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer ••••');
  clean = clean.replace(/([?&](?:api[_-]?key|token)=)[^&\s"'<>]+/gi, '$1••••');
  clean = clean.replace(/("(?:api[_-]?key|apiKey|authorization|token)"\s*:\s*")[^"]+(")/gi, '$1••••$2');

  const key = typeof secret === 'string' ? secret.trim() : '';
  if (key) {
    clean = clean.split(key).join('••••');
    if (key.length >= MIN_PREFIX_SECRET_LENGTH) {
      clean = clean.split(key.slice(0, SECRET_PREFIX_LENGTH)).join('••••');
    }
  }
  return clean;
}

/**
 * Return the last 4 characters of a stored secret for non-sensitive UI display.
 * @param {string} [secret]
 * @returns {string}
 */
export function keyLast4(secret = '') {
  const key = typeof secret === 'string' ? secret.trim() : '';
  if (!key) return '';
  return key.length <= 4 ? key : key.slice(-4);
}

/**
 * Collapse whitespace and cap diagnostic text length.
 * @param {unknown} text
 * @param {number} [limit]
 * @returns {string}
 */
export function clipDetail(text, limit = DEFAULT_DETAIL_LIMIT) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

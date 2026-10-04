/* Local paths as a person pastes or drops them. */

/** A path as a person pastes it: quoted, with an @ in front (a file mention), or a file:// address. '' when the address cannot be read. */
export function unquotePath(text) {
  let value = String(text ?? '').trim().replace(/^"(.*)"$/, '$1').trim().replace(/^@/, '').trim();
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(value.replace(/^file:\/\//i, '')); } catch { return ''; }
    if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
  }
  return value;
}

/** Drive-letter, UNC and rooted paths; a relative one is not absolute. */
export const isAbsolutePath = (value) => typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\'));

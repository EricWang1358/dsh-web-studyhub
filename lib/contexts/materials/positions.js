import { textRevision } from './files.js';

/** Collapse only whitespace and keep UTF-16 ranges in the authoritative projection. */
export function normalizedRanges(text) {
  let value = ''; const ranges = [];
  for (let index = 0; index < text.length;) {
    const code = String.fromCodePoint(text.codePointAt(index));
    if (/\s/u.test(code)) {
      const start = index;
      do { index += String.fromCodePoint(text.codePointAt(index)).length; } while (index < text.length && /\s/u.test(String.fromCodePoint(text.codePointAt(index))));
      value += ' '; ranges.push({ start, end: index });
    } else {
      for (let i = 0; i < code.length; i++) ranges.push({ start: index + i, end: index + i + 1 });
      value += code; index += code.length;
    }
  }
  return { value, ranges };
}

export const selectionText = text => normalizedRanges(String(text ?? '')).value.trim();

function occurrences(source, input, identity) {
  const text = source.text || '', quote = selectionText(input.quote);
  if (!quote) return [];
  if (input.start !== undefined || input.end !== undefined) {
    if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end <= input.start || input.end > text.length) return [];
    if (selectionText(text.slice(input.start, input.end)) !== quote) return [];
    return [position(source, input.start, input.end, identity)];
  }
  const normalized = normalizedRanges(text);
  const found = [];
  const compact = value => selectionText(value).replaceAll(' ', '');
  const prefix = compact(input.prefix), suffix = compact(input.suffix);
  const offsets = new Uint32Array(normalized.value.length + 1);
  let compactText = '';
  for (let index = 0; index < normalized.value.length; index++) {
    if (normalized.value[index] !== ' ') compactText += normalized.value[index];
    offsets[index + 1] = compactText.length;
  }
  for (let at = normalized.value.indexOf(quote); at !== -1; at = normalized.value.indexOf(quote, at + 1)) {
    // DOM Range context omits block/table separators. Whitespace in that
    // context is layout noise; the selected quote still uses checked ranges.
    const before = offsets[at], after = offsets[at + quote.length];
    if (prefix && compactText.slice(Math.max(0, before - prefix.length), before) !== prefix) continue;
    if (suffix && compactText.slice(after, after + suffix.length) !== suffix) continue;
    const start = normalized.ranges[at].start, end = normalized.ranges[at + quote.length - 1].end;
    found.push(position(source, start, end, identity));
  }
  return found;
}

function position(source, start, end, identity) {
  const text = source.text || '';
  return { documentId: identity.documentId, revision: identity.revision || textRevision(text), sourceId: source.id,
    quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(end, end + 80), start, end,
    ...(source.document?.page ? { page: source.document.page } : {}) };
}

export function resolvePosition(sources, input, identity) {
  const eligible = sources.filter(source => (!input.sourceId || source.id === input.sourceId) && (input.page === undefined || source.document?.page === input.page));
  if (input.revision !== undefined && input.revision !== identity.revision && !input.revalidate)
    return { status: 'stale', currentRevision: identity.revision, requestedRevision: input.revision, message: 'Document revision changed; explicitly resolve against the current document before using this position.' };
  const candidates = eligible.flatMap(source => occurrences(source, input, identity));
  if (!candidates.length) return { status: 'missing', currentRevision: identity.revision, message: 'The selected passage or claimed offsets do not match this document projection.' };
  if (candidates.length > 1) return { status: 'ambiguous', currentRevision: identity.revision, candidates, message: 'The passage appears more than once; supply surrounding text, page or exact offsets.' };
  return { status: 'resolved', currentRevision: identity.revision, selection: candidates[0] };
}

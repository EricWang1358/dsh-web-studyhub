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
  const compactRanges = [];
  for (let index = 0; index < normalized.value.length; index++) {
    if (normalized.value[index] !== ' ') {
      compactText += normalized.value[index];
      compactRanges.push(normalized.ranges[index]);
    }
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
  if (!found.length) {
    // Multi-block DOM selections (adjacent paragraphs, HTML blocks, table cells,
    // footnotes) can omit or insert whitespace relative to the stored projection.
    // Fall back to non-whitespace ranges only when exact whitespace found nothing,
    // still enforcing surrounding context and explicit ambiguity.
    const compactQuote = compact(quote);
    if (compactQuote) {
      for (let at = compactText.indexOf(compactQuote); at !== -1; at = compactText.indexOf(compactQuote, at + 1)) {
        const after = at + compactQuote.length;
        if (prefix && compactText.slice(Math.max(0, at - prefix.length), at) !== prefix) continue;
        if (suffix && compactText.slice(after, after + suffix.length) !== suffix) continue;
        found.push(position(source, compactRanges[at].start, compactRanges[after - 1].end, identity));
      }
    }
  }
  if (!found.length) {
    // Reader Markdown preserves raw LaTeX delimiters/escapes (*, _, \, `, ~) inside
    // formulas while CommonMark projection unescapes or strips inline punctuation.
    const isMdMark = ch => ch === '*' || ch === '_' || ch === '\\' || ch === '`' || ch === '~';
    const stripMd = value => { let out = ''; for (let i = 0; i < value.length; i++) if (!isMdMark(value[i])) out += value[i]; return out; };
    const plainQuote = stripMd(compact(quote));
    if (plainQuote && /[\p{L}\p{N}]/u.test(plainQuote)) {
      const plainPrefix = stripMd(prefix), plainSuffix = stripMd(suffix);
      let plainText = '';
      const plainRanges = [];
      for (let index = 0; index < compactText.length; index++) {
        if (!isMdMark(compactText[index])) {
          plainText += compactText[index];
          plainRanges.push(compactRanges[index]);
        }
      }
      for (let at = plainText.indexOf(plainQuote); at !== -1; at = plainText.indexOf(plainQuote, at + 1)) {
        const after = at + plainQuote.length;
        if (plainPrefix && plainText.slice(Math.max(0, at - plainPrefix.length), at) !== plainPrefix) continue;
        if (plainSuffix && plainText.slice(after, after + plainSuffix.length) !== plainSuffix) continue;
        found.push(position(source, plainRanges[at].start, plainRanges[after - 1].end, identity));
      }
    }
  }
  return found;
}

function position(source, start, end, identity) {
  const text = source.text || '';
  return { documentId: identity.documentId, revision: identity.revision || textRevision(text), sourceId: source.id,
    quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(end, end + 80), start, end,
    ...(source.document?.page ? { page: source.document.page } : {}),
    ...(source.document?.section !== undefined ? { section: source.document.section } : {}) };
}

const compactValue = value => selectionText(value).replaceAll(' ', '');

function suffixOverlap(a, b) {
  let count = 0;
  const max = Math.min(a.length, b.length);
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) count++;
  return count;
}

function prefixOverlap(a, b) {
  let count = 0;
  const max = Math.min(a.length, b.length);
  while (count < max && a[count] === b[count]) count++;
  return count;
}

function exactSourceOccurrences(source, rawQuote, identity) {
  const text = source.text || '';
  if (!rawQuote || !rawQuote.trim()) return [];
  const found = [];
  for (let at = text.indexOf(rawQuote); at !== -1; at = text.indexOf(rawQuote, at + 1)) {
    found.push(position(source, at, at + rawQuote.length, identity));
  }
  return found;
}

/**
 * Relocate a passage across document revisions:
 * 1) exact substring match -> 2) normalized whitespace / compact / markdown-stripped match -> 3) unique prefix/suffix anchor disambiguation.
 * Unmatched (deleted/rewritten) or genuinely ambiguous passages preserve their original quote with `stale: true`.
 */
export function reanchorPosition(sources, input, identity) {
  const rawQuote = String(input?.quote ?? ''), quote = selectionText(rawQuote);
  const crossRevision = input?.revision !== undefined && input.revision !== identity.revision;
  const staleCopy = () => ({ ...input, quote: rawQuote, stale: true });
  if (!quote) {
    return { status: 'missing', stale: true, currentRevision: identity.revision, selection: staleCopy(),
      message: 'The selected passage or claimed offsets do not match this document projection.' };
  }
  const eligible = crossRevision
    ? sources
    : sources.filter(source => (!input.sourceId || source.id === input.sourceId) && (input.page === undefined || source.document?.page === input.page));
  let candidates = eligible.flatMap(source => exactSourceOccurrences(source, rawQuote, identity));
  if (!candidates.length) {
    candidates = eligible.flatMap(source => occurrences(source, { quote: rawQuote }, identity));
  }
  if (!candidates.length) {
    if (crossRevision) {
      return { status: 'stale', stale: true, reason: 'deleted', currentRevision: identity.revision, requestedRevision: input.revision,
        selection: staleCopy(), message: 'The selected passage was removed or rewritten in the current document revision.' };
    }
    return { status: 'missing', stale: true, currentRevision: identity.revision, selection: staleCopy(),
      message: 'The selected passage or claimed offsets do not match this document projection.' };
  }
  if (candidates.length === 1) {
    return { status: 'resolved', currentRevision: identity.revision, selection: candidates[0] };
  }
  if (!crossRevision && Number.isInteger(input.start) && Number.isInteger(input.end)) {
    const exactSpan = candidates.filter(candidate => (!input.sourceId || candidate.sourceId === input.sourceId) && candidate.start === input.start && candidate.end === input.end);
    if (exactSpan.length === 1) return { status: 'resolved', currentRevision: identity.revision, selection: exactSpan[0] };
  }
  const wantPrefix = compactValue(input.prefix), wantSuffix = compactValue(input.suffix);
  if (wantPrefix || wantSuffix) {
    const fullContext = candidates.filter(candidate =>
      (!wantPrefix || compactValue(candidate.prefix).endsWith(wantPrefix)) &&
      (!wantSuffix || compactValue(candidate.suffix).startsWith(wantSuffix)));
    if (fullContext.length === 1) return { status: 'resolved', currentRevision: identity.revision, selection: fullContext[0] };
    const scored = candidates.map(candidate => ({
      candidate,
      score: (wantPrefix ? suffixOverlap(compactValue(candidate.prefix), wantPrefix) : 0)
        + (wantSuffix ? prefixOverlap(compactValue(candidate.suffix), wantSuffix) : 0),
    })).sort((a, b) => b.score - a.score);
    const minAnchor = Math.min(2, wantPrefix.length + wantSuffix.length);
    if (scored[0].score >= minAnchor && scored[0].score > scored[1].score) {
      return { status: 'resolved', currentRevision: identity.revision, selection: scored[0].candidate };
    }
  } else if (!crossRevision && input.page !== undefined) {
    const onPage = candidates.filter(candidate => candidate.page === input.page);
    if (onPage.length === 1) return { status: 'resolved', currentRevision: identity.revision, selection: onPage[0] };
  }
  return { status: 'ambiguous', stale: true, currentRevision: identity.revision, candidates, selection: staleCopy(),
    message: 'The passage appears more than once; supply surrounding text, page or exact offsets.' };
}

export function resolvePosition(sources, input, identity) {
  if (input.revision !== undefined && input.revision !== identity.revision && !input.revalidate)
    return { status: 'stale', currentRevision: identity.revision, requestedRevision: input.revision, message: 'Document revision changed; explicitly resolve against the current document before using this position.' };
  if (input.revalidate) return reanchorPosition(sources, input, identity);
  const eligible = sources.filter(source => (!input.sourceId || source.id === input.sourceId) && (input.page === undefined || source.document?.page === input.page));
  const candidates = eligible.flatMap(source => occurrences(source, input, identity));
  if (!candidates.length) return { status: 'missing', currentRevision: identity.revision, message: 'The selected passage or claimed offsets do not match this document projection.' };
  if (candidates.length > 1) return { status: 'ambiguous', currentRevision: identity.revision, candidates, message: 'The passage appears more than once; supply surrounding text, page or exact offsets.' };
  return { status: 'resolved', currentRevision: identity.revision, selection: candidates[0] };
}

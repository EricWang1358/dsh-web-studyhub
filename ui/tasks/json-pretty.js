/* Model JSON, made readable (2.6.1). The 实时输出 panel shows what a call writes: reviews, plans, blueprints and corrections are JSON, and one dense wrapped line is
   not readable. `prettyParts(text)` / `prettyOutput(text)` indent a JSON object or array found in the text by structure, two spaces per level, while it is
   still being written.

   Contract:
   - A JSON document is found at the start of the text, or at the start of a line after some prose or a ``` fence (a `{` or `[` in the middle of a line is prose).
     Whatever surrounds it is kept as it was; text with no JSON in it is returned untouched, character for character.
   - It is a TOLERANT TOKENIZER, not JSON.parse: a prefix of a JSON text (cut inside a string, a key, a number, an escape) and even broken JSON is indented by structure
     outside strings and never throws. It never changes what was written: strings are kept raw (escapes such as \n and \" stay as written, long values are neither
     shortened nor wrapped: the panel wraps them with CSS), nothing is reordered, nothing is dropped; only whitespace OUTSIDE strings is regenerated.
   - It is prefix-stable: indenting a longer prefix of a text only ever adds to the indented shorter one (a line break is written just before the token that needs it,
     never in advance), so a re-render of a growing text does not make what is already on screen jump. The one exception is whitespace that precedes the first JSON
     document of a text, which is dropped as soon as the document begins.
   - Indentation stops growing at INDENT_LEVELS levels (absurd nesting stays bounded; the content stays).
   - `{ fragment: true }` says the text is the TAIL of a longer one (the host only keeps the last ~8 KB of a call's output, so a panel opened late starts in the
     middle of the JSON). Without a start to find, it resyncs at the first `,"key":` (an unescaped quote before a colon can only be a key outside a string), keeps
     what comes before as it was, and indents from there with a guessed depth: relative structure is right, absolute depth is not known.

   The parts carry a kind for colouring: key | string | literal (numbers, true/false/null) | punct (brackets, commas, colons, line breaks) | plain (everything else).
   Neighbouring parts of one kind are merged. The panel turns parts into React elements; nothing here produces markup. */

const INDENT_LEVELS = 12;
const pad = (depth) => '  '.repeat(Math.min(depth, INDENT_LEVELS));
const isSpace = (char) => char === ' ' || char === '\n' || char === '\t' || char === '\r';
const STOPS = new Set([',', ':', '{', '}', '[', ']', '"']);

/** The first position after `from` (not counting whitespace) where a character of `text` is, or -1. */
const nextSolid = (text, from) => { for (let index = from; index < text.length; index++) if (!isSpace(text[index])) return index; return -1; };

/** Does a `{` or `[` at `at` look like the start of JSON? Its first token must be one JSON can begin with (or nothing has been written yet). */
function plausible(text, at) {
  const next = nextSolid(text, at + 1);
  if (next < 0) return true;
  return text[at] === '{' ? text[next] === '"' || text[next] === '}' : '"{[]'.includes(text[next]);
}

/** The start of the next JSON document: a `{` or `[` that begins a line (after indentation), from the line that begins at `from` when `lineStart`, else from the next line. */
function findStart(text, from, lineStart) {
  let line = from;
  if (!lineStart) { const newline = text.indexOf('\n', from); if (newline < 0) return -1; line = newline + 1; }
  while (line <= text.length) {
    let at = line;
    while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\r')) at++;
    if ((text[at] === '{' || text[at] === '[') && plausible(text, at)) return at;
    const newline = text.indexOf('\n', line);
    if (newline < 0) return -1;
    line = newline + 1;
  }
  return -1;
}

const KEY = /[,{[]\s*"(?:[^"\\\n]|\\.)*"\s*:/;

/** @returns {{ kind: 'key'|'string'|'literal'|'punct'|'plain', text: string }[]} */
export function prettyParts(text, { fragment = false } = {}) {
  const parts = [];
  const emit = (kind, value) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += value; else parts.push({ kind, text: value });
  };
  if (typeof text !== 'string' || !text) return parts;
  const length = text.length;
  let position = 0;
  for (;;) {
    const start = findStart(text, position, position === 0);
    if (start < 0) {
      const key = position === 0 && fragment ? KEY.exec(text) : null;
      if (key) {
        emit('plain', text.slice(0, key.index));
        tokenize(text, key.index, length, emit, true);
        return parts;
      }
      if (position === 0) emit('plain', text);
      else { const rest = text.slice(position).replace(/^\s+/, ''); if (rest) emit('plain', '\n' + rest); }
      return parts;
    }
    // what stands before the document: prose (kept), or only blank space (dropped; a later document starts on a line of its own)
    const prose = text.slice(position, start);
    if (position === 0) { if (prose.trim()) emit('plain', prose); }
    else if (prose.trim()) emit('plain', '\n' + prose.replace(/^\s+/, ''));
    else emit('punct', '\n');
    position = tokenize(text, start, length, emit);
    if (position >= length) return parts;
  }
}

/** One JSON document from `start`; returns the position after it (or `length` when the text ends inside it). `seeded`: the middle of a document, never ends. */
function tokenize(text, start, length, emit, seeded = false) {
  const frames = seeded ? [{ object: true, expectKey: false }] : [];
  let at = start, pending = false, justOpened = false, gap = false, last = '';
  const breakLine = () => { if (pending) { emit('punct', '\n' + pad(frames.length)); pending = false; justOpened = false; } };
  const value = (kind, token) => {
    breakLine();
    // two values with only whitespace between them (broken JSON): keep them apart
    if (gap && (last === 'string' || last === 'literal')) emit('punct', ' ');
    emit(kind, token); last = kind === 'key' ? 'string' : kind; gap = false;
  };
  while (at < length) {
    const char = text[at];
    if (isSpace(char)) { gap = true; at++; continue; }
    if (char === '"') {
      let end = at + 1;
      while (end < length) { if (text[end] === '\\') { end += 2; continue; } if (text[end] === '"') { end++; break; } end++; }
      const top = frames[frames.length - 1];
      value(top && top.object && top.expectKey ? 'key' : 'string', text.slice(at, Math.min(end, length)));
      at = end;
    } else if (char === '{' || char === '[') {
      breakLine();
      emit('punct', char); last = 'open'; gap = false;
      frames.push({ object: char === '{', expectKey: true });
      pending = true; justOpened = true; at++;
    } else if (char === '}' || char === ']') {
      // an empty container stays `{}` / `[]`; otherwise the closer goes on its own line, one level out
      if (!justOpened) emit('punct', '\n' + pad(frames.length - 1));
      pending = false; justOpened = false;
      if (!seeded || frames.length > 1) frames.pop();
      emit('punct', char); last = 'close'; gap = false; at++;
      if (!frames.length) return at;
    } else if (char === ',') {
      emit('punct', ','); last = 'comma'; gap = false;
      pending = true; justOpened = false;
      const top = frames[frames.length - 1];
      if (top && top.object) top.expectKey = true;
      at++;
    } else if (char === ':') {
      emit('punct', ': '); last = 'colon'; gap = false;
      const top = frames[frames.length - 1];
      if (top && top.object) top.expectKey = false;
      at++;
    } else {
      let end = at + 1;
      while (end < length && !isSpace(text[end]) && !STOPS.has(text[end])) end++;
      value('literal', text.slice(at, end));
      at = end;
    }
  }
  return length;
}

/** The indented text (a string). Text without JSON in it comes back unchanged; anything that is not text gives ''. */
export function prettyOutput(text, options) {
  return prettyParts(text, options).map((part) => part.text).join('');
}

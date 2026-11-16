import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

/* #1073: a typed glyph is not an icon. This finds the strings a learner reads (ui("…"), uiFormat("…"), JSX text, attributes, a label table) that use
   a character as a stand-in for a registry icon. The rules are the ones ui/DESIGN.md writes down (Icons):
     - a tick, cross, flag, plus, refresh, play, triangle or diagonal arrow is always an icon (ICON_GLYPHS);
     - an arrow at the start or the end of a string is an action label's stand-in: a "go on" arrow is `iconEnd="arrow-right"`, a way back `icon="arrow-left"`;
     - an arrow INSIDE a sentence is punctuation (「本组 40% → 55%」, 「A → B → C」, a step list) and a lone " → " between two values is a joiner: both stay text;
     - × is the multiplication sign (between spaces or before a number / placeholder), never a close mark;
     - a key name is typed (← → ↑ ↓ on a keycap): those strings are listed one by one in the test, with why. */

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Characters that only ever stand in for an icon. */
export const ICON_GLYPHS = '✓✔✗✘✕⚑⚐↻↺⟳▶▸▾▼◀◂＋↗↘➜➔⇒⇠⏎';
const ARROWS = '→←↑↓';
const EDGE_OPEN = /^[\s「『（(“"'‘\[]+/u;
const EDGE_CLOSE = /[\s」』）)”"'’\]。.；;]+$/u;
const JOINER = /^\s+[→←↑↓]\s+$/u;

/** Why a string uses a glyph as an icon (an empty list when it is fine). */
export function glyphProblems(text) {
  const problems = [];
  for (const ch of new Set(text)) if (ICON_GLYPHS.includes(ch)) problems.push(`"${ch}" is an icon, use <Icon>`);
  if (!JOINER.test(text)) {
    const core = text.replace(EDGE_OPEN, '').replace(EDGE_CLOSE, '');
    const first = [...core][0], last = [...core].at(-1);
    if (first && ARROWS.includes(first)) problems.push(`starts with "${first}", use icon="arrow-left" / iconEnd="arrow-right"`);
    else if (last && ARROWS.includes(last) && core.length) problems.push(`ends with "${last}", use icon="arrow-left" / iconEnd="arrow-right"`);
  }
  // × is a multiplication sign: between spaces, or before a number or a placeholder ({} stands for an expression of a template).
  for (let at = text.indexOf('×'); at >= 0; at = text.indexOf('×', at + 1)) {
    const before = text[at - 1], after = text[at + 1];
    const operator = before === ' ' && after === ' ';
    const times = after !== undefined && /[\d{]/.test(after);
    if (!operator && !times) problems.push('"×" is not a multiplication, use the close icon');
  }
  return problems;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
function cook(raw) {
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r?\n|.)/gs, (all, tail, long, four, two) => {
    if (long || four || two) return String.fromCodePoint(parseInt(long || four || two, 16));
    if (tail[0] === '\n' || tail[0] === '\r') return '';
    return ESCAPES[tail] ?? tail;
  });
}
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|yield|await|else)$/;

/** Every string a piece of (esbuild-formatted) JavaScript holds: string literals and template text (an expression of a template shows as "{}"). */
export function stringsOf(code) {
  const found = [];
  let at = 0;
  function readString(quote) {
    const start = at++;
    while (at < code.length && code[at] !== quote) at += code[at] === '\\' ? 2 : 1;
    found.push(cook(code.slice(start + 1, at)));
    at++;
  }
  function readTemplate() {
    at++;
    let text = '', from = at;
    while (at < code.length && code[at] !== '`') {
      if (code[at] === '\\') at += 2;
      else if (code[at] === '$' && code[at + 1] === '{') {
        text += cook(code.slice(from, at)) + '{}';
        at += 2;
        readCode(true);
        from = at;
      } else at++;
    }
    text += cook(code.slice(from, at));
    at++;
    found.push(text);
  }
  function readCode(inExpression) {
    let depth = 0, previous = '';
    while (at < code.length) {
      const ch = code[at];
      if (ch === '"' || ch === "'") { readString(ch); previous = ch; continue; }
      if (ch === '`') { readTemplate(); previous = ch; continue; }
      if (ch === '/' && code[at + 1] === '/') { while (at < code.length && code[at] !== '\n') at++; continue; }
      if (ch === '/' && code[at + 1] === '*') { at = code.indexOf('*/', at + 2) + 2 || code.length; continue; }
      if (ch === '/') {
        const before = code.slice(Math.max(0, at - 12), at).trimEnd();
        if (!previous || REGEX_AFTER.test(previous) || KEYWORD_BEFORE_REGEX.test(before)) {
          at++;
          for (let inClass = false; at < code.length && (inClass || code[at] !== '/'); at++) {
            if (code[at] === '\\') at++;
            else if (code[at] === '[') inClass = true;
            else if (code[at] === ']') inClass = false;
          }
          at++;
          previous = ')';
          continue;
        }
      }
      if (inExpression) {
        if (ch === '{') depth++;
        else if (ch === '}') { if (!depth) { at++; return; } depth--; }
      }
      if (!/\s/.test(ch)) previous = ch;
      at++;
    }
  }
  readCode(false);
  return found;
}

const SOURCE = /\.(?:jsx|js)$/;
/** The prompts for the model are not the learner's words. */
const NOT_UI = ['ui/agent-prompts/', 'ui/locales/', 'ui/fonts/'];

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (SOURCE.test(entry.name)) files.push(path);
  }
  return files;
}

/** Every string of every UI source file: [{ file, text }]. */
export async function uiStrings(root = repoRoot) {
  const files = (await walk(join(root, 'ui'))).map((path) => ({ path, file: relative(root, path).replace(/\\/g, '/') }))
    .filter(({ file }) => !NOT_UI.some((prefix) => file.startsWith(prefix)));
  const rows = [];
  for (const { path, file } of files) {
    const source = await readFile(path, 'utf8');
    const { code } = await transform(source, { loader: 'jsx', jsx: 'transform', charset: 'utf8', sourcefile: file });
    for (const text of stringsOf(code)) rows.push({ file, text });
  }
  return rows;
}

/** Every English catalogue entry: [{ file, key, value }]. */
export async function localeEntries(root = repoRoot) {
  const dir = join(root, 'ui', 'locales');
  const rows = [];
  for (const name of (await readdir(dir)).filter((entry) => /^en(?:\..+)?\.json$/.test(entry)).sort())
    for (const [key, value] of Object.entries(JSON.parse(await readFile(join(dir, name), 'utf8')))) rows.push({ file: `ui/locales/${name}`, key, value });
  return rows;
}

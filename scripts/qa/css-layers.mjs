/* Cascade layers and one scope for every StudyHub stylesheet (ui-consistency #149).
     node scripts/qa/css-layers.mjs wrap <file.css> [--layer features]   wrap one stylesheet in place
     node scripts/qa/css-layers.mjs wrap --all                           wrap every ui/**.css that is not wrapped yet
     node scripts/qa/css-layers.mjs check                                list structure problems (tests/css-structure.test.mjs runs the same check)
   The shape of a wrapped file:

     @layer study.reset, study.tokens, study.components, study.features, study.overrides;   <- same line in every file
     @layer study.<layer> {
       <root rules: selectors that start with .study-app / .study-seat (theme attributes, host overlays, the app box itself)>
       :is(.study-app, .study-seat) {
         <every other rule, written relative to the scope: `.x { ... }`>
       }
       @container / @media / @supports wrappers hold the same two kinds of block
     }
     @keyframes / @font-face stay at the top level (names are global anyway)

   Layers decide the cascade between files (reset < tokens < components < features < overrides); inside a layer the usual
   specificity and order apply. The `study.` prefix keeps the layers apart from any layer a host page declares.
   !important inverts the layer order, so the motion sheet (whose !important rules must win) sits in `reset`. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, FROZEN_FILES, cssFiles, parseTree, splitSelectorList } from './css-tools.mjs';

export const LAYER_STATEMENT = '@layer study.reset, study.tokens, study.components, study.features, study.overrides;';
export const SCOPE = ':is(.study-app, .study-seat)';
/* The same scope with zero specificity. A rule that used to be bare (or under :where(.study-app)) keeps the (0,1,0) it always had next
   to the rules that were written `.study-app .x` (0,2,0): the wrapper preserves what the author's selector meant, so wrapping a
   file never changes which of two rules of different files wins on specificity. */
export const SCOPE_LOW = ':where(.study-app, .study-seat)';

/** The layer a stylesheet belongs to, by path. */
export function layerOf(file) {
  if (file === 'ui/base.css' || file === 'ui/motion.css') return 'reset';
  if (['ui/tokens.css', 'ui/paper.css', 'ui/accent.css', 'ui/appearance-themes.css'].includes(file)) return 'tokens';
  if (file.startsWith('ui/components/')) return 'components';
  if (['ui/host/studyhub.css', 'ui/panel-bridge.css'].includes(file)) return 'overrides';
  return 'features';
}

/* Stylesheets that style things the host renders outside the study app. Their selectors cannot be scoped to it:
   scope: false  keep selectors as written (host chrome: the seat frame, the panel's own picker; the content the host shows in its preview pane
                 and the ::highlight on its document), still in a layer: an unlayered rule would out-rank every layered one in the app
   keepBare      bare selectors stay unscoped and unlayered (kept for a sheet that must beat the layers; nothing uses it today) */
export const HOST_FILES = {
  'ui/host/studyhub.css': { scope: false },
  'ui/panel-bridge.css': { scope: false },
  'ui/document-preview/document-preview.css': { scope: false },
};
export const optionsOf = (file) => HOST_FILES[file] || {};

const PREFIX = /^(?::is\(\s*\.study-app\s*,\s*\.study-seat\s*\)|:where\(\s*\.study-app\s*,\s*\.study-seat\s*\)|:where\(\s*\.study-app\s*\)|\.study-app)(?=[\s>+~]|$)/;
const WRAPPERS = new Map([[':is(.study-app, .study-seat)', 'is'], [':where(.study-app)', 'where']]);

/* One selector entry -> { kind: 'root' | 'scoped', text }. Scoped text is relative to the scope. */
function classify(entry, wrapper, scope = true) {
  const e = entry.trim();
  if (!scope) return { kind: 'root', text: e };
  if (wrapper && !e.startsWith('&')) return { kind: 'scoped', text: relative(e), low: wrapper === 'where' };
  if (wrapper && e.startsWith('&')) {
    const rest = e.slice(1);
    const root = wrapper === 'is' ? SCOPE : '.study-app';
    if (!rest.trim()) return { kind: 'root', text: root };
    if (!/^[\s>+~]/.test(rest)) return { kind: 'root', text: root + rest };
    return { kind: 'scoped', text: relative(rest.trim()), low: wrapper === 'where' };
  }
  if (e.startsWith('.study-seat')) return { kind: 'root', text: e };
  const m = PREFIX.exec(e);
  if (m) {
    const rest = e.slice(m[0].length).trim();
    if (!rest) return { kind: 'root', text: e.startsWith(':where(.study-app)') ? '.study-app' : e };
    return { kind: 'scoped', text: relative(rest), low: m[0].startsWith(':where') };
  }
  if (e.startsWith('.study-app') || e.startsWith(':is(.study-app, .study-seat)')) return { kind: 'root', text: e };
  return { kind: 'scoped', text: relative(e), bare: true, low: true };
}

/* A nested selector that starts with a type name needs `&` in the first nesting syntax. */
const relative = (text) => (/^[a-zA-Z]/.test(text) ? `& ${text}` : text);

const reindent = (text, from, to) => text.split('\n').map((line, i) => {
  if (!line.trim()) return '';
  const lead = /^[ \t]*/.exec(line)[0].length;
  return ' '.repeat(to) + (i === 0 ? line.trimStart() : line.slice(Math.min(from, lead)));
}).join('\n');

const lineStart = (source, index) => { let i = index; while (i > 0 && /[ \t]/.test(source[i - 1])) i--; return i; };

export function wrapStylesheet(source, layer, options = {}) {
  const { scope = true, keepBare = false } = options;
  const text = source.replace(/\r\n/g, '\n');
  if (/^\s*(\/\*[\s\S]*?\*\/\s*)*@layer study\./.test(text)) return text;
  const tree = parseTree(text, { comments: true });
  let header = '';
  let nodes = tree.children;
  if (nodes[0]?.kind === 'comment' && /\n[ \t]*\n/.test(text.slice(nodes[0].end, nodes[1]?.start ?? text.length))) { header = text.slice(nodes[0].start, nodes[0].end); nodes = nodes.slice(1); }
  const items = [], outside = [];
  let pending = [];
  const comment = (node) => text.slice(lineStart(text, node.start), node.end);
  const ruleText = (node, entries, changed) => {
    const base = text.slice(lineStart(text, node.start)).match(/^[ \t]*/)[0].length;
    const prelude = changed ? entries.join(/\n/.test(text.slice(node.start, node.bodyStart)) ? ',\n' : ', ') : text.slice(node.start, node.bodyStart - 1).trimEnd();
    const body = text.slice(node.bodyStart - 1, node.end);
    return { base, text: `${prelude} ${body.startsWith('{') ? body : `{${body}`}` };
  };
  const push = (chain, kind, piece, lead) => items.push({ chain, kind, piece, lead });
  const flatten = (list, chain, wrapper) => {
    for (const node of list) {
      if (node.kind === 'comment') { pending.push(comment(node)); continue; }
      if (node.kind === 'statement') { continue; }
      if (node.kind === 'at') {
        if (/^@(-webkit-)?keyframes\b|^@font-face\b/.test(node.prelude)) {
          outside.push([...pending, text.slice(lineStart(text, node.start), node.end)].join('\n'));
          pending = [];
          continue;
        }
        const nested = [...chain, node.prelude];
        flatten(node.children, nested, wrapper);
        continue;
      }
      if (node.kind !== 'rule') continue;
      const lead = pending;
      pending = [];
      if (!wrapper && WRAPPERS.has(node.prelude)) {
        const kind = WRAPPERS.get(node.prelude);
        if (node.decls.length) {
          const decls = node.decls.map((d) => `  ${text.slice(d.start, d.end).trim()}`).join('\n');
          push(chain, 'root', { base: 0, text: `${kind === 'is' ? SCOPE : '.study-app'} {\n${decls}\n}` }, lead);
        } else pending = lead;
        flatten(node.children, chain, kind);
        continue;
      }
      const entries = splitSelectorList(node.prelude);
      const roots = [], scoped = [], lows = [], bares = [];
      let changed = false;
      for (const entry of entries) {
        const c = classify(entry, wrapper, scope);
        if (c.text !== entry.trim()) changed = true;
        if (c.kind === 'scoped' && keepBare && c.bare) bares.push(c.text);
        else if (c.kind === 'root') roots.push(c.text);
        else (c.low ? lows : scoped).push(c.text);
      }
      if (options.collect) { for (const t of scoped) options.collect.push({ chain: chain.join('|'), prelude: t, low: false }); for (const t of lows) options.collect.push({ chain: chain.join('|'), prelude: t, low: true }); }
      const parts = [['bare', bares], ['root', roots], ['scoped', scoped], ['low', lows]].filter(([, list]) => list.length);
      parts.forEach(([kind, list], index) => push(chain, kind, ruleText(node, list, parts.length > 1 || changed), index === 0 ? lead : []));
    }
  };
  flatten(nodes, [], null);

  /* emit: consecutive items with the same at-rule chain and the same kind share one container */
  const out = [];
  let group = null;
  const flush = () => { if (group) out.push(group); group = null; };
  for (const item of items) {
    if (group && group.kind === item.kind && group.chain.join('|') === item.chain.join('|')) group.items.push(item);
    else { flush(); group = { kind: item.kind, chain: item.chain, items: [item] }; }
  }
  flush();
  const render = (g) => {
    const scoped = g.kind === 'scoped' || g.kind === 'low';
    let depth = 1 + g.chain.length + (scoped ? 1 : 0);
    if (g.kind === 'bare') depth -= 1;
    const body = g.items.map((item) => [...item.lead.map((c) => reindent(c, c.match(/^[ \t]*/)[0].length, depth * 2)), reindent(item.piece.text, item.piece.base, depth * 2)].join('\n')).join('\n');
    let result = scoped ? `${' '.repeat((depth - 1) * 2)}${g.kind === 'low' ? SCOPE_LOW : SCOPE} {\n${body}\n${' '.repeat((depth - 1) * 2)}}` : body;
    depth = g.kind === 'bare' ? g.chain.length : 1 + g.chain.length;
    for (let i = g.chain.length - 1; i >= 0; i--) {
      depth--;
      result = `${' '.repeat((depth) * 2)}${g.chain[i]} {\n${result}\n${' '.repeat(depth * 2)}}`;
    }
    return result;
  };
  const trailing = pending;
  const parts = [];
  if (header) parts.push(header);
  const layered = out.filter((g) => g.kind !== 'bare'), bare = out.filter((g) => g.kind === 'bare');
  parts.push(LAYER_STATEMENT, `@layer study.${layer} {\n${layered.map(render).join('\n')}${trailing.length ? `\n${trailing.map((c) => reindent(c, 0, 2)).join('\n')}` : ''}\n}`);
  if (bare.length) parts.push(`/* host-embedded: these rules style content that the host renders outside the study app, so they stay unscoped and unlayered */\n${bare.map(render).join('\n')}`);
  if (outside.length) parts.push(outside.join('\n'));
  return `${parts.join('\n\n')}\n`;
}

/** For a stylesheet as an author wrote it: { chain, prelude, low } of every scoped rule entry (chain = the @media/@container rules around it). */
export function scopedOrigins(source) {
  const collect = [];
  wrapStylesheet(source, 'features', { collect });
  return collect;
}

/** Structure problems of one stylesheet: everything must sit in a study layer and, inside it, in the scope or on a root. */
export function checkStructure(source, options = {}) {
  const { scope = true, keepBare = false } = options;
  const problems = [];
  const tree = parseTree(source.replace(/\r\n/g, '\n'), { comments: true });
  const rootEntry = (entry) => /^(\.study-app|\.study-seat|:is\(\.study-app, \.study-seat\))/.test(entry.trim());
  const checkInner = (children, inScope) => {
    for (const node of children) {
      if (node.kind === 'comment' || node.kind === 'statement') continue;
      if (node.kind === 'at') {
        if (/^@(media|container|supports)\b/.test(node.prelude)) checkInner(node.children, inScope);
        else problems.push(`line ${node.line}: ${node.prelude.slice(0, 50)} is not a conditional group rule`);
        continue;
      }
      if (inScope || !scope) continue;
      if (node.prelude === SCOPE || node.prelude === SCOPE_LOW) continue;
      const entries = splitSelectorList(node.prelude);
      if (!entries.every(rootEntry)) problems.push(`line ${node.line}: "${node.prelude.slice(0, 70)}" is outside ${SCOPE}`);
    }
  };
  let statement = false;
  for (const decl of tree.decls) problems.push(`line ${decl.line}: stray text outside any rule: ${decl.prop}`);
  for (const node of tree.children) {
    if (node.kind === 'comment') continue;
    if (node.kind === 'statement') { if (node.prelude.replace(/;$/, '') === LAYER_STATEMENT.slice(0, -1)) statement = true; else problems.push(`line ${node.line}: unexpected ${node.prelude}`); continue; }
    if (node.kind === 'at' && /^@(-webkit-)?keyframes\b|^@font-face\b/.test(node.prelude)) continue;
    if (node.kind === 'at' && /^@layer study\.(reset|tokens|components|features|overrides)$/.test(node.prelude)) { checkInner(node.children, false); continue; }
    if (keepBare) continue;
    problems.push(`line ${node.line}: "${node.prelude.slice(0, 70)}" is outside a study layer`);
  }
  if (!statement) problems.push('the @layer order statement is missing');
  return problems;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = new Set(rest);
  const layerFlag = rest.indexOf('--layer');
  if (command === 'check') {
    let bad = 0;
    for (const file of cssFiles()) {
      if (FROZEN_FILES.includes(file)) continue;
      const problems = checkStructure(readFileSync(join(ROOT, file), 'utf8'), optionsOf(file));
      for (const p of problems) { bad++; console.log(`${file}: ${p}`); }
    }
    console.log(bad ? `${bad} problem(s)` : 'every stylesheet is wrapped');
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (command === 'wrap') {
    const files = args.has('--all') ? cssFiles(ROOT, { frozen: false }) : rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--layer');
    for (const file of files) {
      const path = join(ROOT, file);
      const layer = layerFlag >= 0 ? rest[layerFlag + 1] : layerOf(file);
      writeFileSync(path, wrapStylesheet(readFileSync(path, 'utf8'), layer, optionsOf(file)));
      console.log(`${file} -> study.${layer}`);
    }
    return;
  }
  console.error('usage: css-layers.mjs wrap <file>|--all [--layer name] | check');
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

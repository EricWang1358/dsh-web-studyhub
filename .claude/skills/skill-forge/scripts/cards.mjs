#!/usr/bin/env node
/* skill-forge cards: validate the card files an LLM wrote (check) and count them per mistake class (stats). */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, need, parseCli, readJsonl, runMain, UsageError } from './forge-lib.mjs';

export const RECURRING_MIN_CARDS = 3;
export const RECURRING_MIN_SURFACES = 2;

const USAGE = `Usage:
  node cards.mjs check --workbench <dir> [--taxonomy <path>]
  node cards.mjs stats --workbench <dir> [--taxonomy <path>]

Cards live in <dir>/cards/*.jsonl, one JSON object per line:
  ref "#123", kind pr|issue, surface, mechanism, mistake, layer, moment, class "C07"|"new", proposed_class (when new),
  catch, home, evidence ["#124"], confidence 0..1, noise false; optional area (short feature area) and costly_reason.
check  validates every line, prints file:line: message, exits 1 on any error. Class ids must be "## C<digits> ..." headings in the taxonomy.
stats  per class: cards, distinct surfaces (card areas, else changed dirs from <dir>/index.jsonl), months, friction sum, moments, refs;
       then the "new" proposals. Marked "recurring" (>= ${RECURRING_MIN_CARDS} cards over >= ${RECURRING_MIN_SURFACES} surfaces) and "costly"
       (any member reverted, reopened, followed by a fix, or carrying costly_reason). Writes <dir>/stats.md.
Default taxonomy: docs/agent-lessons/taxonomy.md at the repo root.`;

export const ENUMS = {
  kind: ['pr', 'issue'],
  layer: ['concept', 'logic', 'process'],
  moment: ['design', 'implement', 'verify', 'declare-done', 'release', 'communicate', 'delegate'],
  home: ['consolidate', 'check', 'rule', 'record', 'skill', 'none'],
};
const REQUIRED_STRINGS = ['ref', 'kind', 'surface', 'mechanism', 'mistake', 'layer', 'moment', 'class', 'catch', 'home'];
const REF = /^#\d+$/;
const REF_LIST_LIMIT = 5;

const DEFAULT_TAXONOMY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/agent-lessons/taxonomy.md');
const blank = v => typeof v !== 'string' || !v.trim();

/** "## C07 Shared contract drift" headings -> Map(id -> title). */
export function parseTaxonomy(markdown) {
  const classes = new Map();
  for (const m of markdown.matchAll(/^##\s+(C\d+)\b[ \t:.-]*(.*)$/gm)) classes.set(m[1], m[2].trim());
  return classes;
}

/** Problems with one card, as short messages; an empty array means the card is valid. */
export function validateCard(card, classIds) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return ['card must be a JSON object'];
  const errors = [];
  for (const key of REQUIRED_STRINGS) if (blank(card[key])) errors.push(`${key} must be a non-empty string`);
  if (!blank(card.ref) && !REF.test(card.ref)) errors.push(`ref must look like #123, got "${card.ref}"`);
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (!blank(card[key]) && !allowed.includes(card[key])) errors.push(`${key} must be one of ${allowed.join('|')}, got "${card[key]}"`);
  }
  if (!blank(card.class)) {
    if (card.class === 'new') {
      if (blank(card.proposed_class)) errors.push('proposed_class is required when class is "new"');
    } else if (!/^C\d+$/.test(card.class)) errors.push(`class must be C<digits> or "new", got "${card.class}"`);
    else if (!classIds.has(card.class)) errors.push(`unknown class ${card.class} (no "## ${card.class} ..." heading in the taxonomy)`);
  }
  if (typeof card.confidence !== 'number' || !(card.confidence >= 0 && card.confidence <= 1)) errors.push('confidence must be a number from 0 to 1');
  if (card.evidence !== undefined && !(Array.isArray(card.evidence) && card.evidence.every(e => typeof e === 'string' && REF.test(e)))) errors.push('evidence must be an array of refs like #123');
  if (card.noise !== undefined && typeof card.noise !== 'boolean') errors.push('noise must be true or false');
  for (const key of ['area', 'costly_reason']) if (card[key] !== undefined && typeof card[key] !== 'string') errors.push(`${key} must be a string`);
  return errors;
}

/** One item is costly when the index shows a revert, a reopen or a follow-up fix, or the card names an owner correction etc. */
export function isCostlyItem(card, entry) {
  const f = entry?.friction ?? {};
  return Boolean(f.revert || f.followUpFix || (f.reopened ?? 0) > 0 || (typeof card.costly_reason === 'string' && card.costly_reason.trim()));
}

/** Surfaces of one card: its own `area` when given (issues change no files), else the changed directories. */
function surfacesOf(card, entry) {
  const area = typeof card.area === 'string' ? card.area.trim().toLowerCase() : '';
  return area ? [`area:${area}`] : (entry?.dirs ?? []).map(d => `dir:${d}`);
}

const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };

/** Per-class numbers. `indexByRef` is a Map ref -> index entry (dirs, month, friction); noise cards are counted apart. */
export function computeStats(cards, indexByRef, taxonomy) {
  const real = cards.filter(c => !c.noise);
  const classes = new Map();
  const proposals = new Map();
  for (const card of real) {
    const entry = indexByRef.get(card.ref);
    if (card.class === 'new') {
      const text = String(card.proposed_class ?? '').trim();
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      const p = proposals.get(key) ?? { text, count: 0, refs: [] };
      p.count += 1;
      p.refs.push(card.ref);
      proposals.set(key, p);
      continue;
    }
    const c = classes.get(card.class) ?? { id: card.class, title: taxonomy.get(card.class) ?? '(not in taxonomy)', count: 0, surfaceSet: new Set(), monthSet: new Set(), friction: 0, costly: false, moments: {}, refs: [] };
    c.count += 1;
    for (const s of surfacesOf(card, entry)) c.surfaceSet.add(s);
    if (isCostlyItem(card, entry)) c.costly = true;
    if (entry?.month) c.monthSet.add(entry.month);
    c.friction = Math.round((c.friction + (entry?.friction?.score ?? 0)) * 100) / 100;
    bump(c.moments, card.moment);
    c.refs.push(card.ref);
    classes.set(card.class, c);
  }
  return {
    total: cards.length,
    noiseCards: cards.length - real.length,
    classes: [...classes.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).map(({ surfaceSet, monthSet, ...c }) => ({
      ...c, surfaces: surfaceSet.size, months: monthSet.size, refs: c.refs.slice(0, REF_LIST_LIMIT),
      recurring: c.count >= RECURRING_MIN_CARDS && surfaceSet.size >= RECURRING_MIN_SURFACES,
    })),
    proposals: [...proposals.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)).map(p => ({ ...p, refs: p.refs.slice(0, REF_LIST_LIMIT) })),
  };
}

export function renderStats(stats) {
  const hist = m => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ');
  const lines = [
    '# Card stats', '',
    `${stats.total} cards (${stats.noiseCards} marked noise, not counted below). recurring = at least ${RECURRING_MIN_CARDS} cards over at least ${RECURRING_MIN_SURFACES} surfaces (card areas, else changed dirs); costly = at least one item reverted, reopened, followed by a fix, or with a costly_reason.`, '',
    '| class | title | cards | surfaces | months | friction | moments | marks | refs |', '|---|---|---|---|---|---|---|---|---|',
    ...stats.classes.map(c => `| ${c.id} | ${c.title} | ${c.count} | ${c.surfaces} | ${c.months} | ${c.friction} | ${hist(c.moments)} | ${[c.recurring && 'recurring', c.costly && 'costly'].filter(Boolean).join(', ')} | ${c.refs.join(' ')} |`),
    '', '## New classes proposed', '',
  ];
  if (!stats.proposals.length) lines.push('None.');
  else lines.push('| proposed class | cards | refs |', '|---|---|---|', ...stats.proposals.map(p => `| ${p.text} | ${p.count} | ${p.refs.join(' ')} |`));
  return `${lines.join('\n')}\n`;
}

async function loadTaxonomy(path) {
  if (existsSync(path)) return parseTaxonomy(await readFile(path, 'utf8'));
  return null;
}

async function cardFiles(workbench) {
  const dir = join(workbench, 'cards');
  if (!existsSync(dir)) throw new Error(`cards directory not found: ${dir}`);
  return (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort().map(f => ({ name: `cards/${f}`, path: join(dir, f) }));
}

async function readCards(files) {
  const cards = [];
  const problems = [];
  const firstSeen = new Map();
  for (const file of files) {
    const lines = (await readFile(file.path, 'utf8')).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const where = `${file.name}:${i + 1}`;
      let card;
      try { card = JSON.parse(line); } catch (err) { problems.push({ where, message: `invalid JSON (${err.message})` }); return; }
      const ref = card && typeof card.ref === 'string' ? card.ref : null;
      if (ref && firstSeen.has(ref)) problems.push({ where, message: `duplicate ref ${ref} (first at ${firstSeen.get(ref)})`, duplicate: true });
      else if (ref) firstSeen.set(ref, where);
      cards.push({ where, card, duplicate: Boolean(ref) && firstSeen.get(ref) !== where });
    });
  }
  return { cards, problems };
}

async function runCheck(values) {
  const workbench = need(values, 'workbench');
  const explicit = values.taxonomy !== undefined;
  const taxonomyPath = resolve(values.taxonomy ?? DEFAULT_TAXONOMY);
  const taxonomy = await loadTaxonomy(taxonomyPath);
  if (!taxonomy && explicit) throw new Error(`taxonomy not found: ${taxonomyPath}`);
  if (!taxonomy) console.error(`note: taxonomy not found at ${taxonomyPath}; only class "new" can pass`);
  const { cards, problems } = await readCards(await cardFiles(workbench));
  const messages = problems.map(p => `${p.where}: ${p.message}`);
  for (const { where, card } of cards) for (const m of validateCard(card, new Set(taxonomy?.keys() ?? []))) messages.push(`${where}: ${m}`);
  messages.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (messages.length) {
    console.log(messages.join('\n'));
    console.log(`\n${messages.length} problem(s) in ${cards.length} card line(s)`);
    return 1;
  }
  console.log(`OK: ${cards.length} cards`);
  return 0;
}

async function runStats(values) {
  const workbench = need(values, 'workbench');
  const explicit = values.taxonomy !== undefined;
  const taxonomyPath = resolve(values.taxonomy ?? DEFAULT_TAXONOMY);
  const taxonomy = (await loadTaxonomy(taxonomyPath)) ?? new Map();
  if (!taxonomy.size && explicit) throw new Error(`taxonomy not found: ${taxonomyPath}`);
  const { cards, problems } = await readCards(await cardFiles(workbench));
  for (const p of problems) console.error(`warning: ${p.where}: ${p.message}`);
  const indexPath = join(workbench, 'index.jsonl');
  if (!existsSync(indexPath)) console.error(`warning: ${indexPath} not found; dirs, months and friction will be empty (run triage.mjs index)`);
  const index = new Map((await readJsonl(indexPath, { optional: true })).map(e => [e.ref, e]));
  const usable = cards.filter(c => !c.duplicate && c.card && typeof c.card === 'object' && typeof c.card.ref === 'string').map(c => c.card);
  const md = renderStats(computeStats(usable, index, taxonomy));
  await writeFile(join(workbench, 'stats.md'), md);
  process.stdout.write(md);
  return 0;
}

async function main() {
  const { values, positionals } = parseCli(process.argv.slice(2), { workbench: { type: 'string' }, taxonomy: { type: 'string' } });
  const [sub] = positionals;
  if (values.help || !sub) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (sub === 'check') return runCheck(values);
  if (sub === 'stats') return runStats(values);
  throw new UsageError(`unknown subcommand "${sub}" (expected check or stats)`);
}

if (isMain(import.meta.url)) await runMain(main);

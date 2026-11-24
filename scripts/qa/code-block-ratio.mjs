#!/usr/bin/env node
/* Read-only measurement helper (#1294): summarizes fenced code-block ratios per deck and per course
   from an exported StudyHub library JSON (or a library directory containing state.json / decks/). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FENCED_RE = /^[ \t]*(`{3,}|~{3,})[^\n`]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/gm;

/** Compute code-block ratio and 3–16 line snippet distribution across decks, grouped by course. */
export function measureCodeBlockRatios(decks = []) {
  const byCourse = new Map();
  const deckRows = [];
  for (const deck of Array.isArray(decks) ? decks : []) {
    if (!deck || deck.archived || deck.systemKind === 'slain') continue;
    const course = String(deck.course ?? deck.folder ?? '未分类').trim() || '未分类';
    const cards = Array.isArray(deck.cards) ? deck.cards : [];
    let withCode = 0;
    let inTargetLines = 0;
    let totalBlocks = 0;
    for (const card of cards) {
      const prompt = String(card?.prompt || '');
      const matches = [...prompt.matchAll(FENCED_RE)];
      if (matches.length) {
        withCode += 1;
        for (const m of matches) {
          totalBlocks += 1;
          const lines = String(m[2] || '').split('\n').filter(Boolean).length;
          if (lines >= 3 && lines <= 16) inTargetLines += 1;
        }
      }
    }
    const ratio = cards.length ? withCode / cards.length : 0;
    deckRows.push({
      id: deck.id || '',
      title: deck.title || '',
      course,
      cards: cards.length,
      withCode,
      ratio: Number(ratio.toFixed(4)),
      totalBlocks,
      inTargetLines,
    });
    const agg = byCourse.get(course) || { course, decks: 0, cards: 0, withCode: 0, totalBlocks: 0, inTargetLines: 0 };
    agg.decks += 1;
    agg.cards += cards.length;
    agg.withCode += withCode;
    agg.totalBlocks += totalBlocks;
    agg.inTargetLines += inTargetLines;
    byCourse.set(course, agg);
  }
  const courses = [...byCourse.values()].map(row => ({
    ...row,
    ratio: row.cards ? Number((row.withCode / row.cards).toFixed(4)) : 0,
    targetLineRatio: row.totalBlocks ? Number((row.inTargetLines / row.totalBlocks).toFixed(4)) : 0,
  }));
  return { courses, decks: deckRows };
}

function loadDecksFromPath(targetPath) {
  const st = statSync(targetPath);
  if (st.isFile()) {
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.decks) ? parsed.decks : [];
  }
  const decksDir = join(targetPath, 'decks');
  try {
    if (statSync(decksDir).isDirectory()) {
      return readdirSync(decksDir)
        .filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(decksDir, name), 'utf8')));
    }
  } catch { /* fall back to state.json */ }
  const stateFile = join(targetPath, 'state.json');
  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
  return Array.isArray(parsed?.decks) ? parsed.decks : [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const inputPath = args.find(arg => !arg.startsWith('-'));
  if (!inputPath) {
    console.error('Usage: node scripts/qa/code-block-ratio.mjs <library-dir-or-backup.json> [--json]');
    process.exit(2);
  }
  const report = measureCodeBlockRatios(loadDecksFromPath(inputPath));
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const c of report.courses) {
      console.log(`${c.course}: ${c.withCode}/${c.cards} (${(c.ratio * 100).toFixed(1)}%) cards with fenced code; ${c.inTargetLines}/${c.totalBlocks} blocks in 3–16 lines`);
    }
  }
}

/* node scripts/report/build.mjs <deck.json> --out <file.html>
   Builds one self-contained HTML deck (inline CSS and JS, images inlined from files next to the deck json, no network). See README.md. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDeck } from "./deck.mjs";

/** Build a deck file; returns { out, bytes, slides }. */
export async function buildDeck(deckPath, outPath) {
  const file = resolve(deckPath);
  let deck;
  try { deck = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")); } catch (error) { throw new Error(`deck: cannot read ${file}: ${error.message}`); }
  const html = await renderDeck(deck, { baseDir: dirname(file) });
  const out = resolve(outPath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html, "utf8");
  return { out, bytes: Buffer.byteLength(html), slides: (html.match(/class="dk-slide /g) ?? []).length };
}

function parseArgs(argv) {
  const args = { deck: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (!args.deck) args.deck = argv[i];
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { deck, out } = parseArgs(process.argv.slice(2));
  if (!deck || !out) { console.error("usage: node scripts/report/build.mjs <deck.json> --out <file.html>"); process.exit(2); }
  try {
    const result = await buildDeck(deck, out);
    console.log(`${result.out}  ${result.slides} slides, ${(result.bytes / 1024).toFixed(1)} KB`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

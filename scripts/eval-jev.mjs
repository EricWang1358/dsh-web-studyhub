#!/usr/bin/env node
/* Measure the experimental Jev layer on labelled data.

     JEV_API_KEY=<your key> node scripts/eval-jev.mjs <dataset.json> [--features courseSuggest,preReview,outlineNoise,levelCheck]
                                                                    [--threshold 0.8] [--out report.json] [--yes]
     node scripts/eval-jev.mjs --skeleton <copy of a library folder> --out my-dataset.json      (no key, no network)

   Without JEV_API_KEY it does NOTHING (no network, no files) and says so. It never prints the key. For each experiment in the dataset it runs
   the REAL feature code (the same requests StudyHub would send) and reports accuracy, precision and recall, F1 and calibration (ECE), plus
   what it cost in tokens (never money). The dataset format and how to label your own library COPY are in tests/fixtures/jev-eval/README.md.

   The dataset's text is SENT to Jev (TypeSafe's cloud). The public example dataset under tests/fixtures/jev-eval/ is neutral and needs no
   confirmation; any other dataset needs --yes, because it may hold your own material. The script never touches your real library or DSH home:
   settings live in memory for the run, and the --skeleton option reads a folder you point it at (use a copy). */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_FEATURES } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { jevBaseUrl } from '../lib/jev.js';
import { evaluate, formatReport, skeletonFromLibrary, validateDataset } from '../lib/jev-eval.js';
import { Store } from '../lib/store.js';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const has = name => args.includes(`--${name}`);
const valueFlags = new Set(['--features', '--threshold', '--out', '--skeleton']);
const positional = args.filter((arg, index) => !arg.startsWith('--') && !valueFlags.has(args[index - 1]));
const stop = (code, text) => { console.log(text); process.exit(code); };

if (has('skeleton')) {
  const folder = flag('skeleton'), out = flag('out');
  if (!folder || !out) stop(2, 'Usage: node scripts/eval-jev.mjs --skeleton <copy of a library folder> --out <file.json>');
  const skeleton = skeletonFromLibrary(await new Store(resolve(folder)).read());
  await writeFile(resolve(out), `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8');
  stop(0, `Wrote ${out}: ${skeleton.features.courseSuggest.items.length} sources and ${skeleton.features.levelCheck.items.length} questions to label. Fill in the blank labels (see tests/fixtures/jev-eval/README.md), then run the evaluation on it with --yes.`);
}

const key = String(process.env.JEV_API_KEY || '').trim();
if (!key) stop(0, 'JEV_API_KEY is not set: nothing was done. Set it to your own Jev key to evaluate the experiments on a labelled dataset (see tests/fixtures/jev-eval/README.md).');

const [path] = positional;
if (!path) stop(2, 'Usage: node scripts/eval-jev.mjs <dataset.json> [--features a,b] [--threshold 0.8] [--out report.json] [--yes]');
let dataset;
try { dataset = JSON.parse(await readFile(resolve(path), 'utf8')); }
catch (error) { stop(2, `The dataset could not be read (${error.code === 'ENOENT' ? 'file not found' : 'not valid JSON'}): ${path}`); }
try { validateDataset(dataset); } catch (error) { stop(2, error.message); }

const features = flag('features') ? flag('features').split(',').map(name => name.trim()).filter(Boolean) : undefined;
if (features?.some(name => !JEV_FEATURES.includes(name))) stop(2, `Unknown feature in --features (expected ${JEV_FEATURES.join(', ')})`);
const threshold = flag('threshold') === undefined ? 0.8 : Number(flag('threshold'));
if (!(threshold >= 0.5 && threshold <= 0.99)) stop(2, '--threshold must be a number from 0.5 to 0.99');

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/jev-eval') + sep;
const items = Object.entries(dataset.features).filter(([name]) => !features || features.includes(name)).reduce((sum, [, section]) => sum + section.items.length, 0);
if (!resolve(path).startsWith(fixtures) && !has('yes'))
  stop(2, `This dataset (${items} items) is not the public example one, so its text would be sent to Jev (TypeSafe's cloud, ${new URL(jevBaseUrl()).host}) and may include your own material. Run it on a COPY you are happy to send, and add --yes to confirm.`);

const meter = { record: async () => {} };
const runtime = createJevRuntime({ usage: meter, settings: async () => ({ key, keySource: 'env', enabled: true, features: Object.fromEntries(JEV_FEATURES.map(name => [name, true])), threshold, confirmedAt: 'eval' }) });
console.log(`Evaluating ${items} items against ${new URL(jevBaseUrl()).host} ...`);
const report = await evaluate({ dataset, runtime, threshold, features });
console.log(`\n${formatReport(report)}`);
if (flag('out')) await writeFile(resolve(flag('out')), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

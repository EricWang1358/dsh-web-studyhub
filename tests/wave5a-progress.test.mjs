import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, #101: one progress bar (ProgressBar, fill drawn with transform) and one stacked bar (StackedBar); nothing animates width.
const walk = (dir, extensions) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, extensions) : extensions.some(ext => entry.name.endsWith(ext)) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const jsx = walk('ui', ['.jsx']).map(file => ({ file, text: read(file) }));
const css = walk('ui', ['.css']).map(file => ({ file, text: read(file).replace(/\/\*[\s\S]*?\*\//g, '') }));

test('only ProgressBar renders a progressbar: no native <progress>, no hand-written role="progressbar"', () => {
  const found = jsx.filter(({ file, text }) => file !== 'ui/components/Progress.jsx' && /role="progressbar"|<progress[\s>]/.test(text)).map(({ file }) => file);
  assert.deepEqual(found, []);
});

test('the per-feature bar classes are gone', () => {
  const names = ['audio-quota-track', 'rubric-bar', 'tr-job__bar', 'tour-pop__bar', 'jev-prob__bar', 'model-usage__bar', 'usage-meter', 'exam-bar-fill', 'exam-bar-track',
    'dash-mastery-fill', 'dash-mastery-track', 'coach-levels', 'oral-band-bar', 'usage-seg', 'result-breakdown-track'];
  const found = [...jsx, ...css].flatMap(({ file, text }) => names.filter(name => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)).map(name => `${file}: ${name}`));
  assert.deepEqual(found, []);
  // audio-bar is the audio import's own bar: no other feature borrows it.
  const borrowed = jsx.filter(({ file, text }) => !/^ui\/(?:audio\/|Audio)/.test(file) && /(?<![\w-])audio-bar(?![\w-])/.test(text)).map(({ file }) => file);
  assert.deepEqual(borrowed, []);
});

test('no bar animates its width, flex-grow or background-size', () => {
  const bad = [];
  for (const { file, text } of css) for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = match;
    if (!/(?:bar|track|fill|meter|progress|levels|seg)(?![a-z])/i.test(selector) || /sh-seg\b|sh-seg__|review-tick|tour-(?:shade|ring|spot)/.test(selector)) continue;
    if (/transition[^;]*\b(?:width|flex-grow|background-size)\b/.test(body)) bad.push(`${file}: ${selector.trim()}`);
  }
  assert.deepEqual(bad, []);
});

test('the card progress of a review is a ProgressBar, not a background gradient', () => {
  assert.match(read('ui/Review.jsx'), /<ProgressBar[^>]*className="card-progress"/);
  assert.doesNotMatch(read('ui/review/question.css'), /var\(--progress/);
});

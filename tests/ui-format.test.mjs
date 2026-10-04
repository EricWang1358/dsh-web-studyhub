import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// #126: one set of date / clock / duration / size / number formatters, all following the interface language.
const m = await loadUi(`export * from './ui/format.js'; export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const KB = 1024, MB = KB * 1024, GB = MB * 1024;

test('formatClock is m:ss rounded DOWN to whole seconds, h:mm:ss from one hour, never negative', () => {
  assert.equal(m.formatClock(0), '0:00');
  assert.equal(m.formatClock(999), '0:00', 'a part of a second is not shown early');
  assert.equal(m.formatClock(1000), '0:01');
  assert.equal(m.formatClock(65_400), '1:05');
  assert.equal(m.formatClock(59 * 60_000 + 59_999), '59:59');
  assert.equal(m.formatClock(3_600_000), '1:00:00');
  assert.equal(m.formatClock(3_725_000), '1:02:05');
  assert.equal(m.formatClock(-5000), '0:00');
  assert.equal(m.formatClock(undefined), '0:00');
  assert.equal(m.formatClock(NaN), '0:00');
});

test('formatDuration says a length in words and nothing for a missing one', () => {
  m.setUiLanguage('zh');
  assert.equal(m.formatDuration(260_000), '4 分 20 秒');
  assert.equal(m.formatDuration(45_000), '45 秒');
  assert.equal(m.formatDuration(60_000), '1 分钟');
  assert.equal(m.formatDuration(3_900_000), '1 小时 5 分');
  assert.equal(m.formatDuration(7_200_000), '2 小时');
  assert.equal(m.formatDuration(0), '不到 1 秒');
  assert.equal(m.formatDuration(undefined), '');
  assert.equal(m.formatDuration(NaN), '');
  assert.equal(m.formatDuration(-1), '');
  m.setUiLanguage('en');
  assert.equal(m.formatDuration(260_000), '4 min 20 sec');
  assert.equal(m.formatDuration(3_900_000), '1 h 5 min');
  m.setUiLanguage('zh');
});

test('formatElapsed counts up a running thing in seconds, then minutes and seconds', () => {
  m.setUiLanguage('zh');
  assert.equal(m.formatElapsed(0), '0 秒');
  assert.equal(m.formatElapsed(45_900), '45 秒');
  assert.equal(m.formatElapsed(125_000), '2 分 5 秒');
  assert.equal(m.formatElapsed(3_725_000), '1 小时 2 分');
  assert.equal(m.formatElapsed(-1), '0 秒');
  m.setUiLanguage('en');
  assert.equal(m.formatElapsed(125_000), '2 min 5 sec');
  m.setUiLanguage('zh');
});

test('formatAgo is relative for a day, then a date and time; the same rule everywhere', () => {
  const now = Date.parse('2026-10-04T12:00:00Z'), at = minutes => new Date(now - minutes * 60_000).toISOString();
  m.setUiLanguage('zh');
  assert.equal(m.formatAgo(at(0), now), '刚刚');
  assert.equal(m.formatAgo(at(1), now), '1 分钟前');
  assert.equal(m.formatAgo(at(3), now), '3 分钟前');
  assert.equal(m.formatAgo(at(60), now), '1 小时前');
  assert.equal(m.formatAgo(at(125), now), '2 小时前');
  assert.match(m.formatAgo(at(60 * 24 * 3), now), /\d/);
  assert.doesNotMatch(m.formatAgo(at(60 * 24 * 3), now), /前/);
  assert.equal(m.formatAgo(undefined, now), '');
  assert.equal(m.formatAgo('not a date', now), '');
  assert.equal(m.formatAgo(now - 3 * 60_000, now), '3 分钟前', 'milliseconds work too');
  assert.equal(m.formatAgo(now + 60_000, now), '刚刚', 'a clock a little ahead is just now');
  m.setUiLanguage('en');
  assert.equal(m.formatAgo(at(3), now), '3 minutes ago');
  assert.equal(m.formatAgo(at(60), now), '1 hour ago');
  m.setUiLanguage('zh');
});

test('formatBytes is 1024-based, one decimal below ten, whole above, one style everywhere', () => {
  assert.equal(m.formatBytes(0), '0 B');
  assert.equal(m.formatBytes(900), '900 B');
  assert.equal(m.formatBytes(1536), '1.5 KB');
  assert.equal(m.formatBytes(KB), '1 KB');
  assert.equal(m.formatBytes(512 * KB), '512 KB');
  assert.equal(m.formatBytes(8 * MB), '8 MB');
  assert.equal(m.formatBytes(23.5 * MB), '24 MB');
  assert.equal(m.formatBytes(4.25 * MB), '4.3 MB');
  assert.equal(m.formatBytes(820 * MB), '820 MB');
  assert.equal(m.formatBytes(1200 * MB), '1.2 GB');
  assert.equal(m.formatBytes(1.25 * GB), '1.3 GB');
  assert.equal(m.formatBytes(-4), '0 B');
  assert.equal(m.formatBytes(undefined), '0 B');
  assert.equal(m.formatBytes(1023 * KB), '1023 KB', 'a unit changes at 1024, not before');
});

test('formatNumber follows the interface language and ignores what is not a number', () => {
  m.setUiLanguage('en');
  assert.equal(m.formatNumber(1234567), '1,234,567');
  assert.equal(m.formatNumber(12.345, { maximumFractionDigits: 1 }), '12.3');
  assert.equal(m.formatNumber(1234, { useGrouping: false }), '1234');
  m.setUiLanguage('zh');
  assert.equal(m.formatNumber(1234567), '1,234,567');
  assert.equal(m.formatNumber(0.5, { style: 'percent' }), '50%');
  assert.equal(m.formatNumber(NaN), '');
  assert.equal(m.formatNumber(undefined), '');
  assert.equal(m.formatNumber('12'), '12', 'a numeric string is a number');
});

test('formatDateTime has three shapes, follows the language and is empty for a bad value', () => {
  const value = '2026-10-04T08:05:00';
  m.setUiLanguage('en');
  assert.equal(m.formatDateTime(value, 'stamp'), '10/4, 08:05 AM');
  assert.equal(m.formatDateTime(value, 'short'), 'Oct 4, 2026, 08:05 AM');
  assert.equal(m.formatDateTime(value, 'day'), 'Oct 4, 2026');
  m.setUiLanguage('zh');
  assert.match(m.formatDateTime(value, 'short'), /2026年10月4日/);
  assert.match(m.formatDateTime(value, 'day'), /2026年10月4日/);
  assert.match(m.formatDateTime(value, 'stamp'), /10\/4/);
  assert.doesNotMatch(m.formatDateTime(value, 'stamp'), /[A-Za-z]/);
  assert.equal(m.formatDateTime(value), m.formatDateTime(value, 'short'), 'short is the default');
  assert.equal(m.formatDateTime('nonsense', 'short'), '');
  assert.equal(m.formatDateTime(undefined, 'day'), '');
  assert.equal(m.formatDateTime(new Date(2026, 9, 4, 8, 5), 'stamp'), m.formatDateTime(value, 'stamp'), 'a Date works too');
  assert.equal(m.formatDateTime(Date.parse(value), 'day'), m.formatDateTime(value, 'day'), 'so does a timestamp');
  assert.doesNotMatch(m.formatDateTime(value, 'day'), /[A-Za-z]/);
});

test('English output carries no Chinese', () => {
  m.setUiLanguage('en');
  for (const text of [m.formatDuration(3_900_000), m.formatElapsed(125_000), m.formatAgo(Date.now() - 180_000), m.formatBytes(5 * MB), m.formatDateTime(Date.now(), 'short')])
    assert.doesNotMatch(text, han, text);
  m.setUiLanguage('zh');
});

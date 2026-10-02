import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageFrequency, usageFrequencyPath, USAGE_LIMITS, localDay } from '../lib/usage-frequency.js';
import { StudyService } from '../lib/service.js';

/* The usage frequency record (Settings › Advanced › Usage frequency record): a local, opt-in count of how often each control is used.
   Storage side: <DSH home>/study/usage-frequency.json, written atomically, bounded, never in the library, nothing at all while it is off. */

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-usage-home-'));
  const before = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); });
  return home;
}
const exists = path => access(path).then(() => true, () => false);
const DAY = 86400000;
const clock = (iso = '2026-10-03T12:00:00') => { let at = new Date(iso).getTime(); return { now: () => at, advance: ms => { at += ms; }, set: value => { at = new Date(value).getTime(); } }; };
const day = (clockNow, back = 0) => localDay(clockNow() - back * DAY);

test('off by default: nothing is created, nothing is recorded, and a record sent anyway is refused', async t => {
  const home = await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now });
  assert.equal(usageFrequencyPath(), join(home, 'study', 'usage-frequency.json'));
  const status = await usage.status();
  assert.equal(status.enabled, false);
  assert.equal(status.paused, false);
  assert.equal(status.hasData, false);
  assert.equal(status.daysWithData, 0);
  const result = await usage.record([{ key: 'nav.library', area: 'library', day: day(c.now), n: 3 }]);
  assert.deepEqual({ accepted: result.accepted, enabled: result.enabled }, { accepted: 0, enabled: false });
  assert.equal(await exists(usageFrequencyPath()), false, 'no file while the switch is off');
  assert.equal(await exists(join(home, 'study')), false, 'not even the folder');
});

test('turning it on records counts per control and day; the same control and day add up; the file holds nothing else', async t => {
  await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now }), today = day(c.now), yesterday = day(c.now, 1);
  assert.equal((await usage.set({ enabled: true })).enabled, true);
  const result = await usage.record([
    { key: 'nav.library', area: 'library', day: today, n: 2 },
    { key: 'nav.library', area: 'review', day: today, n: 1 },
    { key: 'nav.library', area: 'library', day: yesterday, n: 4 },
    { key: 'review.grade', area: 'review', day: today, n: 5 },
  ]);
  assert.equal(result.accepted, 4);
  const state = await usage.read();
  assert.equal(state.controls['nav.library'].total, 7);
  assert.deepEqual(state.controls['nav.library'].days, { [today]: 3, [yesterday]: 4 });
  assert.equal(state.controls['nav.library'].first, yesterday);
  assert.equal(state.controls['nav.library'].last, today);
  assert.equal(state.areas.review.days[today], 6, 'the page the use happened on, per day');
  const status = await usage.status();
  assert.deepEqual({ enabled: status.enabled, hasData: status.hasData, daysWithData: status.daysWithData, since: status.since }, { enabled: true, hasData: true, daysWithData: 2, since: today });
  // Only counts, days and keys: no time of day, no text.
  const raw = JSON.parse(await readFile(usageFrequencyPath(), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['areas', 'controls', 'enabled', 'paused', 'since', 'version']);
  for (const control of Object.values(raw.controls)) assert.deepEqual(Object.keys(control).sort(), ['days', 'first', 'last', 'older', 'total']);
});

test('paused means refused like off, switched off keeps what was recorded, and clear deletes it without touching the switch', async t => {
  await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now }), today = day(c.now);
  await usage.set({ enabled: true });
  await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }]);
  assert.equal((await usage.set({ paused: true })).paused, true);
  assert.equal((await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 9 }])).accepted, 0);
  assert.equal((await usage.read()).controls['nav.library'].total, 1);
  await usage.set({ paused: false });
  assert.equal((await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }])).accepted, 1);
  await usage.set({ enabled: false });
  assert.equal((await usage.status()).hasData, true, 'what was recorded stays until it is deleted');
  assert.equal((await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }])).accepted, 0);
  await usage.set({ enabled: true });
  const cleared = await usage.clear();
  assert.equal(cleared.hasData, false);
  assert.equal(cleared.enabled, true, 'deleting the records is not switching it off');
  assert.deepEqual((await usage.read()).controls, {});
});

test('records are validated: a key must be a short plain control key, an area a known page, a day a recent local date, a count a small whole number', async t => {
  await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now }), today = day(c.now);
  await usage.set({ enabled: true });
  const bad = [
    { key: '', area: 'library', day: today, n: 1 }, { key: 'x'.repeat(200), area: 'library', day: today, n: 1 },
    { key: 'https://example.com/a?b=c', area: 'library', day: today, n: 1 }, { key: 'C:\\Users\\me\\file.pdf', area: 'library', day: today, n: 1 },
    { key: 'me@example.com', area: 'library', day: today, n: 1 }, { key: 'a\nb', area: 'library', day: today, n: 1 }, { key: '<script>', area: 'library', day: today, n: 1 },
    { key: 5, area: 'library', day: today, n: 1 }, { key: 'nav.library', area: 'library', day: '2026-10-03T10:11:12', n: 1 },
    { key: 'nav.library', area: 'library', day: 'yesterday', n: 1 }, { key: 'nav.library', area: 'library', day: day(c.now, -5), n: 1 },
    { key: 'nav.library', area: 'library', day: today, n: 0 }, { key: 'nav.library', area: 'library', day: today, n: -2 },
    { key: 'nav.library', area: 'library', day: today, n: 1.5 }, { key: 'nav.library', area: 'library', day: today, n: 1e9 }, null, 'nav.library',
  ];
  const result = await usage.record(bad);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejected, bad.length);
  assert.deepEqual((await usage.read()).controls, {});
  const odd = await usage.record([{ key: 'nav.library', area: 'someone’s course', day: today, n: 1, extra: 'My thesis notes.pdf' }]);
  assert.equal(odd.accepted, 1);
  const state = await usage.read();
  assert.deepEqual(Object.keys(state.areas), ['other'], 'an unknown area is filed under other, never kept as given');
  assert.ok(!(await readFile(usageFrequencyPath(), 'utf8')).includes('thesis'), 'an extra field is dropped, not stored');
  assert.ok(USAGE_LIMITS.recordsPerBatch >= 100);
  const many = Array.from({ length: USAGE_LIMITS.recordsPerBatch + 50 }, (_, i) => ({ key: `k.${i}`, area: 'library', day: today, n: 1 }));
  assert.equal((await usage.record(many)).accepted, USAGE_LIMITS.recordsPerBatch, 'a batch is bounded');
});

test('at most 800 distinct keys: the rest are folded into one "other" key, and a known key keeps counting', async t => {
  await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now }), today = day(c.now);
  assert.equal(USAGE_LIMITS.keys, 800);
  await usage.set({ enabled: true });
  for (let start = 0; start < USAGE_LIMITS.keys + 40; start += USAGE_LIMITS.recordsPerBatch)
    await usage.record(Array.from({ length: Math.min(USAGE_LIMITS.recordsPerBatch, USAGE_LIMITS.keys + 40 - start) }, (_, i) => ({ key: `derived/button/k${start + i}`, area: 'library', day: today, n: 1 })));
  const state = await usage.read();
  const keys = Object.keys(state.controls);
  assert.ok(keys.length <= USAGE_LIMITS.keys + 1, `${keys.length} keys`);
  assert.ok(state.controls.other.total >= 40, 'what did not fit is counted under other');
  await usage.record([{ key: 'derived/button/k0', area: 'library', day: today, n: 2 }]);
  assert.equal((await usage.read()).controls['derived/button/k0'].total, 3);
  const everything = Object.values((await usage.read()).controls).reduce((sum, control) => sum + control.total, 0);
  assert.equal(everything, USAGE_LIMITS.keys + 40 + 2, 'nothing is lost, only folded');
});

test('only 180 days of day buckets are kept: older days fold into the key\'s total, so "all time" stays right', async t => {
  await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now });
  assert.equal(USAGE_LIMITS.days, 180);
  await usage.set({ enabled: true });
  const old = day(c.now, 150), recent = day(c.now, 1), ancient = day(c.now, 300);
  await usage.record([{ key: 'nav.library', area: 'library', day: old, n: 4 }, { key: 'nav.library', area: 'library', day: recent, n: 1 }]);
  // A record whose own day is already outside the window is accepted but folded straight away; beyond a year it is refused.
  assert.equal((await usage.record([{ key: 'nav.library', area: 'library', day: ancient, n: 2 }, { key: 'nav.library', area: 'library', day: day(c.now, 500), n: 7 }])).accepted, 1);
  assert.equal((await usage.read()).controls['nav.library'].older, 2);
  c.advance(60 * DAY); // the 150-day bucket is now 210 days old
  await usage.record([{ key: 'nav.library', area: 'library', day: day(c.now), n: 1 }]);
  const control = (await usage.read()).controls['nav.library'];
  assert.equal(control.older, 6, 'the 210-day-old bucket folded in with the one that was already too old');
  assert.ok(!(old in control.days) && !(ancient in control.days));
  assert.equal(control.total, 8, 'total counts everything');
  assert.equal(control.first, ancient, 'first seen is kept');
  assert.equal(Object.values(control.days).reduce((a, b) => a + b, 0) + control.older, control.total);
});

test('the file stays bounded: a pile of day buckets across keys folds the oldest days first', async t => {
  await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now });
  await usage.set({ enabled: true });
  const cells = [];
  for (let key = 0; key < 400; key += 1) for (let back = 0; back < 120; back += 2) cells.push({ key: `derived/button/b${key}`, area: 'library', day: day(c.now, back), n: 1 });
  for (let at = 0; at < cells.length; at += USAGE_LIMITS.recordsPerBatch) await usage.record(cells.slice(at, at + USAGE_LIMITS.recordsPerBatch));
  const state = await usage.read();
  const count = Object.values(state.controls).reduce((sum, control) => sum + Object.keys(control.days).length, 0);
  assert.ok(count <= USAGE_LIMITS.cells, `${count} cells`);
  assert.equal(Object.values(state.controls).reduce((sum, control) => sum + control.total, 0), cells.length, 'folded, not lost');
  assert.ok((await stat(usageFrequencyPath())).size < 1.5 * 1024 * 1024, 'bounded in bytes too');
});

test('writes are atomic and queued: parallel records from several tabs add up, and no temp file is left', async t => {
  const home = await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now }), today = day(c.now);
  await usage.set({ enabled: true });
  await Promise.all(Array.from({ length: 40 }, (_, i) => usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }, { key: `nav.k${i % 3}`, area: 'library', day: today, n: 2 }])));
  const state = await usage.read();
  assert.equal(state.controls['nav.library'].total, 40);
  assert.equal(state.controls['nav.k0'].total + state.controls['nav.k1'].total + state.controls['nav.k2'].total, 80);
  assert.deepEqual((await readdir(join(home, 'study'))).filter(name => name.endsWith('.tmp')), []);
  JSON.parse(await readFile(usageFrequencyPath(), 'utf8'));
  // A second store object on the same file (another tab of another window of the same host) reads what the first wrote.
  assert.equal((await createUsageFrequency({ now: c.now }).read()).controls['nav.library'].total, 40);
});

test('a damaged file never crashes anything: it reads as off and empty, and starting again works', async t => {
  await withHome(t);
  const c = clock(), usage = createUsageFrequency({ now: c.now }), today = day(c.now);
  await usage.set({ enabled: true });
  await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }]);
  for (const damaged of ['{ not json', '', '[]', '{"version":1,"enabled":"yes","controls":{"a":{"days":"x","total":-4}}}', '{"version":99,"controls":5}']) {
    await writeFile(usageFrequencyPath(), damaged);
    const status = await usage.status();
    assert.equal(typeof status.enabled, 'boolean');
    assert.deepEqual(Object.keys((await usage.read()).controls).filter(key => key === 'a'), [], damaged);
    assert.equal((await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }])).enabled, false, 'damaged = off until switched on again');
  }
  await writeFile(usageFrequencyPath(), '{ not json');
  assert.equal((await usage.set({ enabled: true })).enabled, true);
  assert.equal((await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 3 }])).accepted, 1);
  assert.equal((await usage.read()).controls['nav.library'].total, 3);
});

test('the file is not in the library: a service export, backup and snapshot know nothing about it', async t => {
  await withHome(t);
  const root = await mkdtemp(join(tmpdir(), 'study-usage-lib-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const before = await service.call('snapshot');
  await service.call('usage.frequency.set', { enabled: true });
  await service.call('usage.frequency.record', { records: [{ key: 'nav.library', area: 'library', day: localDay(Date.now()), n: 5 }] });
  const after = await service.call('snapshot');
  assert.equal(after.fingerprint, before.fingerprint, 'the snapshot fingerprint does not move when usage is recorded');
  assert.ok(!JSON.stringify(await service.call('export')).includes('usage'), 'not in the export');
  assert.deepEqual((await readdir(root)).filter(name => /usage/.test(name)), [], 'nothing in the library folder');
  assert.ok(!('usage' in after) && !('usageFrequency' in after), 'the snapshot carries nothing of it');
});

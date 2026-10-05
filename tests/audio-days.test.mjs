import test from 'node:test';
import assert from 'node:assert/strict';
import { keyId, recentDays, summarizeAudioUsage, validTimeZone } from '../lib/audio-dashboard.js';
import { AUDIO_DEFAULTS } from '../lib/audio-settings.js';

/* WP-AU #210: "today" and the seven-day chart are the learner's own calendar days; the Gemini free quota keeps Google's
   day (it turns over at midnight Pacific time) and says so, with the reset moment in local time. */

const settings = { ...AUDIO_DEFAULTS, freeKey: 'AIza_test_free_00000000000000', paidKey: 'AIza_test_paid_00000000000000' };
const at = iso => Date.parse(iso);
const request = (tier, when, extra = {}) => ({ type: 'request', tier, keyId: keyId(settings[`${tier}Key`]), at: at(when), model: settings.transcribeModel, status: 200, ...extra });
const free = usage => usage.providers.find(provider => provider.tier === 'free');

test('Singapore: it is already 5 October, the chart ends on it, and the free quota is still on 4 October Pacific', () => {
  const now = at('2026-10-05T02:00:00Z'); // 10:00 in Singapore, 19:00 on 4 October in Los Angeles
  const usage = summarizeAudioUsage([request('free', '2026-10-05T01:30:00Z'), request('free', '2026-10-04T23:30:00Z'), request('free', '2026-10-04T10:00:00Z')],
    { ...settings, dailyLimits: { [settings.transcribeModel]: 20 } }, now, { timeZone: 'Asia/Singapore' });
  assert.equal(usage.today, '2026-10-05');
  assert.equal(usage.trend.length, 7);
  assert.equal(usage.trend.at(-1).date, '2026-10-05', 'the last column is the local today');
  assert.equal(usage.trend.at(-1).free, 2, 'two requests fall on the local 5 October (07:30 and 09:30)');
  assert.equal(usage.trend.at(-2).free, 1);
  assert.equal(free(usage).today.requests, 2, 'today = the local day');
  assert.equal(usage.quotaDay.day, '2026-10-04');
  assert.equal(usage.quotaDay.timeZone, 'America/Los_Angeles');
  assert.equal(usage.quotaDay.resetTime, '15:00', 'Pacific midnight is 15:00 in Singapore in October');
  assert.equal(usage.quotaDay.resetsAt, at('2026-10-05T07:00:00Z'));
  // The quota counts Google's day: the three requests are all on 4 October Pacific (10:00Z is 03:00 PDT on the 4th).
  assert.equal(free(usage).models.find(model => model.model === settings.transcribeModel).used, 3);
  assert.equal(free(usage).models.find(model => model.model === settings.transcribeModel).remaining, 17);
  assert.equal(free(usage).quotaDay.day, '2026-10-04');
});

test('Los Angeles: the local day and the quota day are the same day', () => {
  const now = at('2026-10-05T10:00:00Z'); // 03:00 PDT
  const usage = summarizeAudioUsage([request('free', '2026-10-05T08:00:00Z'), request('free', '2026-10-05T06:30:00Z')], settings, now, { timeZone: 'America/Los_Angeles' });
  assert.equal(usage.today, '2026-10-05');
  assert.equal(usage.trend.at(-1).date, '2026-10-05');
  assert.equal(usage.trend.at(-1).free, 1, 'the 06:30Z request is still 4 October at 23:30 PDT');
  assert.equal(usage.quotaDay.day, usage.today);
  assert.equal(usage.quotaDay.resetTime, '00:00');
});

test('London: summer and winter shift the local reset time, not the quota day', () => {
  const summer = summarizeAudioUsage([], settings, at('2026-10-05T10:00:00Z'), { timeZone: 'Europe/London' });
  assert.equal(summer.today, '2026-10-05');
  assert.equal(summer.quotaDay.resetTime, '08:00', '07:00Z is 08:00 in London summer time');
  const winter = summarizeAudioUsage([], settings, at('2026-12-05T10:00:00Z'), { timeZone: 'Europe/London' });
  assert.equal(winter.today, '2026-12-05');
  assert.equal(winter.quotaDay.resetTime, '08:00', '08:00Z is 08:00 in London winter time');
  assert.equal(winter.quotaDay.day, '2026-12-05');
});

test('the clocks go forward in London: no day is repeated or lost and requests land on their local day', () => {
  const now = at('2026-03-30T05:00:00Z'); // the day after the 23-hour day
  const usage = summarizeAudioUsage([
    request('free', '2026-03-29T00:30:00Z'), request('free', '2026-03-29T22:30:00Z'), request('free', '2026-03-29T23:30:00Z'), request('free', '2026-03-28T12:00:00Z'),
  ], settings, now, { timeZone: 'Europe/London' });
  assert.deepEqual(usage.trend.map(day => day.date), ['2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30']);
  assert.equal(usage.trend.find(day => day.date === '2026-03-29').free, 2, '00:30 GMT and 23:30 BST are both on the 29th');
  assert.equal(usage.trend.find(day => day.date === '2026-03-30').free, 1, '23:30Z is 00:30 BST on the 30th');
  assert.equal(usage.trend.find(day => day.date === '2026-03-28').free, 1);
});

test('the clocks go back in Los Angeles: the 25-hour day is one day, in the chart and in the quota', () => {
  const now = at('2026-11-02T20:00:00Z');
  const usage = summarizeAudioUsage([request('free', '2026-11-01T06:30:00Z'), request('free', '2026-11-01T08:30:00Z'), request('free', '2026-11-01T20:00:00Z')],
    settings, now, { timeZone: 'America/Los_Angeles' });
  assert.deepEqual(usage.trend.map(day => day.date), ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(usage.trend.find(day => day.date === '2026-10-31').free, 1, '06:30Z is 23:30 PDT on 31 October');
  assert.equal(usage.trend.find(day => day.date === '2026-11-01').free, 2, '08:30Z (01:30 PDT) and 20:00Z are on 1 November');
  assert.equal(usage.quotaDay.day, '2026-11-02');
  assert.equal(free(usage).models.find(model => model.model === settings.transcribeModel).used, 0);
});

test('every day of a calendar run is listed once, whatever the zone', () => {
  assert.deepEqual(recentDays('2026-03-02', 7), ['2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.deepEqual(recentDays('2028-03-01', 3), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.equal(validTimeZone('Asia/Singapore'), 'Asia/Singapore');
  assert.equal(validTimeZone('Not/AZone'), undefined);
  assert.equal(validTimeZone(undefined), undefined);
});

test('requests of a provider the console does not know are counted as "other" in today and in the chart', () => {
  const now = at('2026-10-05T10:00:00Z');
  const usage = summarizeAudioUsage([{ type: 'request', tier: 'other', keyId: '', at: at('2026-10-05T09:00:00Z'), model: 'x', status: 200, host: 'api.example' },
    request('free', '2026-10-05T09:00:00Z')], settings, now, { timeZone: 'Europe/London' });
  assert.equal(usage.other.today.requests, 1);
  assert.equal(usage.trend.at(-1).other, 1);
  assert.ok(usage.since !== null);
});

import { USAGE_AREAS, USAGE_NAV_GROUPS, USAGE_REGISTRY, USAGE_TIER_NAMES, USAGE_TIERS, usageEntry } from './usage-registry.js';
import { localDay } from './usage-frequency.js';

/* The personal usage report (Settings › Advanced › My usage report), computed from the aggregated counts of the record alone: a ranked
   list of the most used controls, shares by page and by tier, the daily rhythm, the controls that were never used, and a few observations
   chosen by fixed rules. No model call, no score: counts, shares, and sentences that say which rule fired and that every one is optional. */

export const REPORT_PERIODS = Object.freeze([7, 30, 'all']);
const DAY_MS = 86400000;
const RANKED = 15, RHYTHM_ALL = 60, OBSERVATION_LIMIT = 6;
const share = (count, total) => (total > 0 ? Math.round((count / total) * 1000) / 1000 : 0);
const back = (today, days) => localDay(new Date(`${today}T12:00:00`).getTime() - days * DAY_MS);
const pick = (item, language) => (language === 'en' ? item.en : item.zh);

/** The days of a period: `from` (a day, or '' for everything), `to`, and how many rhythm bars to draw. */
function windowOf(period, today) {
  if (period === 'all') return { from: '', to: today, bars: RHYTHM_ALL };
  return { from: back(today, period - 1), to: today, bars: period };
}
const within = (day, window) => day >= window.from && day <= window.to;
function countIn(cell, window) {
  let count = window.from === '' ? cell.older : 0;
  for (const [day, n] of Object.entries(cell.days)) if (within(day, window)) count += n;
  return count;
}
function daysUsedIn(cell, window) { return Object.keys(cell.days).filter(day => within(day, window)).length; }

/** Every control with a count in the window, busiest first (ties by key). */
function rowsOf(state, window, language) {
  const rows = [];
  for (const [key, cell] of Object.entries(state.controls)) {
    const count = countIn(cell, window);
    if (count <= 0) continue;
    const entry = usageEntry(key);
    rows.push({ key, name: entry ? pick(entry, language) : null, count, registered: !!entry, tier: entry?.tier ?? 'other', group: entry?.group ?? null, daysUsed: daysUsedIn(cell, window) });
  }
  rows.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  return rows;
}

export const periodName = (period, language) => period === 'all' ? (language === 'en' ? 'All time' : '全部时间') : language === 'en' ? `Last ${period} days` : `最近 ${period} 天`;

function observationsOf(state, today, language) {
  const en = language === 'en';
  const last = { from: back(today, 29), to: today }, week = { from: back(today, 6), to: today };
  const total = Object.values(state.controls).reduce((sum, cell) => sum + cell.total, 0);
  const everyDay = new Set(Object.values(state.controls).flatMap(cell => Object.keys(cell.days)));
  if (total < 20 || everyDay.size < 3) {
    return [{ id: 'few-data', key: null, optional: true, text: en
      ? 'Too little has been recorded to say anything yet: a few more days of normal use, and this list will start to fill in.'
      : '记录还太少，现在说什么都不准：再正常用几天，这里就会有内容。' }];
  }
  const since = state.since || [...everyDay].sort()[0] || today, spans30 = since <= back(today, 30), spans14 = since <= back(today, 14);
  const items = [];
  const groupName = id => pick(USAGE_NAV_GROUPS[id], language);

  // A control that is used about every day but sits in a group that is not the every-day one.
  const quiet = USAGE_REGISTRY.filter(entry => entry.navGroup && entry.navGroup !== 'daily' && state.controls[entry.key])
    .map(entry => ({ entry, n: countIn(state.controls[entry.key], week), days: daysUsedIn(state.controls[entry.key], week) }))
    .filter(item => item.n >= 8 && item.days >= 3).sort((a, b) => b.n - a.n).slice(0, 2);
  for (const { entry, n } of quiet) items.push({ id: 'quiet-busy', key: entry.key, optional: true, text: en
    ? `${pick(entry, language)} was used ${n} times in the last 7 days, but it sits in “${groupName(entry.navGroup)}”. It could move to “${groupName('daily')}” if you want it closer; leaving it where it is works too.`
    : `${pick(entry, language)} 最近 7 天用了 ${n} 次，但它放在「${groupName(entry.navGroup)}」组里。想让它离得更近，可以考虑放进「${groupName('daily')}」；不动也完全可以。` });

  // A control used for a while that has not been touched for 30 days.
  if (spans30) {
    const idle = USAGE_REGISTRY.filter(entry => entry.group !== 'shortcut' && entry.key !== 'control.text-field' && state.controls[entry.key]?.total > 0 && state.controls[entry.key].last && state.controls[entry.key].last < back(today, 30))
      .sort((a, b) => (state.controls[a.key].last < state.controls[b.key].last ? -1 : 1)).slice(0, 3);
    if (idle.length) items.push({ id: 'idle-fold', key: idle[0].key, keys: idle.map(entry => entry.key), optional: true, text: en
      ? `${idle.map(entry => pick(entry, language)).join(', ')} ${idle.length > 1 ? 'have' : 'has'} not been used in 30 days. ${idle.length > 1 ? 'They' : 'It'} can stay folded away; nothing needs to change.`
      : `${idle.map(entry => pick(entry, language)).join('、')} 已经 30 天没有用过了，可以继续收着，不用做任何改动。` });
  }

  // A control reached by clicking, over and over, that has a keyboard shortcut.
  const clicked = USAGE_REGISTRY.filter(entry => entry.shortcut && state.controls[entry.key])
    .map(entry => ({ entry, n: countIn(state.controls[entry.key], last), days: daysUsedIn(state.controls[entry.key], last), keyed: state.controls[entry.shortcut] ? countIn(state.controls[entry.shortcut], last) : 0 }))
    .filter(item => item.n >= 8 && item.days >= 3 && item.keyed <= item.n * 0.2).sort((a, b) => b.n - a.n).slice(0, 2);
  for (const { entry, n } of clicked) {
    const keys = usageEntry(entry.shortcut).keys;
    items.push({ id: 'shortcut', key: entry.key, optional: true, text: en
      ? `You clicked “${pick(entry, language)}” ${n} times in the last 30 days. There is a keyboard shortcut that does the same: ${keys}.`
      : `最近 30 天你点了 ${n} 次「${pick(entry, language)}」。键盘上有同样的快捷键：${keys}。` });
  }

  // Controls of every-day tier that were never touched although recording has gone on for a while.
  if (spans14) {
    const unused = USAGE_REGISTRY.filter(entry => entry.tier === 'daily' && entry.group !== 'shortcut' && entry.key !== 'control.text-field' && !(state.controls[entry.key]?.total > 0)).slice(0, 3);
    if (unused.length) items.push({ id: 'daily-unused', key: unused[0].key, keys: unused.map(entry => entry.key), optional: true, text: en
      ? `${unused.map(entry => pick(entry, language)).join(', ')} ${unused.length > 1 ? 'are' : 'is'} meant for every day but ${unused.length > 1 ? 'have' : 'has'} never been used. If you did not know ${unused.length > 1 ? 'they exist' : 'it exists'}, it may be worth a look; if not, nothing to do.`
      : `${unused.map(entry => pick(entry, language)).join('、')} 本来是每天会用的，但一次都没用过。如果你原来不知道有它，可以试一下；用不上就不用管。` });
  }

  // One control that takes a large part of everything.
  const rows = rowsOf(state, last, language), sum = rows.reduce((s, row) => s + row.count, 0), top = rows[0];
  if (top && sum >= 30 && share(top.count, sum) >= 0.3 && top.registered) items.push({ id: 'top-control', key: top.key, optional: true, text: en
    ? `“${top.name}” takes ${Math.round(share(top.count, sum) * 100)}% of everything you did in the last 30 days: it is the one to keep a single click away.`
    : `「${top.name}」占了你最近 30 天全部操作的 ${Math.round(share(top.count, sum) * 100)}%：它是最值得保持一步可达的。` });

  // Most of the use goes to controls that are not for every day.
  const daily = rows.filter(row => row.tier === 'daily').reduce((s, row) => s + row.count, 0);
  if (sum >= 50 && share(daily, sum) < 0.4) items.push({ id: 'tier-balance', key: null, optional: true, text: en
    ? `Only ${Math.round(share(daily, sum) * 100)}% of your last 30 days went to every-day controls; most went to setup and now-and-then ones.`
    : `最近 30 天只有 ${Math.round(share(daily, sum) * 100)}% 的操作用在每天的控件上，多数花在准备和阶段性的功能上。` });
  return items.slice(0, OBSERVATION_LIMIT);
}

/**
 * The report for one period. `state` is the record (lib/usage-frequency.js); `today` a local YYYY-MM-DD; `language` zh or en for names and sentences.
 * Unregistered controls (a derived key) come back with `name: null`: the page names them from the key in its own language.
 */
export function buildReport(state, { period = 30, today = localDay(Date.now()), language = 'zh' } = {}) {
  if (!REPORT_PERIODS.includes(period)) throw new Error('period 必须是 7、30 或 all');
  const lang = language === 'en' ? 'en' : 'zh';
  const window = windowOf(period, today), rows = rowsOf(state, window, lang), interactions = rows.reduce((sum, row) => sum + row.count, 0);
  const daily = new Map();
  for (const cell of Object.values(state.controls)) for (const [day, n] of Object.entries(cell.days)) if (within(day, window)) daily.set(day, (daily.get(day) || 0) + n);
  const rhythm = Array.from({ length: window.bars }, (_, i) => { const day = back(today, window.bars - 1 - i); return { day, n: daily.get(day) || 0 }; });
  const tiers = [...USAGE_TIERS, 'other'].map(tier => { const count = rows.filter(row => row.tier === tier).reduce((sum, row) => sum + row.count, 0); return { tier, name: pick(USAGE_TIER_NAMES[tier], lang), count, share: share(count, interactions) }; });
  const areaCounts = USAGE_AREAS.map(area => ({ area: area.id, name: pick(area, lang), count: state.areas?.[area.id] ? countIn(state.areas[area.id], window) : 0 })).filter(row => row.count > 0);
  const areaTotal = areaCounts.reduce((sum, row) => sum + row.count, 0);
  const usedRegistered = USAGE_REGISTRY.filter(entry => state.controls[entry.key]?.total > 0);
  const neverUsed = USAGE_REGISTRY.filter(entry => !(state.controls[entry.key]?.total > 0))
    .map(entry => ({ key: entry.key, name: pick(entry, lang), tier: entry.tier, group: entry.group }));
  return {
    period, language: lang, from: window.from, to: window.to,
    summary: { daysWithData: [...daily.values()].filter(n => n > 0).length, interactions, distinctControls: rows.length },
    ranking: rows.slice(0, RANKED).map(row => ({ ...row, share: share(row.count, interactions) })),
    byArea: areaCounts.sort((a, b) => b.count - a.count || (a.area < b.area ? -1 : 1)).map(row => ({ ...row, share: share(row.count, areaTotal) })),
    byTier: tiers,
    rhythm,
    neverUsed, usedRegistered: usedRegistered.length,
    observations: observationsOf(state, today, lang),
  };
}

/* ---------- export ---------- */

const TEXT = {
  zh: { title: 'StudyHub 使用报告', period: '时间范围', generated: '生成日期', version: '版本', summary: '概览', days: '有记录的天数', interactions: '互动次数', controls: '用过的控件',
    ranking: '最常用的控件', control: '控件', uses: '次数', share: '占比', tier: '按使用时机', area: '按页面', rhythm: '每天的节奏', never: '从没用过的功能', hints: '小提示（每一条都可以不管）',
    privacy: '这份报告只由次数汇总而成：不含你输入、阅读或回答的内容，也不含任何文件、课程或资料的名字。它只保存在你的电脑上，StudyHub 从不把它发送到任何地方；是否交给开发者由你决定。', none: '（暂无）' },
  en: { title: 'StudyHub usage report', period: 'Period', generated: 'Generated on', version: 'Version', summary: 'Overview', days: 'Days with records', interactions: 'Interactions', controls: 'Controls used',
    ranking: 'Most used controls', control: 'Control', uses: 'Uses', share: 'Share', tier: 'By when it is used', area: 'By page', rhythm: 'Daily rhythm', never: 'Never used', hints: 'Observations (each one is optional)',
    privacy: 'This report is made of counts only: nothing you typed, read or answered, and no file, course or source name. It stays on this computer and is never sent anywhere by StudyHub; whether to give it to the developer is up to you.', none: '(none yet)' },
};
const pct = value => `${(Math.round(value * 1000) / 10).toFixed(1)}%`;
const cellText = text => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ');

function markdownOf(report, { version, today, labels }) {
  const t = TEXT[report.language], en = report.language === 'en';
  const nameOf = row => cellText(row.name || labels?.[row.key] || row.key);
  const lines = [`# ${t.title}`, '', `- ${t.period}: ${periodName(report.period, report.language)}`, `- ${t.generated}: ${today}`, `- ${t.version}: StudyHub ${version || ''}`.trim(), '',
    `> ${t.privacy}`, '', `## ${t.summary}`, '', `- ${t.days}: ${report.summary.daysWithData}`, `- ${t.interactions}: ${report.summary.interactions}`, `- ${t.controls}: ${report.summary.distinctControls}`, '',
    `## ${t.ranking}`, ''];
  if (!report.ranking.length) lines.push(t.none);
  else lines.push(`| ${t.control} | ${t.uses} | ${t.share} |`, '| --- | ---: | ---: |', ...report.ranking.map(row => `| ${nameOf(row)} | ${row.count} | ${pct(row.share)} |`));
  lines.push('', `## ${t.tier}`, '', `| | ${t.uses} | ${t.share} |`, '| --- | ---: | ---: |', ...report.byTier.map(row => `| ${row.name} | ${row.count} | ${pct(row.share)} |`));
  lines.push('', `## ${t.area}`, '');
  if (!report.byArea.length) lines.push(t.none); else lines.push(`| | ${t.uses} | ${t.share} |`, '| --- | ---: | ---: |', ...report.byArea.map(row => `| ${row.name} | ${row.count} | ${pct(row.share)} |`));
  lines.push('', `## ${t.rhythm}`, '', report.rhythm.filter(day => day.n > 0).map(day => `${day.day}: ${day.n}`).join(en ? ', ' : '，') || t.none);
  lines.push('', `## ${t.never}`, '', report.neverUsed.map(row => row.name).join(en ? ', ' : '、') || t.none);
  lines.push('', `## ${t.hints}`, '', ...(report.observations.length ? report.observations.map(item => `- ${item.text}`) : [t.none]), '');
  return lines.join('\n');
}

/**
 * The report as a file the learner can read, keep or send: Markdown for people, JSON for tools. Aggregated counts only, the app version, the
 * period and the registry's key → name table (so numbers can be read without the app); no time finer than a day, nothing the learner wrote.
 * `labels` names unregistered keys in the page's language (the page knows the app's own copy; this module does not).
 */
export function exportUsage(state, { format = 'json', period = 30, today = localDay(Date.now()), language = 'zh', version = '', labels = {} } = {}) {
  if (!['json', 'markdown'].includes(format)) throw new Error('format 必须是 json 或 markdown');
  const report = buildReport(state, { period, today, language });
  const stem = `studyhub-usage-${today}`;
  if (format === 'markdown') return { filename: `${stem}.md`, mime: 'text/markdown', content: markdownOf(report, { version, today, labels }) };
  const window = windowOf(period, today);
  const controls = rowsOf(state, window, report.language).map(row => ({ key: row.key, count: row.count, daysUsed: row.daysUsed }));
  const data = {
    app: 'StudyHub', version: version || '', period, generatedOn: today, language: report.language,
    summary: report.summary,
    controls,
    tiers: report.byTier.map(({ tier, count, share: value }) => ({ tier, count, share: value })),
    areas: report.byArea.map(({ area, count, share: value }) => ({ area, count, share: value })),
    rhythm: report.rhythm,
    observations: report.observations.map(({ id, key, text }) => ({ id, key, text })),
    registry: Object.fromEntries(USAGE_REGISTRY.map(entry => [entry.key, { zh: entry.zh, en: entry.en, tier: entry.tier, group: entry.group }])),
  };
  return { filename: `${stem}.json`, mime: 'application/json', content: `${JSON.stringify(data, null, 2)}\n` };
}

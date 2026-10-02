# Usage frequency record

*Chinese version: [usage-frequency.zh-CN.md](usage-frequency.zh-CN.md).*

StudyHub can keep a **local, opt-in count of how often each control is used**, and turn it into a personal report: which buttons you reach for every
day, which features you never touch, which ones sit in the wrong place. It exists so the person using StudyHub (and, if they choose to share the
numbers, the developer) can see where the weight of the product really is. It is **off by default**, and nothing in StudyHub depends on it.

Where it is: **Settings › Advanced › Usage frequency record**, next to (and independent of) *Show experimental features*.

## The privacy contract

These are promises of the code, and tests keep them (`tests/usage-capture.test.mjs`, `tests/usage-frequency.test.mjs`, `tests/usage-report.test.mjs`,
`tests/usage-registry.test.mjs`, `tests/usage-ui.test.mjs`, and the browser journey `scripts/qa/usage-frequency.mjs`).

- **Off by default.** Until you turn the switch on nothing is recorded: no listener is installed on the page, no timer runs, no file is created, and the
  page asks the host once whether the record is on and then does nothing else. Turning it off or pausing it removes the listener and the timer again.
- **What a record is.** Only: a stable *control key*, the *page* it happened on, a *day* (`YYYY-MM-DD`, your local date) and a *count*; plus, per control,
  the first and last day it was seen. No time of day, nothing finer than a day.
- **What it never contains.** Not what you typed, read or answered; no card, source, course or file name or id; no input value (a click into a text box
  or editor is recorded as "text field" and nothing about it is read: not its value, label, placeholder or content); no URL, no window title, no file
  path. A control's name can only enter a key if it is **one of the app's own sentences**; a deck, source, course or file name is not, so it can never
  become part of a key.
- **Where it lives.** One small file on this computer: `<DSH home>/study/usage-frequency.json`. It is not in your library: library exports, backups and the
  snapshot never carry it. StudyHub never sends it anywhere. Whether to give anybody an export is your decision.
- **You are in control.** You can view it (My usage report), export it (Markdown or JSON), pause and resume it, delete all of it (with a confirmation) and
  switch it off, at any time. Turning it off keeps what was recorded until you delete it.
- **The assistant cannot see or change it.** The `usage.frequency.*` operations are for the panel only; the assistant's `study_workspace` tool refuses them.

## What is counted, and how a control gets its key

One delegated listener on the app root (click in the capture phase, plus the documented keyboard shortcuts) resolves the thing you used to a key that is
the **same in Chinese and English** (`ui/usage/keys.js`):

1. a `data-usage` attribute (set by hand on the controls that cannot be keyed well: the sidebar pages, the practice buttons, start and generate, adding a
   source, the reader's translate / "practise these pages" / "original page" / display buttons, the experimental switches; they are listed in
   `lib/usage-registry.js`), the nearest one above the click;
2. a class hook that belongs to exactly one control (`reader-peek`, `nav-reset`, `review-return`), then the control's own `data-tour` / `data-testid` or a
   stable id;
3. otherwise `<page>/<role>/<name>`, where the name is the control's accessible name **if and only if it is one of the app's own sentences**. The Chinese
   source of every sentence is the key of the English catalogue (`ui/i18n.js`); the page reverses it, so "Save review settings" and "保存复习设置" give the
   same key. Numbers are stripped (`开始做这 12 道题` and "Start these 12 questions" are both `开始做这 N 道题`);
4. a control with no such name falls back to `<page>/<role>` (no index, nothing from your data).

Typing is never counted. Held-down keys and double events count once (the same key inside 150 ms is one use). Using the usage section itself is never
counted. The documented shortcuts (S, A, ?, P, the number keys, Enter, arrows, Space, H, T) are counted only where the app itself would act on them.

## Where the numbers go

Counts are added up **in the page** and sent to the host in batches: about every 30 seconds while there is something new, when the window is hidden or
closes, and when you turn the record off or pause it. (If a window is killed abruptly the last few seconds of counts can be lost; nothing else is.) Turning the record on takes effect in this window at once; other windows that are already open start recording after they are reloaded, and stop by themselves once the host tells them it is off. The
page does no layout reads and no re-render for recording; the cost of one event is a lookup and an increment, and the snapshot is untouched.

The file (`lib/usage-frequency.js`) is written atomically (temporary file, then rename; writes are queued, so several windows add up), and is bounded:

- at most **800 distinct keys**; more fold into one `other` key;
- **180 days** of day buckets; older days fold into each key's `older` count, so "all time" stays right;
- at most 24,000 day cells (the oldest days fold first), at most 500 records per batch;
- a damaged or foreign file reads as "off, nothing recorded"; starting again works.

## Operations (panel only)

| Operation | What it does |
| --- | --- |
| `usage.frequency.status` | on / paused, whether it holds data, days with data, since when, where the file is. Never creates the file. |
| `usage.frequency.set` | `{ enabled?, paused? }`: the switch and the pause. |
| `usage.frequency.record` | `{ records: [{ key, area, day, n }] }`: a batch of counts. Refused (nothing written) while off or paused. |
| `usage.frequency.report` | the personal report for `7`, `30` or `"all"` days. Never calls a model. |
| `usage.frequency.export` | `{ format: "markdown" \| "json", period, language }`: a file's name, type and content. |
| `usage.frequency.clear` | deletes every record; the switch stays as it is. |

## The personal report (Settings › Advanced › My usage report)

Folded until the record has data. For the last 7 days, the last 30 days or all time: the summary (days with data, interactions, distinct controls); the
most used controls with plain names, counts, shares and a bar (every bar has its numbers as text); usage by page and by *tier* (every day / now and then /
once per course, from `lib/usage-registry.js`, following [feature-tiers.md](feature-tiers.md)); the daily rhythm; the registry's controls that were never
used; and up to six **rule-based observations**. No model is called and nothing is scored; each observation says which rule fired and is optional:

- *a busy control in a quiet group*: used 8+ times in the last week on 3+ days but sitting in 阶段性 or 课程准备与管理: it could move to 每天;
- *idle for 30 days* (once the record spans 30 days): it can stay folded;
- *a keyboard shortcut exists* for a control you click 8+ times in a month while pressing the key rarely;
- *every-day controls never used*; *one control takes 30% or more*; *most use goes to controls that are not for every day*.

With too little recorded the report says so instead of guessing.

## Exports

Markdown is a readable report; JSON is **aggregated counts only**: app version, period, generation day (no time), the summary, one row per control
(`key`, `count`, `daysUsed`), shares by tier and page, the daily rhythm, the observations and the registry's key → name table (so the numbers can be read
without the app). Unregistered keys (page/role/name) are named in the page's language in the Markdown. It is saved or copied for you to look at, or to
send to the developer if you choose; StudyHub itself never sends it.

## For the developer

The aggregated JSON export is the unit the developer-side view will work with. **2.5.2 will add developer-side aggregation across several exports**
(nothing of that exists in 2.5.1). The registry (`lib/usage-registry.js`) is the stable vocabulary: add a control to it when you mark it with
`data-usage`; `tests/usage-registry.test.mjs` fails when a marked control is not registered, a registered one is marked nowhere, or the keys a page
produces differ between Chinese and English.

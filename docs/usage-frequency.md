# Usage frequency record

*Chinese version: [usage-frequency.zh-CN.md](usage-frequency.zh-CN.md).*

StudyHub can count how often you use each control, on this computer and only after you turn it on. It turns the counts into **My usage report**: the buttons you reach for every day, the features you never touch and the ones that may sit in the wrong place. The report helps you see your own habits. If you choose to send an export to the developer, it also shows where the product's weight really is.

The record is off by default, and nothing else in StudyHub depends on it. It is available from 2.5.2.

Where to find it: **Settings › Usage frequency record**.

## The privacy contract

These are promises the code keeps, and automated tests check each one (see [Development](#development)).

- **Off by default.** Until you turn it on, nothing is recorded: no listener is installed on the page, no timer runs and no file is created. The page only asks the host whether the record is on. It asks once when it loads (a few more times if the host has not finished starting) and again when you open **Settings › Usage frequency record**. Pausing or turning the record off removes the listener and the timer again.
- **Counts only.** For each control, the file keeps a count per day, the first and last day it was used and a total. For each page, it keeps a count per day. It also keeps whether the record is on or paused, and the day recording started. Days are your local date (`YYYY-MM-DD`). There is no time of day: nothing is finer than a day.
- **Never your content.**
  - Nothing you typed, read or answered.
  - No card, source, course or file name or id.
  - No input value. A click into a text box or editor is recorded as "text field", and nothing about the field is read: not its value, label, placeholder or content.
  - No URL, window title or file path.
  - A control's name can enter a key only if it is one of the app's own sentences. A deck, source, course or file name is not, so it can never become part of a key.
- **On this computer, not in your library.** The record is one small file, `<DSH home>/study/usage-frequency.json`. `<DSH home>` is `~/.dsh` unless the `DSH_HOME` environment variable points elsewhere. **My usage report** shows the full path as **Record file**. Library exports, backups and library snapshots never include it.
- **StudyHub never sends it anywhere.** Whether to give an export to anyone is your decision.
- **You are in control.** At any time you can view the report, export it as Markdown or JSON, pause and resume, delete every record (after a confirmation) and turn the record off. Turning it off keeps what was recorded until you delete it.
- **The assistant cannot see or change it.** Only the Settings panel reads or changes the record. The assistant's `study_workspace` tool refuses every `usage.frequency.*` operation, so the assistant can neither read the record nor turn it on or send it.

## Turn it on

1. Open **Settings › Usage frequency record**. It is near the end of the left-hand list, next to **Experimental features**. The two are independent.
2. Read the four promises above the switch.
3. Turn on **Record usage frequency**. The status line changes to "Recording. Nothing recorded yet".
4. Use StudyHub as usual. After a day or two, come back and open **My usage report**.

Turning the record on takes effect at once in the window where you do it. StudyHub windows that were already open start recording after you reload them.

## Pause, turn off or delete

| You want to | Do this | What happens to the records |
| --- | --- | --- |
| Stop for a while | Click **Pause recording**, and later **Resume recording** | Kept. Nothing is recorded while paused. |
| Stop recording | Turn off **Record usage frequency** | Kept. You can still view, export or delete them. |
| Start from nothing | In **My usage report**, click **Delete all records** and confirm | Every count and day is deleted. The switch stays as it is; if it is on, recording carries on from today. Your library and files you already exported are not affected. |

## Read My usage report

**My usage report** appears below the switch once something has been recorded. It is folded until you open it. It stays there after you turn the record off, until you delete the records.

At the top, choose **Last 7 days**, **Last 30 days** (the default) or **All time**.

| Part | What it shows |
| --- | --- |
| Summary | **Days with records**, **Interactions** and **Controls used**. |
| **Most used controls** | Up to 15 controls, busiest first. Each has a plain name, its count, its share and a bar. |
| **By page** | The page you were on when you used them. |
| **By when it is used** | Each control's tier from the registry: Every day, Now and then or Once per course (see [feature-tiers.md](feature-tiers.md), in Chinese). Controls outside the registry count as Other. |
| **Daily rhythm** | One bar per day: 7 or 30 bars, or the last 60 days for **All time**. It also names the busiest day. |
| **Never used** | Registry controls with no use anywhere in the record, grouped by area (Sidebar, Practice, Reading and so on). Folded until you open it. |
| **Suggestions** | Up to 6 suggestions, each marked **Optional**. See the next section. |

The period you choose applies to the summary, **Most used controls**, **By page**, **By when it is used** and **Daily rhythm**. **Never used** looks at the whole record. **Suggestions** do not follow the period: each rule uses its own span, shown in the next section.

Every bar also shows its numbers as text. The report never calls a model and scores nothing.

### How suggestions are chosen

Each suggestion comes from a fixed rule and says why it appears. You can ignore any of them.

| Suggestion | When it appears |
| --- | --- |
| Too little recorded yet | Fewer than 20 uses in the whole record, or uses on fewer than 3 days. Then it is the only suggestion: the report says so instead of guessing. |
| A busy page in a quieter group | A sidebar page in **Now and then** or **Setup & manage** was used 8+ times in the last 7 days, on 3+ days. It could move to **Every day**. At most 2. |
| Not used for 30 days | Only once the record spans 30 days. Up to 3 controls you used before but not in the last 30 days. They can stay folded away. |
| A keyboard shortcut exists | You clicked a control 8+ times in the last 30 days, on 3+ days, and pressed its shortcut at most a fifth as often. It names the key. At most 2. |
| Every-day controls never used | Only once the record spans 14 days. Up to 3 every-day controls with no use at all. |
| One control takes a large share | At least 30 uses in the last 30 days, and the busiest control takes 30% or more of them. Only for a control in the registry. |
| Most use goes elsewhere | At least 50 uses in the last 30 days, and less than 40% of them went to every-day controls. |

## Export or copy the report

**Export Markdown**, **Export JSON** and **Copy report** are at the bottom of **My usage report**. They use the period you chose.

- **Export Markdown** downloads `studyhub-usage-YYYY-MM-DD.md` (the day you export). It is a readable report: the period, the day it was made, the StudyHub version, a privacy note, then the same parts as the screen. Controls outside the registry are named in the language of the page.
- **Copy report** copies the same Markdown text. If the window does not allow copying, use **Export Markdown** instead.
- **Export JSON** downloads `studyhub-usage-YYYY-MM-DD.json`. It holds **aggregated counts only**:
  - the app name, version, period, the day it was made (no time of day) and the language;
  - the summary;
  - one row per control used in the period: `key`, `count` and `daysUsed`;
  - counts and shares by tier and by page, and the daily rhythm;
  - the suggestions;
  - the registry's table of keys and names (Chinese and English names, tier and group), so the numbers can be read without the app.

In the JSON, a control outside the registry appears only as its key: `page/role/name`, where the name is the app's own Chinese sentence.

StudyHub itself never sends an export. Keep it, read it, or send it to the developer if you choose.

## What counts as one use

- **Clicking a control**: a button, link, tab, switch, menu item and so on. Clicking plain text or empty space counts for nothing.
- **A click into a text box, text area or editor** counts as "text field". Typing never counts.
- **A documented keyboard shortcut**, only where the app itself acts on it:
  - **?**, **S** and **A** on any page;
  - **P** in the reader;
  - the number keys 0–6, Enter, ← and →, Space, **H** and **T** on the practice page only.

  A shortcut does not count while Ctrl, Alt or Cmd is held, while you type in a field or editor, or inside a dialog, except for **P** in the reader. Enter or Space on a focused button is that button's click, not a second use.
- **Repeats count once.** The same control twice within 150 ms is one use, and a key held down is one use.
- **The usage section itself never counts.** Nothing you do inside it (the switch, the report and its buttons) is recorded.

Each use is filed under the page you were on.

## How counts are saved

Counts add up in memory in the page, per day, page and control. The page sends them to the host in batches:

- about 30 seconds after the first new count;
- when the window is hidden or closed;
- right before you pause or turn off the record, and before the usage section reads the status, builds the report or exports, so the last few seconds are included.

A batch that fails is kept for the next one. If a window is killed without warning, up to the last 30 seconds of counts can be lost; nothing else is. At most 400 different (day, page, control) counts wait in the page; beyond that, new ones are counted under `other`. Recording reads no layout and re-renders nothing: one use costs a lookup and an increment.

With several windows open:

- Turning the record on takes effect at once only in the window where you do it. Other open windows start after you reload them.
- Pausing or turning the record off stops every window. Another window finds out at its next batch: the host refuses the batch, and the window drops it and removes its listener.

The file `<DSH home>/study/usage-frequency.json` is bounded:

- at most **800 distinct keys**; new keys beyond that are counted under one `other` key;
- **180 days** of day-by-day counts; older days fold into each key's `older` count, so **All time** stays right;
- at most 24,000 day cells in all, with the oldest days folded first;
- at most 500 records per batch;
- a damaged or unrecognised file reads as "off, nothing recorded"; turn the record on again to start over.

## Development

### How a control gets its key

The capture (`ui/usage/capture.js`) is one delegated click listener on the app root, in the capture phase, plus a key listener on the document for the documented shortcuts. `ui/usage/keys.js` resolves the control to a key that is the **same in Chinese and English**, trying these in order:

1. A text box, text area or editor is always `control.text-field`. Nothing about it is read.
2. The nearest `data-usage` attribute above the click. It is set by hand on controls that cannot be keyed well, such as the sidebar pages, the home page's main button, the practice buttons, generating a deck, adding a source, the reader's buttons and the experimental switches. `lib/usage-registry.js` lists every one.
3. A class hook that belongs to exactly one control: `reader-peek`, `nav-reset` or `review-return`.
4. The control's own `data-tour`, `data-testid` or stable id, as `tour.…`, `testid.…` or `id.…`.
5. `<page>/<role>/<name>`, where the name is the control's accessible name **if and only if it is one of the app's own sentences**. The Chinese source of every sentence is the key of the English catalogue (`ui/i18n.js`). `ui/usage/names.js` looks a name up in either language and returns the Chinese source, so "Save review settings" and "保存复习设置" give the same key. Numbers become `N`: `开始做这 12 道题` and "Start these 12 questions" both give `开始做这 N 道题`.
6. A control with no such name falls back to `<page>/<role>`, with no index and nothing from your data.

The page is the nearest `data-usage-area` above the control; an unknown page is `other`.

Before writing, the host checks every record again (`lib/usage-frequency.js`) and rejects any that fails:

- the key has at most 96 characters and at least one letter or digit;
- the key contains no `@`, `\`, `?`, `=`, `&`, `#`, `%`, `<`, `>`, quotes, backticks or control characters, and no `//` or `..`;
- the day is a local date from 365 days ago to tomorrow;
- the count is a whole number from 1 to 10,000.

The file is written atomically (a temporary file, then a rename). Writes queue behind one writer, so counts from several windows add up.

### Operations (panel only)

| Operation | What it does |
| --- | --- |
| `usage.frequency.status` | On or paused, whether it holds data, days with data, since when, where the file is, and the key and day limits. Never creates the file. |
| `usage.frequency.set` | `{ enabled?, paused? }`: the switch and the pause. `enabled: true` without `paused` also resumes. Writes nothing while no file exists and the record stays off and unpaused. |
| `usage.frequency.record` | `{ records: [{ key, area, day, n }] }`: a batch of counts, at most 500 (the rest are rejected). Answers with the accepted and rejected counts. While the record is off or paused, nothing is written and the answer says `enabled: false`. |
| `usage.frequency.report` | `{ period?, language? }`: the personal report. `period` is `7`, `30` (the default) or `"all"`; `language` is `zh` or `en`. Never calls a model. |
| `usage.frequency.export` | `{ format?, period?, language?, labels? }`: `format` is `"json"` (the default) or `"markdown"`; `labels` names unregistered keys in the page's language. Returns `{ filename, mime, content }`. |
| `usage.frequency.clear` | Deletes every record. The switch stays as it is; if the record is on, its start day becomes today. |

### Registry and tests

The registry (`lib/usage-registry.js`) is the stable vocabulary. Each entry has a key, a Chinese and an English name, a tier, a group and, for sidebar pages, the sidebar group. When you mark a control with `data-usage`, add it to the registry. `tests/usage-registry.test.mjs` fails when a marked control is not registered, or when a registered control is marked nowhere and is neither a class hook nor a shortcut. It also checks that the sidebar rows, the home page, the practice page, Settings and the keyboard shortcut sheet give the same keys in Chinese and English.

The tests behind the privacy contract:

- `tests/usage-capture.test.mjs`: keys, names, shortcuts, the in-page counts, and that nothing is installed while the record is off;
- `tests/usage-frequency.test.mjs`: the file, its limits, atomic writes, and that the record is not in the library;
- `tests/usage-privacy.test.mjs`: puts course, deck, source, typed text, URL, email and path strings on the page, clicks through all of it, and checks that none reaches the file, the report or any export in either language;
- `tests/usage-report.test.mjs`: the report, the suggestion rules and both exports;
- `tests/usage-registry.test.mjs`: the registry, and that the operations are refused to the assistant;
- `tests/usage-ui.test.mjs`: the Settings section in each state, in both languages;
- `tests/usage-docs.test.mjs`: keeps the numbers and names in this document and its Chinese version in step with the code;
- `scripts/qa/usage-frequency.mjs`: the journey in the real app (build `dist/` first). It also checks that no request leaves the machine. With `--all` it runs both languages, both themes and two widths, and checks that both languages record the same keys.

The aggregated JSON export is the unit a developer-side view will work with. The record and the personal report shipped in 2.5.2. Developer-side aggregation across several exports is planned but has not been built yet.

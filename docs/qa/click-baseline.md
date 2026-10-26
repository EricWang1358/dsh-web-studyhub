# Click baseline

How many clicks three everyday journeys take, so each step of the 3.7 guidance update can be compared against the same numbers. Counted in a real
Chromium on a throw-away library (a temp folder per journey) with the fake model; no real key, no network. A click is counted as it is made; typing
into a field is counted apart; waiting for the fake model to finish is not a click.

**App build at `6152aa4b`** (main before guidance step 0), measured on 2026-10-26 with `scripts/qa/steps.mjs` **from the step 0 PR** (#505): the
script as it was at `6152aa4b` no longer runs against that build (its first journey still expected the pre-3.6 import flow). The same numbers came out
in Chinese and in English, and again on the step 0 branch (it adds a Settings page and changes no journey).

| Journey (script id) | Clicks | Fields typed | Clicks at each stage | What the learner clicks |
|---|---|---|---|---|
| **First deck** (`first-deck`): a new library to the first own deck published and its first question on screen | 5 | 2 | generation job 4 · deck published 5 · practice question 5 | 添加资料 → 粘贴文本 → 保存资料 → 出第一组题 → 发布并开始练 |
| **New course** (`course-practice`): a library in use; add a material for a new course and get to that course's first question | 8 | 3 | generation job 7 · deck published 8 · practice question 8 | 侧栏 资料 → 添加资料 → 粘贴文本 → 更改 (course) → 保存资料 → 从这份资料出题 → 生成 → 发布并开始练 (on the finished run's card) |
| **Daily continue** (`daily-continue`): a course in daily use with a round left open → the next question | 1 | 0 | practice question 1 | 接着做 |

`course-practice` types the new course name into the import dialog's course field after 更改 and checks that the published deck belongs to that
course. It is not the older `new-course` journey (a course already seeded with a material, 2 clicks to a generation job). A learner who opens the
draft first (检查草稿 → 发布并开始练) takes 9 clicks; the first count in PR #505 (9) caught the run's card a moment before it offered 发布并开始练,
so the script now waits one more poll for the card to settle and takes the shortest way the screen offers.

## Not measured

- A model that still has to be connected: the fake model is ready from the start, so the model setup steps are not in these counts.
- Other window sizes: 1440 × 900 only.
- Other ways in: pasted text only; no file picker, no PDF conversion, no audio.
- Anything before the first screen: counting starts once the app has loaded; focusing a field before typing is not counted as a click.
- The DSH host (desktop app or web): the standalone preview only.
- A real second day: `daily-continue` is measured on the day the round was left open; the clock is not moved.

## Re-run

Against the current checkout (the default journeys are the three above):

```
npm run build
node scripts/qa/steps.mjs --dist=dist --lang=zh --label=after
```

Before and after, with two worktrees: build the old commit in its own worktree and point this checkout's script at that build.

```
git worktree add ../studyhub-before 6152aa4b
cd ../studyhub-before && npm ci --legacy-peer-deps && npm run build && cd -
node scripts/qa/steps.mjs --dist=../studyhub-before/dist --label=before
node scripts/qa/steps.mjs --dist=dist --label=after
```

Each run prints the table and writes `output/qa/tiers/<label>-steps.json`; `--journeys=first-question,new-course` runs the older journeys
(builds from 3.6 on).

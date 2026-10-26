# Click baseline

How many clicks three everyday journeys take, so each step of the 3.7 guidance update can be compared against the same numbers. Taken with
`scripts/qa/steps.mjs` in a real Chromium on a throw-away library (a temp folder per journey) with the fake model; no real key, no network.
A click is counted as it is made; typing into a field is counted apart; waiting for the fake model to finish is not a click.

Taken at commit `6152aa4b` (main before guidance step 0), 2026-10-26. The same numbers came out in Chinese and in English, and again on the
step 0 branch (it adds a Settings page and changes no journey).

| Journey | Clicks | Fields typed | Clicks at each stage | What the learner clicks |
|---|---|---|---|---|
| **First deck**: a new library to the first own deck published and its first question on screen | 5 | 2 | generation job 4 · deck published 5 · practice question 5 | 添加资料 → 粘贴文本 → 保存资料 → 出第一组题 → 发布并开始练 |
| **New course**: a library in use; add a material for a new course and get to that course's first question | 9 | 3 | generation job 7 · deck published 9 · practice question 9 | 侧栏 资料 → 添加资料 → 粘贴文本 → 更改 (course) → 保存资料 → 从这份资料出题 → 生成 → 检查草稿 → 发布并开始练 |
| **Daily continue**: a course in daily use with a round left open → the next question | 1 | 0 | practice question 1 | 接着做 |

Notes:

- "Daily continue" is measured on the day the round was left open; the clock is not moved to the next day. The home card it uses (接着做) is the
  same on the next day.
- "New course" types the new course name into the import dialog's course field after 更改; the journey checks that the published deck belongs to
  that course.
- The older journeys `first-question` (to the first generation job; 4 clicks now) and `new-course` (a course already seeded) can still be run
  with `--journeys=first-question,new-course`.

Re-run against a build (the default journeys are the three above):

```
npm run build
node scripts/qa/steps.mjs --dist=dist --lang=zh --label=after
```

It prints the table and writes `output/qa/tiers/<label>-steps.json`; `--dist=<dir>` points it at another build to compare before and after.

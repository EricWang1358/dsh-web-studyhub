# Evaluating the taxonomy and the skills

## Contents
- The holdout set
- 1. Coverage
- 2. Interception
- 3. Activation
- Keeping the test honest
- Recording results

## The holdout set

`triage.mjs split` puts every non-noise item created after the holdout date into `<wb>/holdout.json`. Splitting by time stops later fixes from leaking into the lessons. Never mine these items, and never show them to the agent that writes the taxonomy or the skills.

## 1. Coverage

Question: does the taxonomy describe mistakes it has not seen?

Write cards for 30 holdout items with the normal mining procedure, but forbid `"class": "new"` unless no class's catch question would have stopped the item. Report the share of items that carry a lesson and fit an existing class. Below about 70%, the taxonomy is missing classes: mine more before writing skills. Read the misses together; they often form a class of their own.

## 2. Interception

Question: would the skill have stopped the mistake before it happened?

Pick 10 to 20 holdout items whose mistake is clear and whose class has a home in a skill.

1. Create a throwaway worktree at the commit before the fix (`git worktree add --detach tmp/eval-<n> <sha>`).
2. Give a fresh agent only the task as it stood: the issue text or the request, without the fix, the diagnosis, or the class.
3. Run it twice: without the produced skills (baseline), and with them.
4. Grade from the transcript and the diff: did the agent avoid the mistake, or ask the class's catch question before acting? A run that names the right words but still makes the mistake fails.

Report per item: baseline result, with-skill result, and the question that fired. When baseline and with-skill both pass, the skill added nothing for that item; that is not a success.

## 3. Activation

Question: does the description fire on the right work and stay quiet on the wrong work?

For each produced skill, write three substantive prompts that should trigger it, three nearby prompts that should not, and one explicit invocation. Run each in a fresh `claude -p` session with stream-json output from the repo root, and look for a Skill tool call naming the skill. A trivial one-step prompt never triggers a skill, so do not use one. The installed `anthropic-skills:skill-creator` can tune a description against such a set.

## Keeping the test honest

- The test agent must not know it is being tested and must not see your diagnosis.
- Use a fresh context for each run, and clean up its worktree afterwards.
- Read every transcript; do not grade by keyword counts.
- One fixture from a real past failure beats three invented ones. Improve the skill from what generalises across items, not from what fixes one item.
- Keep within the agent and cost limits in the profile. Interception runs are the expensive part; start with five items.

## Recording results

Write `<wb>/evals/<date>-<kind>.md` with the items, the runs, the grades, and anything the run surfaced that you did not act on. Summarise the numbers in the mode's report.

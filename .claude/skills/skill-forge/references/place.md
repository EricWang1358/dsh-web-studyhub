# Placing a class in its cheapest home

## Contents
- The ladder
- Standing cost of each home
- Writing the home
- Retiring a class
- Memory files

A class gets a home only when its status is `recurring` or `costly`. Try each rung in order and take the first that holds.

## The ladder

1. **One owner, one way.** The mistake was possible because two ways to do the same thing exist (two components, two pipelines, two wordings of one fact). Removing the second way is product work: open or name an issue for it. Then continue down the ladder for the time until it lands.
2. **A check.** A test, lint rule or guard test can detect the defect's shape, runs where the repo already runs its checks, and its failure message says what to fix. Keep it only after you have seen it pass on the current tree and fail on the defect in a throwaway copy (a detached worktree under `tmp/`). If it needs product code changed or a new tool, report it as work instead.
3. **A hook.** The moment of the mistake is a tool call you can match (for example `gh pr create`, `git commit`, an edit under a path), and the class is costly enough that it must not depend on the model remembering. A hook in `.claude/settings.json` injects the class's catch question at that call. Hooks are persistent configuration: propose them to the owner, do not add one silently. Reuse the kit instead of writing a new hook: add a moment to `.claude/hooks/skill-moments.json` (a name, a command pattern, the skill whose `[Cnn]` lines to inject, optionally a class subset) and one `PreToolUse` entry that runs `skill-moment.mjs <name>` behind an `if` filter. The script reads the questions from the skill, so they keep one owner; it ignores quoted strings and heredoc bodies, so writing about a command does not fire it. To take the kit to another project, copy `.claude/hooks/` and the settings entries, then edit the moments. The same script serves Codex (`.codex/hooks.json`, matcher `Bash`) and Antigravity (`.agents/hooks.json`, matcher `run_command`): with no moment name it tests every moment, and it answers each agent in its own output format.
4. **A CLAUDE.md rule.** The condition applies to nearly every change in the repo and fits one line. Keep at most ten such rules; adding an eleventh means demoting one.
5. **A question in a decision-moment skill.** The condition needs judgment, and its moment is one of the produced skills. Add the catch question to that skill's question list and its pairs to the skill's reference.
6. **A record.** A long-tail fact (an environment quirk, a tool's flag, a platform trap) that is needed rarely and found by search. Write `docs/agent-lessons/solutions/<slug>.md`. It costs no standing tokens.

If a check or rule already states the lesson, write nothing and report which file holds it.

## Standing cost of each home

| Home | Tokens per session | Fires reliably | Cost when wrong |
|---|---|---|---|
| Check | 0 | Always | A false failure blocks CI |
| Hook | 0 until the matched call | Always at that call | Noise at every matched call |
| CLAUDE.md rule | Every session | Usually | Dilutes every other rule |
| Skill question | Description every session; body only when triggered | When the description matches | Missed if the trigger misses |
| Record | 0 | Only if searched | Forgotten |

## Writing the home

- Update the class's Home and Status lines in the same change.
- A skill question cites its class id (`[C07]`), so the evaluator can trace it.
- A check's failure message names the class id and the fix.

## Retiring a class

Follow "Retiring" in `taxonomy-rules.md`, then remove the class's question from the skill that held it and run `check-skills.mjs`.

## Memory files

The owner's Claude memory for this project holds many feedback lessons that are project process, not personal preference. When a class absorbs one, tell the owner which memory file is now covered, so its index line can be removed. Memory index lines are loaded in every session, so moving a lesson into a triggered skill or a check saves standing tokens. Do not edit memory files from a sub-agent.

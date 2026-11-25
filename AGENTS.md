# Notes for coding agents

- Project skills are in `.agents/skills/`. They are generated copies of `.claude/skills/`: edit the file under `.claude/skills/`, then run `node .claude/skills/skill-forge/scripts/mirror-skills.mjs --write`. A test fails while the two differ.
- Each skill's `[Cnn]` questions come from `docs/agent-lessons/taxonomy.md`; look a class up with `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`.
- Before `gh pr create`, `gh release create` or `npm run release:pack`, a hook (`.codex/hooks.json`, `.agents/hooks.json`) shows the questions from `verify-before-done`. Answer them in the PR or report.

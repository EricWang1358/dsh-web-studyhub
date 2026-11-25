import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mirrorDrift, mirrorPlan, writeMirror } from '../.claude/skills/skill-forge/scripts/mirror-skills.mjs';
import { commandOf, respond } from '../.claude/hooks/skill-moment.mjs';

/* One set of skills for three agents: .claude/skills/ is the source (Claude Code), .agents/skills/ is a generated
   mirror (Codex, Antigravity), and the one hook script answers each agent's PreToolUse payload in that agent's format. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the .agents/skills mirror matches .claude/skills (run mirror-skills.mjs --write after editing a skill)', async () => {
  assert.deepEqual(await mirrorDrift(root), []);
  const names = (await mirrorPlan(root)).map(p => p.name);
  assert.ok(names.includes('verify-before-done'), 'decision-moment skills are mirrored');
  assert.ok(!names.includes('skill-forge'), 'the Claude-specific meta-skill is not');
});

test('the mirror check catches an edited copy, a missing copy and a stale copy, and --write repairs all three', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-'));
  try {
    const skill = (name, body) => mkdir(join(dir, '.claude/skills', name), { recursive: true })
      .then(() => writeFile(join(dir, '.claude/skills', name, 'SKILL.md'), body));
    await skill('a', '---\nname: a\ndescription: x\n---\n- [C01] Which other paths?\n');
    await skill('b', '---\nname: b\ndescription: y\n---\n- [C03] Which real environments?\n');
    await skill('meta', '---\nname: meta\ndescription: no questions\n---\nBody.\n');
    assert.deepEqual(await writeMirror(dir), ['a', 'b']);
    assert.deepEqual(await mirrorDrift(dir), []);
    assert.equal(existsSync(join(dir, '.agents/skills/meta')), false);

    await writeFile(join(dir, '.agents/skills/a/SKILL.md'), 'edited by hand\n');
    await rm(join(dir, '.agents/skills/b'), { recursive: true });
    await mkdir(join(dir, '.agents/skills/old'), { recursive: true });
    const drift = await mirrorDrift(dir);
    assert.equal(drift.length, 3, drift.join('\n'));
    assert.match(drift.join('\n'), /a\/SKILL\.md differs/);
    assert.match(drift.join('\n'), /b\/SKILL\.md is missing/);
    assert.match(drift.join('\n'), /old has no source skill/);

    await writeMirror(dir);
    assert.deepEqual(await mirrorDrift(dir), []);
    assert.equal(existsSync(join(dir, '.agents/skills/old')), false);
    // Line endings do not count as drift (Windows checkouts turn LF into CRLF).
    await writeFile(join(dir, '.agents/skills/a/SKILL.md'), (await readFile(join(dir, '.claude/skills/a/SKILL.md'), 'utf8')).replace(/\n/g, '\r\n'));
    assert.deepEqual(await mirrorDrift(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const moments = [{ name: 'declare-done', pattern: '(^|[;&|(]\\s*)gh\\s+pr\\s+create\\b', skill: 's', lead: 'Before the PR:' }];
const readSkill = () => '- [C03] Real environments?\n- [C01] Other paths?\n';

test('the hook reads the command from Claude Code, Codex and Antigravity payloads', () => {
  assert.equal(commandOf({ tool_name: 'Bash', tool_input: { command: 'gh pr create' } }), 'gh pr create');
  assert.equal(commandOf({ toolCall: { name: 'run_command', args: { CommandLine: 'gh pr create', Cwd: '/r' } } }), 'gh pr create');
  assert.equal(commandOf({ tool_input: { command: ['gh', 'pr', 'create'] } }), 'gh pr create');
  assert.equal(commandOf({}), '');
});

test('Claude Code and Codex get additionalContext; Antigravity gets ask with the questions, or allow', () => {
  const claude = JSON.parse(respond({ tool_input: { command: 'git push && gh pr create --fill' } }, moments, readSkill));
  assert.equal(claude.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(claude.hookSpecificOutput.additionalContext, /Before the PR:\n- \[C03\][^]*- \[C01\]/);
  assert.equal(claude.hookSpecificOutput.permissionDecision, undefined, 'never decides for Claude Code or Codex');
  assert.equal(respond({ tool_input: { command: 'ls' } }, moments, readSkill), '');

  const agy = JSON.parse(respond({ toolCall: { name: 'run_command', args: { CommandLine: 'gh pr create' } } }, moments, readSkill));
  assert.equal(agy.decision, 'ask');
  assert.match(agy.reason, /\[C03\]/);
  assert.deepEqual(JSON.parse(respond({ toolCall: { name: 'run_command', args: { CommandLine: 'echo "gh pr create"' } } }, moments, readSkill)), { decision: 'allow' });
});

test('the shared-checkout moment asks C22 before a command that changes the whole checkout, and only then', async () => {
  const { moments } = JSON.parse(await readFile(join(root, '.claude/hooks/skill-moments.json'), 'utf8'));
  const read = name => readFileSync(join(root, '.claude/skills', name, 'SKILL.md'), 'utf8');
  const asks = command => /\[C22\]/.test(respond({ tool_input: { command } }, moments, read, 'shared-checkout'));
  for (const command of ['git switch -c x', 'git checkout main', 'cd repo && git pull --ff-only', 'git rebase origin/main', 'git stash push -u -m t', 'git reset --hard HEAD~1']) {
    assert.ok(asks(command), command);
  }
  for (const command of ['git status', 'git log --oneline', 'git reset HEAD file', 'git worktree add .local/wt/x', 'echo "git switch main"', 'git commit -m "git checkout notes"']) {
    assert.ok(!asks(command), command);
  }
  const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'));
  const entries = settings.hooks.PreToolUse.flatMap(g => g.hooks);
  assert.ok(entries.some(h => h.if === 'Bash(git *)' && h.command.endsWith(' shared-checkout')), 'Claude Code runs the moment before git commands');
});

test('the Codex and Antigravity hook files run the same script with no moment filter', async () => {
  const codex = JSON.parse(await readFile(join(root, '.codex/hooks.json'), 'utf8'));
  const codexHooks = codex.hooks.PreToolUse.flatMap(g => (g.matcher === 'Bash' ? g.hooks : []));
  assert.ok(codexHooks.some(h => h.type === 'command' && /node \.claude\/hooks\/skill-moment\.mjs$/.test(h.command)), 'Codex matches Bash and runs skill-moment.mjs');

  const agy = JSON.parse(await readFile(join(root, '.agents/hooks.json'), 'utf8'));
  const agyHooks = Object.values(agy).flatMap(h => (h.PreToolUse ?? []).flatMap(g => (g.matcher === 'run_command' ? g.hooks : [])));
  assert.ok(agyHooks.some(h => /node \.\.\/\.claude\/hooks\/skill-moment\.mjs$/.test(h.command)), 'Antigravity matches run_command and runs skill-moment.mjs');
});

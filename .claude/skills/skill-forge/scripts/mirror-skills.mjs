// Mirror the decision-moment skills into .agents/skills/ for agents that read skills there (OpenAI Codex, Google
// Antigravity). The files in .claude/skills/ stay the only source: the mirror is generated, and `--check` (also run
// by tests/agents-skills-mirror.test.mjs) fails when a mirrored file differs from its source or a stale one is left.
// A decision-moment skill is one whose SKILL.md lists [Cnn] questions; skill-forge itself is Claude-specific.
//
// Usage: node .claude/skills/skill-forge/scripts/mirror-skills.mjs [--write] [--root <repo>]
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = '.claude/skills';
export const MIRROR = '.agents/skills';

const isMomentSkill = text => /^- \[C\d\d\] /m.test(text);
const normal = text => text.replace(/\r\n/g, '\n');

/** The skills to mirror: [{ name, text }] from <root>/.claude/skills, sorted by name. */
export async function mirrorPlan(root) {
  const plan = [];
  for (const name of (await readdir(join(root, SOURCE))).sort()) {
    const file = join(root, SOURCE, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const text = await readFile(file, 'utf8');
    if (isMomentSkill(text)) plan.push({ name, text });
  }
  return plan;
}

/** Differences between the plan and <root>/.agents/skills, as readable lines; empty when in sync. */
export async function mirrorDrift(root) {
  const plan = await mirrorPlan(root);
  const drift = [];
  for (const { name, text } of plan) {
    const file = join(root, MIRROR, name, 'SKILL.md');
    if (!existsSync(file)) drift.push(`${MIRROR}/${name}/SKILL.md is missing`);
    else if (normal(await readFile(file, 'utf8')) !== normal(text)) drift.push(`${MIRROR}/${name}/SKILL.md differs from ${SOURCE}/${name}/SKILL.md`);
  }
  const wanted = new Set(plan.map(p => p.name));
  if (existsSync(join(root, MIRROR))) {
    for (const name of await readdir(join(root, MIRROR))) if (!wanted.has(name)) drift.push(`${MIRROR}/${name} has no source skill in ${SOURCE}`);
  }
  return drift;
}

/** Rewrite <root>/.agents/skills from the plan, removing mirrored skills whose source is gone. */
export async function writeMirror(root) {
  const plan = await mirrorPlan(root);
  const wanted = new Set(plan.map(p => p.name));
  if (existsSync(join(root, MIRROR))) {
    for (const name of await readdir(join(root, MIRROR))) if (!wanted.has(name)) await rm(join(root, MIRROR, name), { recursive: true });
  }
  for (const { name, text } of plan) {
    await mkdir(join(root, MIRROR, name), { recursive: true });
    await writeFile(join(root, MIRROR, name, 'SKILL.md'), normal(text), 'utf8');
  }
  return plan.map(p => p.name);
}

async function main(args) {
  const at = args.indexOf('--root');
  const root = resolve(at >= 0 ? args[at + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
  if (args.includes('--write')) {
    console.log(`mirrored to ${MIRROR}: ${(await writeMirror(root)).join(', ')}`);
    return;
  }
  const drift = await mirrorDrift(root);
  for (const line of drift) console.log(line);
  console.log(drift.length ? `${drift.length} difference(s); run: node ${SOURCE}/skill-forge/scripts/mirror-skills.mjs --write` : `${MIRROR} is in sync`);
  if (drift.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

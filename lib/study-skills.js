/* The skills StudyHub ships (skills/<name>/SKILL.md in the package, docs/review-book-agent.md): registered with the host's skill registry
   (`ctx.skills.register`, @deepseek-ai/dsh-skill) when the host has one, so the model's skill catalog lists them in every session that loads the skill
   tool; a host without the registry simply has none. The same file can be copied by the learner into ~/.dsh/skills/<name>/SKILL.md (the host's own
   filesystem provider reads it there); the plugin never writes outside its package. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SHIPPED_SKILLS = ['study-book', 'study-import', 'study-guide'];
const directoryOf = name => fileURLToPath(new URL(`../skills/${name}/`, import.meta.url));

/** A SKILL.md as { name, description, whenToUse?, content }: frontmatter between `---` lines (plain one-line YAML values), then the body. */
export function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ''));
  if (!match) throw new Error('A skill file starts with YAML frontmatter');
  // Our own files keep one `key: value` a line (no YAML library at start-up: the host's cold-start budget, tests/perf-budget.test.mjs).
  const data = Object.fromEntries(match[1].split(/\r?\n/).map(line => /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)).filter(Boolean)
    .map(([, key, value]) => [key, value.trim().replace(/^(["'])(.*)\1$/, '$2')]));
  if (typeof data.name !== 'string' || typeof data.description !== 'string' || !data.description) throw new Error('A skill needs a name and a description');
  return { name: data.name, description: data.description, ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}), content: match[2].trim() };
}

/** The shipped skills as the registry takes them (source 'bundled', the package folder as their base). */
export function studySkills() {
  return SHIPPED_SKILLS.map(name => {
    const directory = directoryOf(name), path = `${directory}SKILL.md`, skill = parseSkill(readFileSync(path, 'utf8'));
    if (skill.name !== name) throw new Error(`skills/${name}/SKILL.md names itself ${skill.name}`);
    return { ...skill, source: 'bundled', path, resourceBase: { kind: 'directory', path: directory }, invocation: { modelInvocable: true, userInvocable: true } };
  });
}

/** Registers the shipped skills with `ctx.skills` (the context the host injected it into); a skill that cannot be read is left out with a warning. */
export function registerStudySkills(ctx) {
  // A host (or a test's fake host) that injects without a registry has no skills to show.
  if (typeof ctx?.skills?.register !== 'function') return [];
  let skills = [];
  try { skills = studySkills(); } catch (error) { ctx.logger?.warn?.(`studyhub skills not registered: ${error.message}`); return []; }
  return skills.map(skill => ctx.skills.register(skill));
}

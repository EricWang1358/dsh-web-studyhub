/* The skills StudyHub ships (skills/<name>/SKILL.md in the package, docs/review-book-agent.md): registered with the host's skill registry
   (`ctx.skills.registerProvider` at bundled rank 600, falling back to `ctx.skills.register`, @deepseek-ai/dsh-skill) when the host has one, so the model's
   skill catalog lists them in every session that loads the skill tool; a host without the registry simply has none. The same file can be copied by the
   learner into ~/.dsh/skills/<name>/SKILL.md (rank 400 in the host's filesystem provider, which outranks bundled rank 600); the plugin never writes outside its package. */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIPPED_SKILLS = ['study-book', 'study-import', 'study-guide', 'study-tutor', 'study-custom', 'study-self'];
export const BUNDLED_SKILL_RANK = 600;
export const STUDY_SKILL_PROVIDER = 'studyhub';
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));
const directoryOf = (name, root = DEFAULT_SKILLS_ROOT) => {
  const dir = join(root, name);
  return dir.endsWith(sep) ? dir : `${dir}${sep}`;
};
const combineSignals = (a, b) => (a && b ? AbortSignal.any([a, b]) : a || b);
const isAbsentError = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

/** A SKILL.md as { name, description, whenToUse?, content }: frontmatter between `---` lines (plain one-line YAML values), then the body. */
export function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ''));
  if (!match) throw new Error('A skill file starts with YAML frontmatter');
  // Our own files keep one `key: value` a line (no YAML library at start-up: the host's cold-start budget, tests/perf-budget.test.mjs).
  const data = Object.fromEntries(match[1].split(/\r?\n/).map(line => /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)).filter(Boolean)
    .map(([, key, value]) => [key, value.trim().replace(/^(["'])(.*)\1$/, '$2')]));
  if (typeof data.name !== 'string' || !data.name || typeof data.description !== 'string' || !data.description) throw new Error('A skill needs a name and a description');
  return { name: data.name, description: data.description, ...(typeof data.whenToUse === 'string' && data.whenToUse ? { whenToUse: data.whenToUse } : {}), content: match[2].trim() };
}

function toBundledEntry(name, raw, root) {
  const directory = directoryOf(name, root), path = `${directory}SKILL.md`, skill = parseSkill(raw);
  if (skill.name !== name) throw new Error(`skills/${name}/SKILL.md names itself ${skill.name}`);
  return { ...skill, source: 'bundled', path, resourceBase: { kind: 'directory', path: directory }, invocation: { modelInvocable: true, userInvocable: true } };
}

/** The shipped skills as the registry takes them (source 'bundled', the package folder as their base). */
export function studySkills(root = DEFAULT_SKILLS_ROOT) {
  return SHIPPED_SKILLS.map(name => toBundledEntry(name, readFileSync(`${directoryOf(name, root)}SKILL.md`, 'utf8'), root));
}

async function listBundledCandidates(root, signal, logger) {
  signal?.throwIfAborted?.();
  const readOpts = signal ? { encoding: 'utf8', signal } : 'utf8';
  let complete = true;
  const settled = await Promise.all(SHIPPED_SKILLS.map(async name => {
    try {
      const entry = toBundledEntry(name, await readFile(`${directoryOf(name, root)}SKILL.md`, readOpts), root);
      const { content: _content, ...summary } = entry;
      return { ...summary, provider: STUDY_SKILL_PROVIDER, rank: BUNDLED_SKILL_RANK, locator: entry.path };
    } catch (error) {
      signal?.throwIfAborted?.();
      if (error?.name === 'AbortError') throw error;
      complete = false;
      logger?.warn?.(`studyhub skill "${name}" skipped: ${error.message}`);
      return undefined;
    }
  }));
  const candidates = settled.filter(Boolean);
  return complete ? candidates : { candidates, complete: false };
}

async function loadBundledDefinition(candidate, signal, invalidate, logger) {
  signal?.throwIfAborted?.();
  let raw, skill;
  try {
    raw = await readFile(candidate.locator, signal ? { encoding: 'utf8', signal } : 'utf8');
    skill = parseSkill(raw);
  } catch (error) {
    signal?.throwIfAborted?.();
    if (error?.name === 'AbortError') throw error;
    invalidate?.();
    if (!isAbsentError(error)) logger?.warn?.(`studyhub skill "${candidate?.name}" not loaded: ${error.message}`);
    return undefined;
  }
  if (!SKILL_NAME.test(skill.name) || skill.name !== candidate.name) {
    invalidate?.();
    logger?.warn?.(`studyhub skill "${candidate?.name}" not loaded: file names itself "${skill.name}"`);
    return undefined;
  }
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    content: skill.content,
    invocation: candidate.invocation,
    source: candidate.source,
    provider: STUDY_SKILL_PROVIDER,
    path: candidate.locator,
    resourceBase: candidate.resourceBase,
  };
}

/** Registers the shipped skills with `ctx.skills` (the context the host injected it into); a skill that cannot be read is left out with a warning. */
export function registerStudySkills(ctx, { root = DEFAULT_SKILLS_ROOT } = {}) {
  // A host (or a test's fake host) that injects without a registry has no skills to show.
  const hasProvider = typeof ctx?.skills?.registerProvider === 'function';
  const hasRegister = typeof ctx?.skills?.register === 'function';
  if (!hasProvider && !hasRegister) return [];
  if (typeof root !== 'string' || !root) {
    ctx.logger?.warn?.('studyhub skills not registered: root must be a non-empty path');
    return [];
  }
  const skills = [];
  for (const name of SHIPPED_SKILLS) {
    try { skills.push(toBundledEntry(name, readFileSync(`${directoryOf(name, root)}SKILL.md`, 'utf8'), root)); }
    catch (error) { ctx.logger?.warn?.(`studyhub skill "${name}" not registered: ${error.message}`); }
  }
  if (!skills.length) return [];
  if (hasProvider) {
    return [ctx.skills.registerProvider(control => ({
      name: STUDY_SKILL_PROVIDER,
      list: options => listBundledCandidates(root, combineSignals(control?.signal, options?.signal), ctx.logger),
      get: (candidate, options) => loadBundledDefinition(candidate, combineSignals(control?.signal, options?.signal), control?.invalidate, ctx.logger),
    }))];
  }
  return skills.map(skill => ctx.skills.register(skill));
}

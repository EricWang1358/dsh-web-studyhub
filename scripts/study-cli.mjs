#!/usr/bin/env node
/**
 * Universal StudyHub CLI bridge for Codex CLI, Antigravity (agy) CLI, Claude Code,
 * OpenCode, or any local agent / shell. Uses StudyService directly so every read
 * and write goes through StudyHub's real file lock, sharded manifest, and FSRS-6 engine.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StudyService } from '../lib/service.js';
import { assistantArgsRefusal, assistantRefusal } from '../lib/assistant-boundary.js';

const BINDING_FILE = '.dsh-study-binding.json';

function usage() {
  return [
    'Usage:',
    '  node scripts/study-cli.mjs root [--cwd <dir>] [--root <dir>]',
    '  node scripts/study-cli.mjs pack [--course <name>] [--deck <id>] [--topic <name>] [--only cram|weak|new|due|focus|all] [--banter light|strict] [--limit <1-100>] [--minutes <n>] [--goal <text>] [--lang zh|en] [--out <file.md>] [--root <dir>]',
    '  node scripts/study-cli.mjs call <action> [json] [--file <payload.json> | --stdin] [--out <file>] [--raw <field>] [--lang zh|en] [--root <dir>] [--cwd <dir>]',
    '',
    'Root resolution order: --root -> STUDYHUB_ROOT -> <cwd>/.dsh-study-binding.json -> <cwd>/.dsh-study',
  ].join('\n');
}

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '--stdin' || token === '--include-mastered') {
      flags[token.slice(2)] = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

async function resolveLibraryRoot({ root, cwd } = {}) {
  const baseCwd = cwd ? resolve(cwd) : process.cwd();
  if (typeof root === 'string' && root.trim()) {
    return isAbsolute(root.trim()) ? root.trim() : resolve(baseCwd, root.trim());
  }
  if (typeof process.env.STUDYHUB_ROOT === 'string' && process.env.STUDYHUB_ROOT.trim()) {
    const envRoot = process.env.STUDYHUB_ROOT.trim();
    return isAbsolute(envRoot) ? envRoot : resolve(baseCwd, envRoot);
  }
  try {
    const raw = await readFile(join(baseCwd, BINDING_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.root === 'string' && parsed.root.trim()) {
      const bound = parsed.root.trim();
      return isAbsolute(bound) ? bound : resolve(baseCwd, bound);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return join(baseCwd, '.dsh-study');
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readPayload(inlineJson, flags) {
  let raw = '';
  if (flags.file) {
    raw = await readFile(resolve(String(flags.file)), 'utf8');
  } else if (flags.stdin) {
    raw = await readStdinText();
  } else if (inlineJson !== undefined) {
    raw = inlineJson;
  } else {
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON payload must be an object');
  }
  return parsed;
}

async function writeTextFile(outPath, content) {
  const target = resolve(String(outPath));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

async function main() {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const command = positionals[0];
  if (flags.help || !command) {
    console.log(usage());
    process.exit(flags.help ? 0 : 1);
  }

  const root = await resolveLibraryRoot({ root: flags.root, cwd: flags.cwd });
  if (command === 'root') {
    console.log(JSON.stringify({ root }));
    return;
  }

  let action;
  let payload;
  if (command === 'pack') {
    action = 'study.voicePack';
    payload = {
      ...(flags.course !== undefined ? { course: String(flags.course) } : {}),
      ...(flags.deck !== undefined ? { deckId: String(flags.deck) } : {}),
      ...(flags.topic !== undefined ? { topic: String(flags.topic) } : {}),
      ...(flags.only !== undefined ? { only: String(flags.only) } : {}),
      ...(flags.banter !== undefined ? { banter: String(flags.banter) } : {}),
      ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
      ...(flags.minutes !== undefined ? { minutes: Number(flags.minutes) } : {}),
      ...(flags.goal !== undefined ? { goal: String(flags.goal) } : {}),
      ...(flags.lang !== undefined ? { language: String(flags.lang) } : {}),
      ...(flags['include-mastered'] ? { includeMastered: true } : {}),
    };
  } else if (command === 'call') {
    action = positionals[1];
    if (!action) throw new Error('Missing <action> name');
    payload = await readPayload(positionals[2], flags);
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  const refusal = assistantRefusal(action) || assistantArgsRefusal(action, payload);
  if (refusal) throw new Error(refusal);

  const language = flags.lang === 'en' ? 'en' : 'zh';
  const service = new StudyService(root, { language });
  try {
    const result = await service.call(action, payload);
    const outPath = typeof flags.out === 'string' && flags.out.trim() ? flags.out.trim() : '';
    const rawField = typeof flags.raw === 'string' && flags.raw.trim() ? flags.raw.trim() : '';

    if (command === 'pack' && outPath) {
      const written = await writeTextFile(outPath, `${result.markdown || ''}\n`);
      console.log(JSON.stringify({
        ok: true,
        root,
        written,
        filename: result.filename,
        count: result.count,
        totalAvailable: result.totalAvailable,
        mastery: result.progress?.mastery ?? 0,
      }, null, 2));
      return;
    }

    if (outPath && action === 'study.voicePack' && /\.md$/i.test(outPath) && !rawField) {
      const written = await writeTextFile(outPath, `${result.markdown || ''}\n`);
      console.log(JSON.stringify({
        ok: true,
        root,
        written,
        filename: result.filename,
        count: result.count,
        totalAvailable: result.totalAvailable,
        mastery: result.progress?.mastery ?? 0,
      }, null, 2));
      return;
    }

    if (rawField) {
      const val = result && typeof result === 'object' ? result[rawField] : undefined;
      const text = typeof val === 'string' ? val : JSON.stringify(val ?? null, null, 2);
      if (outPath) {
        const written = await writeTextFile(outPath, text);
        console.log(JSON.stringify({ ok: true, root, written, field: rawField }));
      } else {
        process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      }
      return;
    }

    const serialized = JSON.stringify(result, null, 2);
    if (outPath) {
      const written = await writeTextFile(outPath, `${serialized}\n`);
      console.log(JSON.stringify({ ok: true, root, written }));
    } else {
      console.log(serialized);
    }
  } finally {
    await service.dispose();
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});

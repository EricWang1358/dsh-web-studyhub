// PreToolUse hook: at a matched Bash command, inject a skill's catch questions as context for the model.
// Usage in settings.json: node skill-moment.mjs <moment-name>, one hook entry per moment, each behind an `if` filter.
// It never blocks and never decides permissions; on any problem it prints nothing and exits 0.
// The moments live in skill-moments.json next to this file; the questions are read from the skill itself,
// so editing a skill's [Cnn] lines changes what the hook asks without touching this file.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, '..', 'skills');

export function questionsFor(skillText, classes) {
  const lines = skillText.split(/\r?\n/).filter(l => /^- \[C\d\d\] /.test(l));
  if (!classes?.length) return lines;
  return lines.filter(l => classes.includes(l.slice(3, 6)));
}

// The parts of a shell command that run as commands: heredoc bodies and quoted strings are data, so a command
// that only writes or echoes the text "gh pr create" does not count as running it.
export function commandText(command) {
  const lines = command.split(/\r?\n/);
  const kept = [];
  let end = null;
  for (const line of lines) {
    if (end !== null) { if (line.trim() === end) end = null; continue; }
    kept.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    if (m) end = m[2];
  }
  return kept.join('\n').replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function contextFor(command, moments, readSkill, only) {
  const text = commandText(command);
  const parts = [];
  for (const m of moments) {
    if (only && m.name !== only) continue;
    if (!new RegExp(m.pattern, 'm').test(text)) continue;
    const qs = questionsFor(readSkill(m.skill), m.classes);
    if (!qs.length) continue;
    parts.push(`${m.lead}\n${qs.join('\n')}\n(From .claude/skills/${m.skill}/SKILL.md; look a class up with: grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md)`);
  }
  return parts.join('\n\n');
}

function main(only) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const command = String(input?.tool_input?.command ?? '');
      const { moments } = JSON.parse(readFileSync(join(here, 'skill-moments.json'), 'utf8'));
      const text = contextFor(command, moments, name => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8'), only);
      if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }));
    } catch { /* stay silent: a broken hook must not stop the command */ }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv[2]);

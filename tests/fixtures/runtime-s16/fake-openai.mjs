import { readFile } from 'node:fs/promises';
import { createFakeModel } from '../../../scripts/fake-model.mjs';
export { FAKE_OPENAI_MODEL } from '../../../scripts/qa/fake-openai.mjs';
// Test-only extension of the repository local server: an actual DSH child gets
// the step instruction in its user turn. Decode that envelope for the same
// synthetic answer families; no provider SDK or production model route changes.
export async function createFakeOpenAI(options) {
  const file = new URL('../../../scripts/qa/fake-openai.mjs', import.meta.url);
  let source = await readFile(file, 'utf8');
  source = source.replace('from "../fake-model.mjs"', `from ${JSON.stringify(new URL('../../../scripts/fake-model.mjs', import.meta.url).href)}`);
  source = source.replace('const prompt = text(messages.filter((m) => m.role === "user").at(-1)?.content);', 'const userTurns = messages.filter(m => m.role === "user").map(m => text(m.content)); const prompt = userTurns.findLast(value => /You (?:proofread speech-to-text|translate paragraphs|write one English title)/.test(value)) || userTurns.at(-1) || "";');
  source = source.replace('const handled = studyLog.slice(before).some((entry) => entry.handler);', 'const handled = !!model || studyLog.slice(before).some((entry) => entry.handler);');
  const guard = source.indexOf('if (process.argv[1]');
  if (guard >= 0) source = source.slice(0, guard);
  const server = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`), log = [], fake = createFakeModel({ log });
  return server.createFakeOpenAI({ ...options, model: async (system, prompt) => {
    const clean = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    const marker = clean.search(/You (?:proofread speech-to-text|translate paragraphs|write one English title)/);
    if (marker >= 0) {
      const forwarded = clean.slice(marker), at = forwarded.lastIndexOf('\n\n{');
      if (at >= 0) {
        const payload = forwarded.slice(at + 2); let depth = 0, quoted = false, escaped = false;
        for (let index = 0; index < payload.length; index++) {
          const char = payload[index];
          if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
          else if (char === '"') quoted = true;
          else if (char === '{') depth++;
          else if (char === '}' && --depth === 0) return fake(forwarded.slice(0, at), payload.slice(0, index + 1));
        }
      }
    }
    return fake(system, prompt);
  } });
}

import { createLocator } from '../../../quote-locate.js';
import { blockWords } from './jobs/messages.js';

/* The answer of an explain / add-a-paragraph call, checked by the program: the text, the quotes found word for word in the point's materials
   (lib/quote-locate.js; a quote that is not found is dropped and counted), and what goes beyond the materials, kept apart as extra. Pure. */

const TEXT_MAX = 6000, QUOTES = 4, EXTRA = 3;
const clip = (value, size) => (typeof value === 'string' ? value.trim().slice(0, size) : '');

/** The model's JSON (a fenced block is fine), or null when it cannot be read or holds no text. */
export function readAi(text) {
  const body = String(text ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  let data;
  try { data = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)); } catch { return null; }
  const answer = clip(data?.text, TEXT_MAX);
  if (!answer) return null;
  return { text: answer, quotes: (Array.isArray(data.quotes) ? data.quotes : []).map(item => clip(item, 400)).filter(Boolean).slice(0, QUOTES),
    extra: (Array.isArray(data.extra) ? data.extra : []).map(item => clip(item, 400)).filter(Boolean).slice(0, EXTRA) };
}

/** The block's Markdown from a read answer: the text, the quotes found in `segments` (as quoted lines with their material), the extra apart. -> { body, dropped } */
export function blockBody(answer, segments, language) {
  const words = blockWords(language), found = [];
  let dropped = 0;
  for (const quote of answer.quotes) {
    const segment = segments.find(part => part.text.includes(quote) || createLocator(part.text)(quote));
    if (segment) found.push({ quote, material: segment.material }); else dropped += 1;
  }
  const lines = [answer.text];
  if (found.length) lines.push('', `**${words.quotes}**`, '', ...found.map(item => `> ${item.quote.replace(/\n+/g, ' ')}${item.material ? ` —— ${item.material}` : ''}`));
  if (answer.extra.length) lines.push('', `**${words.extra}**`, '', ...answer.extra.map(item => `- ${item.replace(/\n+/g, ' ')}`));
  return { body: lines.join('\n'), dropped };
}

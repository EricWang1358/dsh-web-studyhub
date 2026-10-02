/* The contracts of the usage frequency record (lib/usage-frequency.js). They are panel operations: the assistant's study_workspace tool refuses
   the whole `usage.frequency.` family (lib/study-contracts.js), so what the learner does in the app is never something the assistant can read,
   switch on or send. */
const boolean = { type: 'boolean' }, string = { type: 'string' }, integer = { type: 'integer' };
const period = { oneOf: [{ type: 'integer', enum: [7, 30] }, { type: 'string', enum: ['all'] }] };
const language = { type: 'string', enum: ['zh', 'en'] };
const none = { type: 'object', additionalProperties: false, properties: {} };
const status = { type: 'object', additionalProperties: true, properties: { enabled: boolean, paused: boolean, hasData: boolean, daysWithData: integer, since: string, file: string, limits: { type: 'object', additionalProperties: true } } };

export const usageFrequencySchemas = {
  'usage.frequency.status': { description: 'Whether the usage frequency record is on or paused, and whether it holds anything (days with data, since when, where the file is). Never creates the file.',
    input: none, output: status },
  'usage.frequency.set': { description: 'Turn the usage frequency record on or off, or pause and resume it. Off by default; turning it off keeps what was recorded until it is deleted.',
    input: { type: 'object', additionalProperties: false, properties: { enabled: boolean, paused: boolean } }, output: status },
  'usage.frequency.record': { description: 'Add a batch (at most 500) of aggregated counts { key, area, day (local YYYY-MM-DD), n } to the record. Refused, and nothing written, while the record is off or paused.',
    input: { type: 'object', additionalProperties: false, properties: { records: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { key: string, area: string, day: string, n: integer } } } }, required: ['records'] },
    output: { type: 'object', additionalProperties: true, properties: { accepted: integer, rejected: integer, enabled: boolean } } },
  'usage.frequency.report': { description: 'The personal usage report for the last 7 days, the last 30 days or all time: summary, ranked controls, shares by page and tier, the daily rhythm, controls never used, and rule-based observations. Never calls a model.',
    input: { type: 'object', additionalProperties: false, properties: { period, language } },
    output: { type: 'object', additionalProperties: true, properties: { period, summary: { type: 'object', additionalProperties: true }, ranking: { type: 'array', items: { type: 'object', additionalProperties: true } }, observations: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
  'usage.frequency.export': { description: 'The report as a file to read, keep or send: Markdown, or JSON of aggregated counts with the app version, the period and the registry names. `labels` names unregistered keys in the page language.',
    input: { type: 'object', additionalProperties: false, properties: { format: { type: 'string', enum: ['json', 'markdown'] }, period, language, labels: { type: 'object', additionalProperties: true } } },
    output: { type: 'object', additionalProperties: true, properties: { filename: string, mime: string, content: string } } },
  'usage.frequency.clear': { description: 'Delete every usage record. The on/off switch stays as it is.',
    input: none, output: status },
};

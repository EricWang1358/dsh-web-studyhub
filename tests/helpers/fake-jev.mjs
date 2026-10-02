import { createServer } from 'node:http';

/* A fake Jev (TypeSafe AI "System One") API on a local HTTP server, built from the official documentation (docs.typesafe.ai):
   POST /v1/systemone, `Authorization: Bearer <key>`, body { state, model, questions: { name: { type, instructions, criteria? } } },
   answer { model, answers: { name: { type: 'noul', noul } | { type: 'choice', choice, probabilities, confidence } |
   { type: 'score', score, legend, probabilities, confidence } }, usage: { input_tokens, output_tokens } }.
   Errors: 401 invalid or missing key, 422 validation, 429 rate limit, 529 overloaded. It validates requests the way the
   documentation describes (instructions required, at most 255 choices, 2 to 10 score levels), so a client that builds a request
   the real service would refuse fails here too. Nothing in this file talks to the real service.

   It answers on two paths, the way the two real endpoints are laid out: TypeSafe's own /v1/systemone (any model alias) and
   OpenCode Zen's /zen/v1/systemone (https://opencode.ai/docs/zen/), where only the two model ids the Zen list shows are
   accepted (jev-1.13, jev-1.13-free). Both enforce the Authorization header. How the real Zen endpoint words its errors is
   NOT known, so the failure bodies a test queues are the fake's own invention. */

export const FAKE_KEY = 'tsk_fake_JEV_key_0000000000000000000001';
/** The paths this fake serves, and the models the Zen path accepts. */
export const FAKE_PATHS = Object.freeze({ typesafe: '/v1/systemone', opencode: '/zen/v1/systemone' });
export const ZEN_MODELS = Object.freeze(['jev-1.13', 'jev-1.13-free']);

const json = (response, body, status = 200, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};
const round = value => Math.round(value * 1000) / 1000;

/** Problems the documented schema would reject, as the 422 detail. */
export function validationProblems(payload) {
  const problems = [];
  if (!payload || typeof payload !== 'object') return ['body must be an object'];
  if (payload.state === undefined || payload.state === null || payload.state === '') problems.push('state is required');
  if (typeof payload.model !== 'string' || !payload.model) problems.push('model is required');
  const questions = payload.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) problems.push('questions is required');
  else for (const [name, question] of Object.entries(questions)) {
    if (!question || typeof question !== 'object') { problems.push(`${name}: must be an object`); continue; }
    if (!['noul', 'choice', 'score'].includes(question.type)) { problems.push(`${name}: unknown type`); continue; }
    if (question.instructions === undefined || question.instructions === '') problems.push(`${name}: instructions is required`);
    if (question.type === 'choice') {
      const count = question.criteria && typeof question.criteria === 'object' && !Array.isArray(question.criteria) ? Object.keys(question.criteria).length : 0;
      if (!count) problems.push(`${name}: criteria (a map of options) is required`);
      if (count > 255) problems.push(`${name}: at most 255 options`);
    }
    if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)) problems.push(`${name}: criteria must list 2 to 10 levels`);
    if (question.type === 'noul' && question.criteria !== undefined && (typeof question.criteria !== 'object' || Array.isArray(question.criteria))) problems.push(`${name}: criteria must be an object`);
  }
  return problems;
}

/** The default answer: noul 0.5, the first choice at 0.6, the middle score level. Tests replace it with `answer`. */
export function defaultAnswer(question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria), rest = keys.length > 1 ? 0.4 / (keys.length - 1) : 0;
    const probabilities = Object.fromEntries(keys.map((key, index) => [key, round(index === 0 ? (keys.length > 1 ? 0.6 : 1) : rest)]));
    const top = Math.max(...Object.values(probabilities));
    return { type: 'choice', choice: keys[0], confidence: round(keys.length > 1 ? (top - 1 / keys.length) / (1 - 1 / keys.length) : 1), probabilities };
  }
  const levels = question.criteria.length, middle = Math.floor(levels / 2);
  return { type: 'score', score: middle, confidence: 1, legend: Object.fromEntries(question.criteria.map((text, index) => [String(index), text])),
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === middle ? 1 : 0])) };
}

/**
 * options:
 *  key                  accepted bearer key (default FAKE_KEY)
 *  answer(name, question, state, payload)   the answer object for one question (default: defaultAnswer)
 *  failures             array of HTTP statuses (or { status, headers, body }) consumed one per request, before any answer
 *  delayMs              hold each response this long (timeouts)
 *  model                the model name echoed back (default jev-1.13.0)
 *  usage(payload)       custom usage
 *  onRequest(entry)     observe each request
 */
export async function startFakeJev(options = {}) {
  const key = options.key ?? FAKE_KEY, requests = [], failures = [...(options.failures || [])];
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const part of request) chunks.push(part);
    const text = Buffer.concat(chunks).toString('utf8');
    let payload; try { payload = JSON.parse(text); } catch { payload = undefined; }
    const entry = { method: request.method, path: new URL(request.url, origin()).pathname, headers: { ...request.headers }, body: text, payload };
    requests.push(entry);
    options.onRequest?.(entry);
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    const fail = failures.shift();
    if (fail !== undefined) {
      const spec = typeof fail === 'number' ? { status: fail } : fail;
      return json(response, spec.body ?? { detail: `fake failure ${spec.status}` }, spec.status, spec.headers);
    }
    if (entry.method !== 'POST' || !Object.values(FAKE_PATHS).includes(entry.path)) return json(response, { detail: 'not found' }, 404);
    if (request.headers.authorization !== `Bearer ${key}`) return json(response, { detail: 'invalid or missing API key' }, 401);
    const problems = validationProblems(payload);
    if (entry.path === FAKE_PATHS.opencode && !ZEN_MODELS.includes(payload?.model)) problems.push('model is not available on Zen');
    if (problems.length) return json(response, { detail: problems }, 422);
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([name, question]) =>
      [name, options.answer ? options.answer(name, question, payload.state, payload) : defaultAnswer(question)]));
    const size = text.length;
    return json(response, { model: options.model ?? 'jev-1.13.0', answers,
      usage: options.usage ? options.usage(payload) : { input_tokens: Math.ceil(size / 4), output_tokens: 8 * Object.keys(answers).length } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: origin(), key, requests,
    /** Queue more failures. */
    fail(...statuses) { failures.push(...statuses); },
    /** Forget failures nobody asked for yet. */
    clearFailures() { failures.length = 0; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

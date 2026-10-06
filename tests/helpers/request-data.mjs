import { parseJson } from '../../lib/generation.js';

/* The request data of a generation prompt (plan, blueprint, author, review, patch) as a fake model or a test reads it. The stage prompts keep their data behind a
   `REQUEST DATA:` marker, and a prompt whose sources lead (lib/prompt-order.js) has its instructions AFTER the data, so the data is the first JSON value after the
   marker (parseJson takes the first balanced value and leaves what follows alone). A prompt without a marker (the review payload) is the JSON value itself. */
export function requestData(prompt) {
  const marker = 'REQUEST DATA:\n', at = String(prompt).indexOf(marker);
  return parseJson(at < 0 ? String(prompt) : String(prompt).slice(at + marker.length));
}

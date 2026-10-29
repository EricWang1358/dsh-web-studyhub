import { getUiLanguage } from '../i18n.js';
import { say } from './say.js';
import { GUIDED_EXAMPLES } from '../guided-study/examples.js';

/* 'guided.start' (#549): one of the sentences that start AI 带学 (ui/guided-study/examples.js), sent as the learner's own words; the entry's skill
   (skills/study-tutor) runs the loop. input: { example } — the id of the sentence; an unknown id is the first one. */
export function guidedStartPrompt(input = {}, language = getUiLanguage()) {
  const example = GUIDED_EXAMPLES.find((item) => item.id === input.example) || GUIDED_EXAMPLES[0];
  return { ask: say(language, example.text) };
}

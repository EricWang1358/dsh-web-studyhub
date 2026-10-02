import { NONE_KEY } from '../../lib/jev-course-suggest.js';

/* An "oracle" Jev for the evaluation tests: it answers every question from the labels of a dataset (lib/jev-eval.js format), so the metrics
   have a known right answer. `mistakes(kind, id)` may return true to make it wrong on one item. Not a model of Jev. */
export function oracleAnswer(dataset, { mistakes = () => false, sure = 0.95 } = {}) {
  const f = dataset.features;
  const mass = (keys, pick, top) => Object.fromEntries(keys.map(key => [key, key === pick ? top : (1 - top) / (keys.length - 1)]));
  const choiceAnswer = (question, pick, top) => {
    const keys = Object.keys(question.criteria), probabilities = mass(keys, pick, top);
    return { type: 'choice', choice: pick, confidence: (top - 1 / keys.length) / (1 - 1 / keys.length), probabilities };
  };
  return (name, question, state) => {
    if (question.type === 'noul') {
      if (name === 'greeting') return { type: 'noul', noul: 0.9 };
      const item = f.preReview?.items.find(entry => entry.card.prompt === state.question);
      const truth = item.labels[name], wrong = mistakes('preReview', item.id);
      return { type: 'noul', noul: (truth !== wrong) ? sure : 1 - sure };
    }
    const keys = Object.keys(question.criteria);
    if (name === 'course') {
      const item = f.courseSuggest.items.find(entry => entry.title === state.title), wrong = mistakes('courseSuggest', item.id);
      const truth = item.course ?? NONE_KEY, pick = wrong ? keys.find(key => key !== truth && key !== NONE_KEY) : truth;
      return choiceAnswer(question, pick, sure);
    }
    if (name === 'level') {
      const item = f.levelCheck.items.find(entry => entry.card.prompt === state.question), wrong = mistakes('levelCheck', item.id);
      return choiceAnswer(question, wrong ? keys.find(key => key !== item.level) : item.level, sure);
    }
    const n = Number(name.slice(1)), text = state.headings.find(entry => entry.n === n).text;
    const item = f.outlineNoise.items.find(entry => entry.title === text), wrong = mistakes('outlineNoise', item.id);
    return choiceAnswer(question, wrong ? keys.find(key => key !== item.label) : item.label, sure);
  };
}

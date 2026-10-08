import { paperPrompt } from '../prompts.js';
import { readPaper } from '../read.js';
import { unreadable } from './failures.js';
import { WHERE } from './messages.js';
import { evidenceOf } from './stage-context.js';

/**
 * Stage 1: the sample papers, a chunk at a time: what each question tests. A question whose quote is not in the paper keeps its points but has no place to show,
 * so it cannot make them sample-paper points. A chunk the model cannot answer is a hard failure: without the papers the points a paper reached would be wrong.
 * @returns [{ key, questions: [{ qid, label, type?, marks?, evidence?, points }] }], one entry per chunk, in reading order
 */
export async function readPapers(ctx) {
  const { plan, input, state, ask, show, boundary, resolveOne } = ctx, papers = [];
  for (const piece of plan.paperChunks) {
    boundary(`paper:${piece.number}`);
    state.stage = 'paper'; show();
    const labels = { stage: 'paper', part: piece.number, parts: plan.paperChunks.length };
    const result = await ask(piece.askKey, labels, paperPrompt(piece, plan), text => readPaper(text, piece), async read => {
      const questions = [];
      for (const { sourceId, quote, ...question } of read.questions) {
        const selection = sourceId ? await resolveOne(sourceId, quote) : null;
        questions.push({ ...question, ...(selection ? { evidence: evidenceOf(selection, 'past-paper') } : {}) });
      }
      return { questions, unverified: questions.filter(question => !question.evidence).length };
    });
    if (!result) throw unreadable(input, WHERE.paper(input.language));
    papers.push({ key: piece.key, questions: result.questions });
    state.unverifiedQuestions += result.unverified; state.papers.done++; show();
  }
  return papers;
}

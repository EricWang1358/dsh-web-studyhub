import { policyOf } from '../../inventory/policy.js';
import { assembleKit } from '../kit/assemble.js';
import { planKit } from '../kit/plan.js';
import { kitPrompt } from '../kit/prompt.js';
import { readKit } from '../kit/read.js';

/* Stage 4b (only with sample papers, after 考情): the exam answer kit (#710 S4). The program plans it (book/kit/plan.js: the paper questions, their types, what
   the saved kit already holds); each call writes some types, in parallel in the attempt's one pool, its answer checked (book/kit/read.js). A type whose call
   failed is left out, counted as missed (the Job ends partial and the next build asks only it). The kit is set on `work.examKit` for the save; none without
   papers or without a question placed on a point. */

export async function kitStage(ctx, work) {
  const { plan, state, show, parallel } = ctx, kit = planKit(work, plan);
  if (!kit) return;
  const policy = policyOf('kit', plan.efforts), written = new Map();
  state.kit.total = kit.batches.length;
  if (kit.batches.length) { state.stage = 'kit'; show(); }
  await parallel.each(kit.batches, async batch => {
    const answer = await parallel.ask(batch.key, { stage: 'kit', part: batch.number, parts: kit.batches.length }, policy, kitPrompt(batch, plan, kit),
      text => readKit(text, batch));
    batch.types.forEach((type, at) => { const got = answer?.types.get(at); if (got) written.set(type.print, got); else state.missed++; });
    state.kit.done++; show();
  }, 'kit');
  const record = assembleKit(kit, written);
  if (record) work.examKit = record;
}

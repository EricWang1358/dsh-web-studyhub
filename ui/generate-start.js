import { freshGeneration, generationStartedNotice } from './generation-status.js';
import { generationRequest } from './generate-form.js';

/* Starting one question run from the 创建题组 form's state: the one place both 创建题组's 生成并检查题组 and the first-run line's 出第一组题 (3.6 D4) go
   through, so the line never sends a request of its own. */

/**
 * Send `generate` with the form as it stands (generationRequest: the form's choices, the course, the materials), then say what the progress card does not
 * (a plan of several rounds: generationStartedNotice), start the next deck from a clean form (P27) and hand the job to `then`. `act` is the app's
 * single-flight action; it returns its promise.
 */
export function startGeneration({ act, notify, setGen, data, gen, course, sourceIds, then }) {
  return act('generate', generationRequest(gen, { course, sourceIds }), (job) => {
    const notice = generationStartedNotice(job);
    if (notice) notify(notice);
    setGen((current) => freshGeneration(current, data?.settings?.generation));
    then?.(job);
  });
}

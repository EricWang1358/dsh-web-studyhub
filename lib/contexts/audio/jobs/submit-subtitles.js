import { AUDIO_TEXT } from '../../../audio-messages.js';
import { subtitleKey, subtitlePlan } from '../../../subtitle-job.js';
import { startTextJob } from './submit-text.js';

export const SUBTITLES_KIND = 'audio-subtitles';
/** The fields of the resolved import context a subtitle job keeps (the cues travel separately; nothing else of the request is needed). */
const CONTEXT_FIELDS = ['title', 'subject', 'course', 'courses', 'vocabulary', 'paidOnly'];

/** Start a subtitle import on the runtime. The same cues under the same settings are refused while imported; a different file of the same name is not. */
export async function startSubtitles(service, { input, args }, running) {
  const context = Object.fromEntries(CONTEXT_FIELDS.filter(field => args[field] !== undefined).map(field => [field, args[field]]));
  const key = subtitleKey(subtitlePlan({ input, args: context, settings: await service.audioSettings() }));
  return startTextJob(service, { kind: SUBTITLES_KIND, input: { input, args: context }, key, busy: AUDIO_TEXT.subtitleRunning }, running);
}

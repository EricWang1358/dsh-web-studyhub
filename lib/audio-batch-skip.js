import { readAudioBatch, saveAudioBatch } from './audio-batch.js';
import { AUDIO_TEXT } from './audio-messages.js';

/**
 * "Skip this file and continue": the members stay in the manifest (their result files keep their numbers) but are left out. The request is
 * validated before anything is written; the result says how to put the marks back should the retry not start.
 */
export async function skipMembers(root, batchId, skip) {
  const batch = await readAudioBatch(root, batchId);
  if (!Array.isArray(skip) || !skip.length || skip.some(index => !Number.isInteger(index) || !batch.members.some(member => member.index === index)))
    throw new Error(AUDIO_TEXT.skipInvalid);
  const marked = batch.members.filter(member => skip.includes(member.index) && !member.skipped);
  if (batch.members.every(member => member.skipped || skip.includes(member.index))) throw new Error(AUDIO_TEXT.allSkipped);
  for (const member of marked) member.skipped = true;
  await saveAudioBatch(root, batch);
  return async () => {
    const latest = await readAudioBatch(root, batchId);
    for (const member of latest.members) if (marked.some(item => item.index === member.index)) delete member.skipped;
    await saveAudioBatch(root, latest);
  };
}

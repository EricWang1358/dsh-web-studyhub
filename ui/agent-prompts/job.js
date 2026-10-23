import { getUiLanguage } from '../i18n.js';
import { situationMessage } from './situation.js';

/* The hand-off of a background job that did not finish (the hand-off plan, 1.3 'job.failed'): a failed, interrupted or stopped transcription, conversion,
   question run or translation, from its card on a page (ui/tasks/CompactJobCard.jsx), the 任务 console (ui/tasks/RunLine.jsx) or a conversion's failure
   detail (ui/PdfConvertJob.jsx). Built on situation.js: the learner's sentence, the job's facts and its error in fences, then: find out why first, never
   retry or resubmit without asking (the contracts forbid automatic retries and duplicate jobs), finish it another way. The library.context area is the
   one that holds the job's own actions. */

const KIND_AREA = Object.freeze({ generation: 'generation', supplement: 'generation', 'draft-repair': 'generation', 'draft-publish': 'generation',
  'audio-import': 'imports', 'pdf-convert': 'imports' });

const HOW = '做法：有对应的 StudyHub 工具就直接用；要转换文件时，结果写到工作区的 studyhub-work/ 下再导入。';
const HINTS = [
  '诊断：先用 job.status 读这个任务，再用 job.output 看它最后的输出，弄清它为什么停下，先告诉我。',
  '接着做：原因在设置里（密钥、模型、转换工具）的，让我去设置页；能接着做的先问我，再用 job.control 的 retry 接着做同一个任务，不要另外提交一个新任务。',
  '换条路：接着做也不行时，换一条路做完（例如分成小一点的几段，或换一种导入方式），做之前说清楚要怎么做。',
];

/**
 * input: { jobId, kind (the contract's), title, status ('failed' | 'interrupted' | 'cancelled'), line (what the card says), error (the failure as recorded,
 * with the converter's last lines when there are), sourceIds, draftId, converter }.
 */
export function jobFailedPrompt({ jobId = '', kind = '', title = '', status = '', line = '', error = '', sourceIds = [], draftId = '', converter = '' } = {}, language = getUiLanguage()) {
  return situationMessage({ area: '任务', goal: '把这个没做完的任务做完', context: KIND_AREA[kind] || 'organization', how: HOW, hints: HINTS,
    facts: { jobId, kind, title, status, line, sourceIds: sourceIds?.length ? sourceIds : undefined, draftId, converter }, error }, language);
}

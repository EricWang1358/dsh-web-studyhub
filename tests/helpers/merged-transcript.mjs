/* The audited merged transcript, built by the real writers (lib/transcript.js buildDocuments for each recording, lib/audio-batch.js batchDocuments for the
   merge): 5 recordings of 16 parts (80 parts, about 530k characters) cut into two volumes, the fourth recording split across them. */
import { buildDocuments } from '../../lib/transcript.js';
import { batchDocuments } from '../../lib/audio-batch.js';

export const RECORDING_NAMES = ['API应用与产品策略培训.mp3', '平台框架培训-第二天.mp3', '平台框架培训-第一天.mp3', '产品策略答疑录音.wav', 'API治理与复用设计.mp3'];

const sentence = (recording, part, index) => [1, 2, 3, 4].map(k => `Recording ${recording}, part ${part}, point ${index + 1}.${k}: we discuss the platform team and what each product group must build, and why that choice has a cost for the teams that reuse it.`).join(' ');
const chinese = (recording, part, index) => [1, 2, 3, 4].map(k => `录音${recording}，第${part}段，第${index + 1}点.${k}：我们讨论平台团队，以及每个产品组必须构建什么，还有这个选择对复用它的团队意味着怎样的成本。`).join('');

/** `{ volumes: [text, text], sources: [{ id, text, title, audio }], parts: 80, recordings: 5 }` */
export function mergedTranscript({ recordings = 5, parts = 16, paragraphs = 8, language = 'zh', limit = 400_000 } = {}) {
  const members = RECORDING_NAMES.slice(0, recordings).map((filename, index) => ({ filename, index }));
  const results = members.map((member, at) => ({ documents: buildDocuments({ filename: member.filename, titleEn: `Preview Lecture Recording ${at + 1}`, language, limit: Infinity,
    parts: Array.from({ length: parts }, (_, part) => ({ titleZh: `预览段落 ${part + 1}`, titleEn: `Preview Passage ${part + 1}`,
      english: Array.from({ length: paragraphs }, (_, index) => sentence(at + 1, part + 1, index)),
      chinese: Array.from({ length: paragraphs }, (_, index) => chinese(at + 1, part + 1, index)) })) }) }));
  const volumes = batchDocuments(`${members[0].filename} + ${recordings - 1}`, members, results);
  return { volumes, sources: volumes.map((text, index) => ({ id: `audio-batch-vol${index + 1}`, title: `merged (${index + 1}/${volumes.length})`, text, audio: { batch: { id: 'b1', volume: index + 1 } } })),
    parts: recordings * parts, recordings };
}

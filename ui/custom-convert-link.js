import { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useHandOff } from './hand-off/use-hand-off.js';
import { CUSTOM_BOOK_LABEL, CUSTOM_BOOK_WHAT, customOffered, markCustomOffered, offersCustom } from './custom-entry.js';

/** 深度定制这本书 on the card of a finished book of CUSTOM_BOOK_PAGES pages or more (ui/custom-entry.js), once, as on its 解析历史 row: the card is where a
    finished import is seen first, and 用它出题 next to it would make questions of every page before the learner was asked what the book is for. */
export function useCustomLink(job) {
  const handOff = useHandOff(), [offered, setOffered] = useState(() => customOffered(job.documentId));
  const pages = job.sourceIds?.length ?? 0;
  if (job.status !== 'complete' || !job.documentId || !offersCustom(pages) || offered) return null;
  return { label: ui(CUSTOM_BOOK_LABEL), tip: ui(CUSTOM_BOOK_WHAT), aria: uiFormat('{0}：{1}', [ui(CUSTOM_BOOK_LABEL), job.filename || job.title || '']),
    run: async () => {
      if (await handOff.send('custom.start', { document: job.documentId, pages }) === 'failed') return;
      markCustomOffered(job.documentId);
      setOffered(true);
    } };
}

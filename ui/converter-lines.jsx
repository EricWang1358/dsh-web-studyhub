import React from 'react';
import { ui } from './i18n.js';

/* Two lines the import hub's converter cards (ui/LargeDocumentCard.jsx, in the workspace's first load) and the manual-conversion guide
   (ui/PdfExternalConvertGuide.jsx, its own chunk: ui/pdf-external-guide-lazy.jsx) both say. They live here so a card can say them without bringing the guide along. */

/** The page marker StudyHub reads in Markdown (lib/converted-document.js), as a person writes it. */
export const PAGE_MARKER = '<!-- page: N -->';

/** Licence, platforms and outputs of a catalogue tool on one line (the line a tool card shows). */
export const toolMetaLine = tool => [ui(tool.license), tool.platforms.map(platform => ui(platform)).join(' / '), ...(tool.outputs ? [tool.outputs.join(', ')] : [])].join(' · ');

/** What to download once a converter is done: the one line the PaddleOCR option (LargeDocumentCard) and the guide's step 1 both say. */
export function ConvertedFileFormats() {
  return <>{ui('解析完成后，下载 JSON 结果文件（或带')}{' '}<code translate="no">{PAGE_MARKER}</code>{' '}{ui('页码标记的 Markdown）')}</>;
}

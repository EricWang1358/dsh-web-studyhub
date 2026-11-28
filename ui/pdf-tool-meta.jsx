import React from 'react';
import { ui } from './i18n.js';
import { PAGE_MARKER } from './pdf-page-marker.js';

/* Tiny shared formatting helpers used by both LargeDocumentCard (on the daily path) and PdfExternalConvertGuide
   (loaded lazily with PDF conversion / TaskConsole / Settings), so LargeDocumentCard does not pull mineru.css
   or the full external conversion guide into the workspace first-load static closure. */

/** Licence, platforms and outputs of a catalogue tool on one line (the line a tool card shows). */
export const toolMetaLine = tool => [ui(tool.license), tool.platforms.map(platform => ui(platform)).join(' / '), ...(tool.outputs ? [tool.outputs.join(', ')] : [])].join(' · ');

/** What to download once a converter is done: the one line the PaddleOCR option (LargeDocumentCard) and external guide step 1 both say. */
export function ConvertedFileFormats() {
  return <>{ui('解析完成后，下载 JSON 结果文件（或带')}{' '}<code translate="no">{PAGE_MARKER}</code>{' '}{ui('页码标记的 Markdown）')}</>;
}

/* External PDF conversion reference links and the 3-step post-conversion import guide (#1765).
   The tools are NOT listed here: they are read from the catalogue in lib/large-documents.js (TOOLS), the one list the import hub, the generate page and Settings
   share. This file only says which of them the guide shows and which of each one's addresses it prints. The limits it quotes come from LARGE_DOCUMENT_LIMITS and
   lib/office/limits.js (see PdfExternalConvertGuide.jsx), never from numbers written into wording.
   StudyHub does NOT call third-party APIs, proxy files, or guarantee third-party availability. */
import { TOOLS } from '../lib/large-documents.js';
export { PAGE_MARKER } from './pdf-page-marker.js';

export const EXTERNAL_PDF_GUIDE_TITLE = '想用外部工具转换？';
export const EXTERNAL_PDF_GUIDE_META = '手动转换 · 外链参考';

export const EXTERNAL_PDF_PRIVACY_NOTICE = '文件上传到第三方属于你与该服务之间的事，本产品不经手、不保存。';
export const EXTERNAL_PDF_SCOPE_NOTE = '以下仅为外部工具参考链接：不内置调用、不代传文件、不承诺第三方服务的可用性。请复制链接到浏览器自行打开。';

/** The catalogue entries the guide shows, in order: tools StudyHub does not run itself (so not Marker or local MinerU, which the PDF panel runs). */
export const EXTERNAL_PDF_TOOL_IDS = Object.freeze(['paddleocr', 'mineru-web', 'docling', 'mathpix']);

/** The one address printed for a tool: the web page of an online tool, the code page of one you run yourself. A plain text address, never a query string. */
const entryUrl = tool => tool.channels.find(channel => channel.kind === (tool.needs === 'online' ? 'official' : 'source'))?.url;

/** { id, tool (the TOOLS entry), url } for each listed tool still in the catalogue. */
export const EXTERNAL_PDF_TOOLS = Object.freeze(EXTERNAL_PDF_TOOL_IDS.flatMap(id => {
  const tool = TOOLS.find(entry => entry.id === id);
  const url = tool && entryUrl(tool);
  return url ? [Object.freeze({ id, tool, url })] : [];
}));

export const EXTERNAL_PDF_TOOL_URLS = Object.freeze(EXTERNAL_PDF_TOOLS.map(entry => entry.url));

export const EXTERNAL_PDF_IMPORT_TITLE = '转换完成后怎么导入';

/** Real formats verified against lib/contexts/materials/files.js. Step 1's body is built in the component (it quotes the limits). */
export const EXTERNAL_PDF_IMPORT_STEPS = Object.freeze([
  Object.freeze({ id: 'formats', title: '1. 确认导出格式' }),
  Object.freeze({
    id: 'where',
    title: '2. 放到哪里、怎么导入',
    body: '打开「资料」页，点击「添加资料」（或在「创建题组」里点击「添加资料」），选好课程后在「文件」标签拖入转换好的文件或点击「选择文件」；纯文本也可切到「粘贴文本」直接保存。如在主会话中使用学习模式，也可放到工作区的 studyhub-work/ 或电脑本地目录后让 AI 导入。',
  }),
  Object.freeze({
    id: 'failures',
    title: '3. 常见失败与排查',
    items: Object.freeze([
      Object.freeze({
        id: 'formulas',
        label: '公式丢失',
        detail: '普通转换常把公式丢掉或转成图片。请在外部工具中开启公式转 LaTeX，导出为 .md 或 .tex（用 $...$ / $$...$$ 保留公式），避免只导出纯文本。',
      }),
      Object.freeze({
        id: 'scanned',
        label: '扫描版仍是图片',
        detail: '若导出的仍是图片型 PDF 或只含图片链接的 Markdown，StudyHub 读不出正文（.md 中的独立图片行会被跳过）。请在外部工具中开启 OCR 文字识别后再导出文字或结构化 JSON。',
      }),
      Object.freeze({
        id: 'encoding',
        label: '编码不是 UTF-8',
        detail: 'StudyHub 要求文本与 JSON 文件为 UTF-8 编码；GBK、GB18030 或 UTF-16 会报编码错误或乱码。请用编辑器（如 VS Code 或记事本）选择「另存为 UTF-8」后再重新导入。',
      }),
    ]),
  }),
]);

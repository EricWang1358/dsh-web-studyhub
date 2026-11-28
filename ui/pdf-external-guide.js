/* External PDF conversion reference links and 3-step post-conversion import guide (#1765).
   Pure data shared by the PDF conversion entry, job detail, settings pane, and regression tests.
   StudyHub does NOT call third-party APIs, proxy files, or guarantee third-party availability. */

export const EXTERNAL_PDF_GUIDE_TITLE = '想用外部工具转换？';
export const EXTERNAL_PDF_GUIDE_META = '手动转换 · 外链参考';

export const EXTERNAL_PDF_PRIVACY_NOTICE = '文件上传到第三方属于你与该服务之间的事，本产品不经手、不保存。';
export const EXTERNAL_PDF_SCOPE_NOTE = '以下仅为外部工具参考链接：不内置调用、不代传文件、不承诺第三方服务的可用性。请复制链接到浏览器自行打开。';

/** 4 well-known external PDF-to-Markdown/text conversion tools (plain copyable URLs, never MinerU defunct hosted service). */
export const EXTERNAL_PDF_TOOLS = Object.freeze([
  Object.freeze({
    id: 'paddleocr',
    name: 'PaddleOCR 在线解析',
    url: 'https://www.paddleocr.ai',
    role: '免安装网页版，支持扫描件、表格与公式，可导出 JSON 或 Markdown。',
  }),
  Object.freeze({
    id: 'marker',
    name: 'Marker（开源项目）',
    url: 'https://github.com/datalab-to/marker',
    role: '开源 PDF 转 Markdown 工具，支持 OCR 与公式（支持分页标记）。',
  }),
  Object.freeze({
    id: 'docling',
    name: 'Docling（开源项目）',
    url: 'https://github.com/docling-project/docling',
    role: '开源文档解析工具（MIT），可导出带页码的 JSON（DoclingDocument）或 Markdown。',
  }),
  Object.freeze({
    id: 'mathpix',
    name: 'Mathpix',
    url: 'https://mathpix.com',
    role: '面向理工科公式与论文，可将 PDF 转为带 LaTeX 公式的 Markdown（.md）或 .tex。',
  }),
]);

export const EXTERNAL_PDF_TOOL_URLS = Object.freeze(EXTERNAL_PDF_TOOLS.map(tool => tool.url));

export const EXTERNAL_PDF_IMPORT_TITLE = '转换完成后怎么导入';

/** Real formats verified against lib/contexts/materials/files.js and lib/office/limits.js. */
export const EXTERNAL_PDF_IMPORT_STEPS = Object.freeze([
  Object.freeze({
    id: 'formats',
    title: '1. 确认导出格式',
    body: '支持导入：Markdown（.md / .markdown，支持 <!-- page: N --> 或 Marker 分页标记）、纯文本（.txt）、LaTeX（.tex）、HTML（.html / .htm）、Word（.docx）、PowerPoint（.pptx / .ppt）、带文字层的 PDF（.pdf），以及转换工具导出的结构化 JSON（.json：PaddleOCR / Docling / MinerU）。单文件上限：.md / .txt / .tex / .html / .pdf 为 8 MB（PDF 最多 200 页，文本最多 60 万字符）；.docx / .pptx / .ppt 与转换结果 .json 为 40 MB。',
  }),
  Object.freeze({
    id: 'where',
    title: '2. 放到哪里、怎么导入',
    body: '打开「资料」页，点击「添加资料」（或在「创建题组」里点击「添加资料」），选好课程后在「文件」标签拖入转换好的文件或点击「选择文件」；纯文本也可切到「粘贴文本」直接保存。如在主对话中使用学习模式，也可放到工作区的 studyhub-work/ 或电脑本地目录后让 AI 导入。',
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

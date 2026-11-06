import { ui } from '../../i18n.js';

/* 「更多」 of the reader's toolbar. The toolbar keeps three actions (出题, 错题, 思维导图), the 目录 toggle and this menu; everything else the reader can do
   is an item here, so nothing was deleted when the toolbar was slimmed (owner decision 2026-11-06). Pure: the items are Menu's ({ id, label, icon, hint, tip, checked, run });
   the reader (DocumentViewer.jsx) says what is on offer and what each item does. Where each thing is now is written in the finder (ui/finder/entries.js). */

const NO_ORIGINAL_TIP = '这份资料只保存了提取出的文字，没有原文件，所以「原始 PDF」打不开。点一下可以补全原文件：指给它文件的位置（只记路径，不占空间），或复制一份进资料库。已保存的文字、引用和题目不会变。';
const PDF_TOOLS_TIP = '在原始 PDF 里按页提问；要问选中的一段，请切换到「阅读」。';

/**
 * The items. state: { view ('read' | 'text' | 'original'), format, fileUrl (the original PDF is there), localMode, find, translate (offered), display (offered),
 * tools ({ on, count } | null), quality ({ text } | null), assist, download, hostPreview, attach (a text-only document: 补全原文件 is an item of its own), extra (items the
 * dialog adds: rename, today's tasks, the question sets) }; handlers: { setView(value), find, translate, display, tools, quality, assist, download, hostPreview, attach }.
 */
export function moreItems(state, handlers) {
  const { view, format, fileUrl, localMode, tools, quality, extra = [] } = state, original = view === 'original';
  const views = [{ id: 'view:read', value: 'read', label: ui('阅读') }, { id: 'view:text', value: 'text', label: ui('原文') },
    ...(format === 'pdf' && !localMode ? [{ id: 'view:original', value: 'original', label: ui('原始 PDF'), ...(fileUrl ? {} : { hint: ui('没有原文件'), tip: ui(NO_ORIGINAL_TIP) }) }] : [])];
  const items = [{ heading: true, label: ui('显示方式') },
    ...views.map(({ value, ...item }) => ({ ...item, checked: view === value, run: () => handlers.setView(value) })),
    { heading: true, label: ui('工具') }];
  if (!original) items.push({ id: 'find', icon: 'search', label: ui('在文中查找'), hint: 'Ctrl/⌘ F', run: handlers.find });
  if (state.translate && !original) items.push({ id: 'translate', icon: 'nav-language', label: ui('翻译…'), attrs: { 'data-usage': 'reader.translate' }, run: handlers.translate });
  if (state.display && !original) items.push({ id: 'display', icon: 'type', label: ui('显示设置…'), attrs: { 'data-usage': 'reader.display' }, run: handlers.display });
  if (tools) items.push({ id: 'tools', icon: 'panel', label: ui('学习工具'), checked: !!tools.on, ...(tools.count > 0 ? { hint: String(tools.count) } : {}), ...(original ? { tip: ui(PDF_TOOLS_TIP) } : {}), run: handlers.tools });
  if (quality) items.push({ id: 'quality', icon: 'success', label: ui('掌握度与覆盖'), hint: quality.text, run: handlers.quality });
  if (state.assist) items.push({ id: 'assist', icon: 'sparkle', label: ui('AI 整理目录…'), run: handlers.assist });
  if (state.attach) items.push({ id: 'attach', icon: 'file', label: ui('补全原文件…'), hint: ui('没有原文件'), run: handlers.attach });
  if (state.download) items.push({ id: 'download', icon: 'download', label: ui('下载原文件'), run: handlers.download });
  if (state.hostPreview) items.push({ id: 'host-preview', icon: 'external', label: ui('使用宿主文件预览'), run: handlers.hostPreview });
  if (extra.length) items.push({ heading: true, label: ui('这份资料') }, ...extra);
  return items;
}

import { ui, uiFormat } from './i18n.js';
import { folderOfItem, readMaterialFolders } from '../lib/contexts/materials/material-folders.js';
import { flattenOptions } from './components/option-list.js';

const JSON_CARD_SOURCE = 'json-card-self-reference';
const AI_DRAFTED_SOURCE = 'ai-drafted-unverified';
const AI_DRAFTED_TITLE_RE = /AI\s*撰写\s*[·・-]\s*未核对/i;
const isJsonCardItem = item =>
  item?.provenance === JSON_CARD_SOURCE || (item?.provenance === undefined && /^JSON 导入：/.test(item?.title || ''));
const isAiDraftedItem = item =>
  item?.provenance === AI_DRAFTED_SOURCE || (item?.provenance === undefined && AI_DRAFTED_TITLE_RE.test(item?.title || ''));

/* Deterministic type & content-folder facets shared by SourcePicker (01 / 选择资料 & CaseCreate)
   and Sources (资料页). Functional document kinds and file-format buckets are computed in O(N)
   with zero model tokens; content categories read settings.materialFolders. */

export const ALL_FACET = '*';
export const UNFILED_FACET = '__unfiled__';

export const MATERIAL_KINDS = Object.freeze([
  { id: 'article', value: 'kind:article', labelKey: '知识文档' },
  { id: 'courseware', value: 'kind:courseware', labelKey: '课件讲义' },
  { id: 'question-bank', value: 'kind:question-bank', labelKey: '导入题库' },
  { id: 'book', value: 'kind:book', labelKey: '教材书目' },
  { id: 'note', value: 'kind:note', labelKey: '笔记总结' },
  { id: 'transcript', value: 'kind:transcript', labelKey: '录音逐字稿' },
  { id: 'exam', value: 'kind:exam', labelKey: '真题考纲' },
]);

export const MATERIAL_FORMATS = Object.freeze([
  { id: 'md', value: 'fmt:md', labelKey: '格式：Markdown' },
  { id: 'pdf', value: 'fmt:pdf', labelKey: '格式：PDF' },
  { id: 'office', value: 'fmt:office', labelKey: '格式：Word / PPT' },
  { id: 'json', value: 'fmt:json', labelKey: '格式：JSON' },
  { id: 'text', value: 'fmt:text', labelKey: '格式：纯文本' },
  { id: 'audio', value: 'fmt:audio', labelKey: '格式：音频' },
]);

const EXAM_RE = /真题|试卷|样卷|考纲|大纲|past\s*paper|mock|syllabus/i;
const COURSEWARE_RE = /课件|讲义|幻灯片|实验课|交互课件|slides?|lecture/i;
const NOTE_PREFIX_RE = /^(补充笔记|课堂笔记)/;
const NOTE_RE = /^(补充笔记|课堂笔记)|笔记|总结/i;
const SHORT_NOTE_CHARS = 1200;

/** Collect source-level `live` and `companionId` flags once per sources array without cloning grouped items. */
export function buildSourceFlags(sources) {
  const liveSourceIds = new Set();
  const companionSourceIds = new Set();
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (!source || typeof source !== 'object' || !source.id) continue;
      if (source.live === true) liveSourceIds.add(source.id);
      if (source.companionId) companionSourceIds.add(source.id);
    }
  }
  return { liveSourceIds, companionSourceIds };
}

const hasAnySourceId = (item, set) =>
  Boolean(set?.size && Array.isArray(item?.sourceIds) && item.sourceIds.some(id => set.has(id)));

/** Deterministic functional kind of a grouped material item (`groupSourcesByDocument`). */
export function materialKindOf(item, flags = null) {
  if (!item || typeof item !== 'object') return 'article';
  const format = String(item.format || 'text').toLowerCase();
  if (format === 'audio') return 'transcript';
  if (format === 'json' || isJsonCardItem(item)) return 'question-bank';

  const title = String(item.title || '').trim();
  const haystack = [title, item.filename, item.renamedFrom].filter(Boolean).join(' ');
  if (EXAM_RE.test(haystack)) return 'exam';

  const pageCount = Number(item.totalPages) || (Array.isArray(item.pages) ? item.pages.length : Number(item.pages) || 0);
  if (Boolean(item.converted) || (format === 'pdf' && pageCount >= 50)) return 'book';

  const isCompanion = Boolean(item.companion || item.companionId) || hasAnySourceId(item, flags?.companionSourceIds);
  if (format === 'pptx' || format === 'ppt' || isCompanion || COURSEWARE_RE.test(haystack)) return 'courseware';

  const isLive = Boolean(item.live) || hasAnySourceId(item, flags?.liveSourceIds);
  const chars = Number(item.chars) || 0;
  const shortOrPlain = format === 'text' || format === 'txt' || (chars > 0 && chars <= SHORT_NOTE_CHARS);
  if (
    isLive ||
    isAiDraftedItem(item) ||
    NOTE_PREFIX_RE.test(title) ||
    (shortOrPlain && NOTE_RE.test(haystack))
  ) {
    return 'note';
  }

  return 'article';
}

/** Deterministic file-format bucket (`md | pdf | office | json | text | audio`). */
export function materialFormatBucket(item) {
  const format = String(item?.format || 'text').toLowerCase();
  if (format === 'md') return 'md';
  if (format === 'pdf') return 'pdf';
  if (format === 'docx' || format === 'pptx' || format === 'ppt') return 'office';
  if (format === 'json') return 'json';
  if (format === 'audio') return 'audio';
  return 'text';
}

/** Build options for the `类型` `<Select>` over `scoped` items (only non-zero buckets; format group shown when >= 2 formats exist). */
export function buildMaterialTypeOptions(items = [], flags = null) {
  const kindCounts = new Map();
  const formatCounts = new Map();
  for (const item of items) {
    const kind = materialKindOf(item, flags);
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    const fmt = materialFormatBucket(item);
    formatCounts.set(fmt, (formatCounts.get(fmt) || 0) + 1);
  }

  const options = [{ value: ALL_FACET, label: ui('全部类型') }];
  for (const entry of MATERIAL_KINDS) {
    const count = kindCounts.get(entry.id) || 0;
    if (count > 0) options.push({ value: entry.value, label: `${ui(entry.labelKey)} (${count})` });
  }

  const presentFormats = MATERIAL_FORMATS
    .map(entry => ({ entry, count: formatCounts.get(entry.id) || 0 }))
    .filter(row => row.count > 0);
  if (presentFormats.length >= 2) {
    options.push({
      group: ui('按文件格式'),
      options: presentFormats.map(({ entry, count }) => ({
        value: entry.value,
        label: `${ui(entry.labelKey)} (${count})`,
      })),
    });
  }
  return options;
}

/** Read `{ folders, items }` from explicit `materialFolders` prop or fallback `appData`. */
export function resolveMaterialFolders(materialFolders, appData) {
  if (materialFolders && typeof materialFolders === 'object' && !Array.isArray(materialFolders)) {
    return readMaterialFolders({ materialFolders });
  }
  if (appData?.materialFolders) {
    return readMaterialFolders({ materialFolders: appData.materialFolders });
  }
  return readMaterialFolders(appData?.settings);
}

/** Folder name assigned to `item`, or `''` if unfiled. */
export function itemFolderName(item, materialFolders) {
  return folderOfItem(materialFolders, item?.key);
}

/** Count how many items in `items` have no folder assigned. */
export function countUnfiledMaterials(items = [], materialFolders) {
  const normalized = readMaterialFolders({ materialFolders });
  let unfiled = 0;
  for (const item of items) {
    if (!folderOfItem(normalized, item?.key)) unfiled += 1;
  }
  return unfiled;
}

/** Build options for the `内容分类` `<Select>` over `scoped` items. */
export function buildMaterialCategoryOptions(items = [], materialFolders) {
  const normalized = readMaterialFolders({ materialFolders });
  const counts = new Map();
  let unfiled = 0;
  for (const item of items) {
    const folder = folderOfItem(normalized, item?.key);
    if (folder) counts.set(folder, (counts.get(folder) || 0) + 1);
    else unfiled += 1;
  }

  const orderedFolders = [];
  const seen = new Set();
  for (const folder of normalized.folders) {
    if (counts.has(folder) && !seen.has(folder)) {
      seen.add(folder);
      orderedFolders.push(folder);
    }
  }
  for (const folder of counts.keys()) {
    if (!seen.has(folder)) {
      seen.add(folder);
      orderedFolders.push(folder);
    }
  }

  const options = [{ value: ALL_FACET, label: ui('全部分类') }];
  for (const folder of orderedFolders) {
    options.push({ value: folder, label: `${folder} (${counts.get(folder)})` });
  }
  if (unfiled > 0 && items.length > 0) {
    options.push({ value: UNFILED_FACET, label: uiFormat('未归类 ({0})', [unfiled]) });
  }
  return options;
}

/** The names of the facets in use, without their counts (「PDF (3)」 → 「PDF」), for the line that says a filter is in use. `chosen`: [options, value] a facet. */
export function facetNames(chosen) {
  return chosen.filter(([, value]) => value && value !== ALL_FACET)
    .map(([options, value]) => String(flattenOptions(options).find(option => option.value === value)?.label ?? '').replace(/\s*\(\d+\)$/, '')).filter(Boolean);
}

/** True when `value` is `'*'` or exists in `options` (including inside option groups). */
export function hasFacetOption(options = [], value = ALL_FACET) {
  if (!value || value === ALL_FACET) return true;
  return flattenOptions(options).some(option => option.value === value);
}

export function matchesMaterialType(item, typeScope = ALL_FACET, flags = null) {
  if (!typeScope || typeScope === ALL_FACET) return true;
  if (typeScope.startsWith('kind:')) return materialKindOf(item, flags) === typeScope.slice(5);
  if (typeScope.startsWith('fmt:')) return materialFormatBucket(item) === typeScope.slice(4);
  return true;
}

export function matchesMaterialCategory(item, categoryScope = ALL_FACET, materialFolders = null) {
  if (!categoryScope || categoryScope === ALL_FACET) return true;
  const folder = folderOfItem(materialFolders, item?.key);
  if (categoryScope === UNFILED_FACET) return !folder;
  return folder === categoryScope;
}

/** Filter `items` by both `typeScope` and `categoryScope`. */
export function filterMaterialsByFacets(
  items = [],
  { typeScope = ALL_FACET, categoryScope = ALL_FACET, materialFolders = null, sourceFlags = null } = {},
) {
  if ((!typeScope || typeScope === ALL_FACET) && (!categoryScope || categoryScope === ALL_FACET)) {
    return items;
  }
  const normalizedFolders = materialFolders ? readMaterialFolders({ materialFolders }) : null;
  return items.filter(
    item =>
      matchesMaterialType(item, typeScope, sourceFlags) &&
      matchesMaterialCategory(item, categoryScope, normalizedFolders),
  );
}

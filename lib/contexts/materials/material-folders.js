/* Lightweight material folders on the 资料 page (#1071): one optional `materialFolders` field in library settings,
   keyed by each document's stable `sourceItemKey` (lib/source-groups.js: pdf:<hash>, doc:<materialId>, audio:<batch>,
   source:<id>), just like `materialPins` (lib/material-pins.js). No library schema version moves, and renaming,
   re-importing the same document, or archiving/restoring never loses folder membership. */
import { courseScope } from '../../course-tree.js';
import { groupSourcesByDocument } from '../../source-groups.js';

export const FOLDERS_FIELD = 'materialFolders';
export const MAX_FOLDERS = 200;
export const MAX_FOLDER_NAME_CHARS = 80;
export const UNFILED_FOLDER = '';
export const UNASSIGNED_COURSE = '';

/** Trim and collapse internal whitespace of a folder name; non-strings become ''. */
export function normalizeFolderName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** Read `{ folders, items }` defensively from a library settings object. */
export function readMaterialFolders(settings) {
  const raw = settings?.[FOLDERS_FIELD];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { folders: [], items: {} };
  const folders = [];
  const seen = new Set();
  if (Array.isArray(raw.folders)) {
    for (const entry of raw.folders) {
      const name = normalizeFolderName(entry);
      if (!name || name.length > MAX_FOLDER_NAME_CHARS || seen.has(name) || folders.length >= MAX_FOLDERS) continue;
      seen.add(name);
      folders.push(name);
    }
  }
  const items = {};
  if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
    for (const [key, value] of Object.entries(raw.items)) {
      if (typeof key !== 'string' || !key.trim()) continue;
      const folder = normalizeFolderName(value);
      if (!folder || folder.length > MAX_FOLDER_NAME_CHARS) continue;
      if (!seen.has(folder)) {
        if (folders.length >= MAX_FOLDERS) continue;
        seen.add(folder);
        folders.push(folder);
      }
      items[key] = folder;
    }
  }
  return { folders, items };
}

export const materialFoldersView = settings => readMaterialFolders(settings);

export const folderOfItem = (materialFolders, key) => {
  if (!key || !materialFolders?.items) return UNFILED_FOLDER;
  const value = materialFolders.items[key];
  return typeof value === 'string' ? value : UNFILED_FOLDER;
};

const titleCompare = (a, b, locale = 'zh-CN') =>
  String(a?.title ?? '').localeCompare(String(b?.title ?? ''), locale, { numeric: true });

/** Sort documents within a group: `'recent'` (newest createdAt first) or `'title'` (natural locale order). */
export function sortMaterials(items, { sort = 'recent', locale = 'zh-CN' } = {}) {
  const list = [...items];
  if (sort === 'title') {
    return list.sort((a, b) => titleCompare(a, b, locale) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  return list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || titleCompare(a, b, locale));
}

const finalizeGroup = (key, rows, options) => ({
  key,
  rows: sortMaterials(rows, options),
  inferred: rows.length > 0 && rows.every(r => r.createdAtInferred),
  chars: rows.reduce((n, r) => n + (Number(r.chars) || 0), 0),
});

/** Group materials by primary course (`courses[0]`, or matching active course scope). Multi-course items appear once; unassigned items go last under `''`. */
export function groupMaterialsByCourse(items, { locale = 'zh-CN', sort = 'recent', scope = '*', known = [] } = {}) {
  const within = typeof scope === 'string' && scope !== '*' && scope !== '' ? courseScope(scope, known) : null;
  const buckets = new Map();
  for (const item of items) {
    const courses = Array.isArray(item.courses) ? item.courses : [];
    const matched = within ? courses.find(within) : null;
    const primary = matched || (courses[0] ? String(courses[0]) : UNASSIGNED_COURSE);
    if (!buckets.has(primary)) buckets.set(primary, []);
    buckets.get(primary).push(item);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === UNASSIGNED_COURSE) return 1;
      if (b === UNASSIGNED_COURSE) return -1;
      return a.localeCompare(b, locale, { numeric: true });
    })
    .map(([key, rows]) => finalizeGroup(key, rows, { sort, locale }));
}

/** Group materials by lightweight folder. Empty folders appear when `includeEmpty` is true; unfiled items go last under `''`. */
export function groupMaterialsByFolder(items, materialFolders, { locale = 'zh-CN', sort = 'recent', includeEmpty = false } = {}) {
  const { folders, items: assigned } = readMaterialFolders({ materialFolders });
  const buckets = new Map();
  if (includeEmpty) {
    for (const folder of folders) buckets.set(folder, []);
  }
  for (const item of items) {
    const folder = assigned[item.key] || UNFILED_FOLDER;
    if (!buckets.has(folder)) buckets.set(folder, []);
    buckets.get(folder).push(item);
  }
  const order = new Map(folders.map((name, idx) => [name, idx]));
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === UNFILED_FOLDER) return 1;
      if (b === UNFILED_FOLDER) return -1;
      const ai = order.get(a), bi = order.get(b);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.localeCompare(b, locale, { numeric: true });
    })
    .map(([key, rows]) => finalizeGroup(key, rows, { sort, locale }));
}

/** Flat single-group view (`mode === 'none'`). */
export function groupMaterialsFlat(items, { locale = 'zh-CN', sort = 'recent' } = {}) {
  if (!items.length) return [];
  return [finalizeGroup('all', items, { sort, locale })];
}

/* ---------- State mutations ---------- */

const liveKeys = state => new Set(groupSourcesByDocument(state.sources || [], { documents: state.documents || [] }).map(item => item.key));

function assertValidFolderName(raw) {
  if (typeof raw !== 'string') throw new Error('Folder name is required / 请输入文件夹名称');
  const name = normalizeFolderName(raw);
  if (!name) throw new Error('Folder name is required / 请输入文件夹名称');
  if (name.length > MAX_FOLDER_NAME_CHARS) throw new Error(`Folder name must be at most ${MAX_FOLDER_NAME_CHARS} characters / 文件夹名称最多 ${MAX_FOLDER_NAME_CHARS} 个字符`);
  return name;
}

function pruneItems(items, folders, live) {
  const folderSet = new Set(folders);
  const pruned = {};
  for (const [key, folder] of Object.entries(items)) {
    if (live.has(key) && folderSet.has(folder)) pruned[key] = folder;
  }
  return pruned;
}

function writeFolders(state, folders, items, live) {
  const pruned = pruneItems(items, folders, live);
  state.settings ||= {};
  state.settings[FOLDERS_FIELD] = { folders: [...folders], items: pruned };
  return { folders: [...folders], items: { ...pruned } };
}

/** source.folder.create { name }: create a lightweight folder in settings.materialFolders. */
export function createMaterialFolder(state, args) {
  const name = assertValidFolderName(args?.name ?? args?.folder);
  const live = liveKeys(state);
  const { folders, items } = readMaterialFolders(state.settings);
  if (folders.includes(name)) throw new Error('Folder already exists / 文件夹已存在');
  if (folders.length >= MAX_FOLDERS) throw new Error(`At most ${MAX_FOLDERS} folders are allowed / 最多只能创建 ${MAX_FOLDERS} 个文件夹`);
  const written = writeFolders(state, [...folders, name], items, live);
  return { folder: name, ...written };
}

/** source.folder.set { key? | keys?, folder }: assign 1–5000 materials to a folder (or null/'' to unfile). */
export function setMaterialFolder(state, args) {
  const rawKeys = Array.isArray(args?.keys) ? args.keys : args?.key !== undefined ? [args.key] : [];
  const keys = [...new Set(rawKeys.filter(k => typeof k === 'string' && k.trim()))];
  if (!keys.length || keys.length > 5000 || keys.length !== rawKeys.length) {
    throw new Error('Select 1–5000 valid material keys / 请选择 1–5000 份有效资料');
  }
  const live = liveKeys(state);
  for (const key of keys) if (!live.has(key)) throw new Error('Material not found / 找不到这份资料');

  let folder = '';
  if (args?.folder !== null && args?.folder !== undefined) {
    if (typeof args.folder !== 'string') throw new Error('Folder must be a string or null / 文件夹名称格式不正确');
    folder = normalizeFolderName(args.folder);
    if (folder.length > MAX_FOLDER_NAME_CHARS) throw new Error(`Folder name must be at most ${MAX_FOLDER_NAME_CHARS} characters / 文件夹名称最多 ${MAX_FOLDER_NAME_CHARS} 个字符`);
  }

  const { folders, items } = readMaterialFolders(state.settings);
  const nextFolders = [...folders];
  if (folder && !nextFolders.includes(folder)) {
    if (nextFolders.length >= MAX_FOLDERS) throw new Error(`At most ${MAX_FOLDERS} folders are allowed / 最多只能创建 ${MAX_FOLDERS} 个文件夹`);
    nextFolders.push(folder);
  }
  const nextItems = { ...items };
  for (const key of keys) {
    if (folder) nextItems[key] = folder;
    else delete nextItems[key];
  }
  const written = writeFolders(state, nextFolders, nextItems, live);
  return { updated: keys.length, folder: folder || null, ...written };
}

/** source.folder.rename { from, to }: rename an existing folder and update all assigned materials. */
export function renameMaterialFolder(state, args) {
  const from = assertValidFolderName(args?.from ?? args?.name);
  const to = assertValidFolderName(args?.to ?? args?.nextName);
  const live = liveKeys(state);
  const { folders, items } = readMaterialFolders(state.settings);
  const at = folders.indexOf(from);
  if (at < 0) throw new Error('Folder not found / 找不到这个文件夹');
  if (from === to) {
    const written = writeFolders(state, folders, items, live);
    return { from, to, ...written };
  }
  if (folders.includes(to)) throw new Error('Folder already exists / 同名文件夹已存在');
  const nextFolders = folders.map((name, i) => (i === at ? to : name));
  const nextItems = Object.fromEntries(Object.entries(items).map(([key, folder]) => [key, folder === from ? to : folder]));
  const written = writeFolders(state, nextFolders, nextItems, live);
  return { from, to, ...written };
}

/** Deterministic file-format bucket for filtering and compact classification descriptors. */
export function materialFormatGroup(item) {
  const fmt = String(item?.format || 'text').toLowerCase();
  if (fmt === 'md' || fmt === 'markdown') return 'md';
  if (fmt === 'pdf') return 'pdf';
  if (fmt === 'docx' || fmt === 'pptx' || fmt === 'ppt') return 'office';
  if (fmt === 'json') return 'json';
  if (fmt === 'audio') return 'audio';
  return 'text';
}

const QUESTION_BANK_TITLE = /^JSON\s*导入[:：]/i;
const EXAM_SIGNAL = /真题|试卷|样卷|考纲|大纲|past\s*paper|mock\s*exam|syllabus/i;
const COURSEWARE_SIGNAL = /课件|讲义|幻灯片|实验课|交互课件|slides?|lecture/i;
const NOTE_PREFIX = /^(补充笔记|课堂笔记)/i;
const NOTE_SIGNAL = /笔记|总结/i;

/** Deterministic functional kind of a grouped material item (zero model calls). */
export function materialKindOf(item) {
  if (!item || typeof item !== 'object') return 'article';
  const fmt = String(item.format || 'text').toLowerCase();
  const title = String(item.title || '');
  const filename = String(item.filename || '');
  const pathHint = String(item.pathHint || '');
  if (fmt === 'json' || item.provenance === 'json-card-self-reference' || QUESTION_BANK_TITLE.test(title)) return 'question-bank';
  if (fmt === 'audio') return 'transcript';
  const pages = Number(item.totalPages) || (Array.isArray(item.pages) ? item.pages.length : 0);
  if (item.converted || (fmt === 'pdf' && pages >= 50)) return 'book';
  if (EXAM_SIGNAL.test(`${title} ${filename}`)) return 'exam';
  if (fmt === 'pptx' || fmt === 'ppt' || item.companion || COURSEWARE_SIGNAL.test(`${title} ${filename} ${pathHint}`)) return 'courseware';
  if (item.live || item.provenance === 'ai-drafted-unverified' || NOTE_PREFIX.test(title) || (fmt === 'text' && NOTE_SIGNAL.test(title))) return 'note';
  return 'article';
}

/** source.folder.delete { folder, unfile? }: delete an empty folder, or unfile its materials first when unfile:true. */
export function deleteMaterialFolder(state, args) {
  const folder = assertValidFolderName(args?.folder ?? args?.name);
  const live = liveKeys(state);
  const { folders, items } = readMaterialFolders(state.settings);
  if (!folders.includes(folder)) throw new Error('Folder not found / 找不到这个文件夹');
  const pruned = pruneItems(items, folders, live);
  const assignedKeys = Object.entries(pruned).filter(([, assigned]) => assigned === folder).map(([key]) => key);
  if (assignedKeys.length > 0 && args?.unfile !== true) {
    throw new Error('Folder is not empty / 文件夹内还有资料，请先移出资料或选择一并移出');
  }
  const nextItems = { ...pruned };
  for (const key of assignedKeys) delete nextItems[key];
  const nextFolders = folders.filter(name => name !== folder);
  const written = writeFolders(state, nextFolders, nextItems, live);
  return { deleted: folder, unfiled: assignedKeys.length, ...written };
}

/** source.folder.apply { assignments: [{ key, folder: string | null }] }: atomically create missing folders and assign/unfile 1–5000 materials. */
export function applyMaterialFolderAssignments(state, args) {
  const rawList = args?.assignments;
  if (!Array.isArray(rawList) || rawList.length < 1 || rawList.length > 5000) {
    throw new Error('请提供 1–5000 条有效的资料分类记录');
  }
  const live = liveKeys(state);
  const seenKeys = new Set();
  const normalized = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || !entry.key.trim()) {
      throw new Error('分类记录包含重复或无效的资料键');
    }
    const key = entry.key.trim();
    if (seenKeys.has(key)) {
      throw new Error('分类记录包含重复或无效的资料键');
    }
    seenKeys.add(key);
    if (!live.has(key)) {
      throw new Error('找不到这份资料，请刷新后重试');
    }
    let folder = '';
    if (entry.folder !== null && entry.folder !== undefined) {
      if (typeof entry.folder !== 'string') throw new Error('文件夹名称格式不正确');
      folder = normalizeFolderName(entry.folder);
      if (folder.length > MAX_FOLDER_NAME_CHARS) throw new Error('文件夹名称最多 80 个字符');
    }
    normalized.push({ key, folder });
  }

  const { folders, items } = readMaterialFolders(state.settings);
  const nextFolders = [...folders];
  const folderSet = new Set(nextFolders);
  const createdFolders = [];
  for (const { folder } of normalized) {
    if (folder && !folderSet.has(folder)) {
      if (nextFolders.length >= MAX_FOLDERS) throw new Error('最多只能创建 200 个文件夹');
      folderSet.add(folder);
      nextFolders.push(folder);
      createdFolders.push(folder);
    }
  }

  const nextItems = { ...items };
  for (const { key, folder } of normalized) {
    if (folder) nextItems[key] = folder;
    else delete nextItems[key];
  }
  const written = writeFolders(state, nextFolders, nextItems, live);
  const byCourse = state.settings?.materialClassifyPendingByCourse;
  if (byCourse && typeof byCourse === 'object') {
    for (const [slot, entry] of Object.entries(byCourse)) {
      const suggestions = Array.isArray(entry?.suggestions) ? entry.suggestions : [];
      if (!suggestions.length || suggestions.some(item => seenKeys.has(item?.key))) {
        delete byCourse[slot];
      }
    }
    const remaining = Object.values(byCourse).filter(entry => entry && typeof entry === 'object');
    if (!remaining.length) {
      delete state.settings.materialClassifyPendingByCourse;
      delete state.settings.materialClassifyPending;
    } else {
      remaining.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      state.settings.materialClassifyPending = remaining[0];
    }
  } else if (state.settings?.materialClassifyPending !== undefined) {
    delete state.settings.materialClassifyPending;
  }
  return {
    updated: normalized.length,
    createdFolders,
    ...written,
  };
}

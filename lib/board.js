import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { id as newId, parseStoredJson } from "./util.js";
import { basename, isAbsolute, join, win32 } from "node:path";
import { withStoreLock } from "./store-lock.js";
import { isMeaningfulTitle, normalizeChecklist } from "./board-model.js";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !forbidden.has(id);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
// Titles are checked when a card is added or edited, never when a stored board is read,
// so cards saved before the rule (for example "?") stay readable and editable.
const taskTitle = (value) => {
  const title = text(value, "title", 500, true);
  requireValue(isMeaningfulTitle(title), "title must contain at least one letter or digit");
  return title;
};
const checklist = (value) => normalizeChecklist(value, newId, validId);
const emptyBoard = () => ({
  version: 1, revision: 0,
  columns: [
    { id: "todo", title: "待办", done: false, cardIds: [] },
    { id: "doing", title: "进行中", done: false, cardIds: [] },
    { id: "done", title: "已完成", done: true, cardIds: [] },
  ],
  cards: {}, archived: [],
});
const boardPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "study", "board.json");

function safeKeys(value) {
  if (!value || typeof value !== "object") return;
  requireValue(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Invalid board object");
  for (const key of Object.keys(value)) {
    requireValue(!forbidden.has(key), "Unsafe board property");
    safeKeys(value[key]);
  }
}
function text(value, field, limit, required = false) {
  requireValue(typeof value === "string" && value.length <= limit && (!required || value.trim().length > 0), `${field} must be ${required ? "nonempty " : ""}text of at most ${limit} characters`);
  return required ? value.trim() : value;
}
function dueDate(value) {
  if (value === "" || value === null) return "";
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "due must be a valid YYYY-MM-DD date or empty");
  const date = new Date(value);
  requireValue(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, "due must be a valid YYYY-MM-DD date");
  return value;
}
function labels(value) {
  requireValue(Array.isArray(value) && value.length <= 20, "labels must be an array of at most 20 labels");
  return [...new Set(value.map((label) => text(label, "label", 60, true)))];
}
function studyReference(value) {
  requireValue(object(value), "Invalid study reference");
  const root = text(value.root, "study root", 32768, true);
  requireValue(isAbsolute(root) || win32.isAbsolute(root), "Study root must be an absolute path");
  const kind = value.kind;
  requireValue(["card", "source", "note", "skeleton", "deck", "exam", "oral", "course", "workflow"].includes(kind), "Invalid study reference kind");
  const fields = kind === "card" ? ["deckId", "cardId"] : kind === "course" ? ["course"]
    : kind === "workflow" ? ["sessionId"] : [kind === "exam" || kind === "oral" ? "runId" : "id"];
  const result = { root, kind };
  for (const field of fields) result[field] = text(value[field], field, field === "course" ? 200 : 200, kind !== "course");
  requireValue(Object.keys(value).every(key => Object.hasOwn(result, key)), "Unexpected study reference field");
  return result;
}
function validateCard(card) {
  requireValue(object(card) && validId(card.id), "Invalid card id");
  text(card.title, "title", 500, true);
  text(card.note, "note", 50000);
  dueDate(card.due);
  labels(card.labels);
  if (card.checklist !== undefined) requireValue(JSON.stringify(checklist(card.checklist)) === JSON.stringify(card.checklist), "Invalid checklist");
  requireValue(typeof card.createdAt === "string" && Number.isFinite(Date.parse(card.createdAt)) && typeof card.updatedAt === "string" && Number.isFinite(Date.parse(card.updatedAt)), "Invalid card timestamps");
  requireValue(object(card.origin) && typeof card.origin.workspace === "string" && typeof card.origin.workspaceTitle === "string", "Invalid card origin");
  if (card.studyRef !== undefined) studyReference(card.studyRef);
  if (card.learningTask !== undefined) {
    const task = card.learningTask;
    requireValue(card.studyRef && object(task) && task.version === 1 && ['practice', 'reading', 'workflow'].includes(task.kind), 'Invalid learning task');
    requireValue(Number.isInteger(task.minutes) && task.minutes > 0 && task.minutes <= 240, 'Invalid learning task minutes');
    text(task.reason, 'learning task reason', 500);
    dueDate(task.createdDate);
    requireValue(Array.isArray(task.scope) && task.scope.length <= 50 && (task.kind !== 'practice' || task.scope.length > 0), 'Invalid learning task scope');
    for (const ref of task.scope) { requireValue(object(ref), 'Invalid learning task reference'); text(ref.deckId, 'deckId', 200, true); text(ref.cardId, 'cardId', 200, true); }
    if (task.actualMinutes !== undefined) requireValue(Number.isInteger(task.actualMinutes) && task.actualMinutes >= 0 && task.actualMinutes <= 240, 'Invalid actual learning minutes');
    if (task.completedDate !== undefined) dueDate(task.completedDate);
    if (task.initialDone !== undefined) requireValue(Number.isInteger(task.initialDone) && task.initialDone>=0 && task.initialDone<=(task.stepCount || task.scope.length || 1),'Invalid initial learning progress');
  }
}
function validateBoard(board) {
  safeKeys(board);
  requireValue(object(board) && board.version === 1, "Unsupported board version");
  requireValue(Number.isSafeInteger(board.revision) && board.revision >= 0, "Invalid board revision");
  requireValue(Array.isArray(board.columns) && board.columns.length > 0 && object(board.cards) && Array.isArray(board.archived), "Invalid board structure");
  const columnIds = new Set(), assigned = new Set();
  for (const column of board.columns) {
    requireValue(object(column) && validId(column.id) && !columnIds.has(column.id) && typeof column.done === "boolean" && Array.isArray(column.cardIds), "Invalid board column");
    text(column.title, "column title", 100, true);
    columnIds.add(column.id);
    for (const id of column.cardIds) {
      requireValue(validId(id) && Object.hasOwn(board.cards, id) && !assigned.has(id), "Invalid or duplicate card placement");
      assigned.add(id);
    }
  }
  for (const [id, card] of Object.entries(board.cards)) {
    validateCard(card);
    requireValue(id === card.id && assigned.has(id), "Unplaced or mismatched card");
  }
  for (const card of board.archived) {
    validateCard(card);
    requireValue(!assigned.has(card.id), "Duplicate archived card");
    assigned.add(card.id);
  }
  if (board.dailyPlanner !== undefined) {
    const planner = board.dailyPlanner;
    requireValue(object(planner) && planner.version === 1 && object(planner.profile) && object(planner.plans), 'Invalid daily learning planner');
    for (const field of ['weekdayMinutes', 'weekendMinutes']) requireValue(Number.isInteger(planner.profile[field]) && planner.profile[field] >= 0 && planner.profile[field] <= 240, 'Invalid daily learning profile');
    for (const [key, plan] of Object.entries(planner.plans)) {
      requireValue(/^[a-f0-9]{32}_\d{4}-\d{2}-\d{2}$/.test(key) && object(plan), 'Invalid daily learning plan');
      dueDate(plan.date);
      requireValue(Number.isInteger(plan.budgetMinutes) && plan.budgetMinutes >= 0 && plan.budgetMinutes <= 240, 'Invalid daily learning budget');
      if (plan.feedbackHistory !== undefined) requireValue(Array.isArray(plan.feedbackHistory) && plan.feedbackHistory.length <= 5 && plan.feedbackHistory.every(value => typeof value === 'string' && value.length <= 2000), 'Invalid daily planning preferences');
      if (plan.taskIds !== undefined) requireValue(Array.isArray(plan.taskIds) && plan.taskIds.every(validId) && new Set(plan.taskIds).size === plan.taskIds.length, 'Invalid daily task IDs');
      if (plan.allocations !== undefined) {
        requireValue(object(plan.allocations), 'Invalid daily task allocation');
        for (const [id, allocation] of Object.entries(plan.allocations)) requireValue(validId(id) && Number.isInteger(allocation) && allocation > 0 && allocation <= 240, 'Invalid daily task allocation');
      }
      if (plan.effort !== undefined) {
        requireValue(object(plan.effort), 'Invalid daily effort ledger');
        for (const [taskId, record] of Object.entries(plan.effort)) {
          requireValue(validId(taskId) && object(record) && object(record.task) && record.task.id===taskId && object(record.task.learningTask), 'Invalid daily effort task');
          const task=record.task.learningTask;
          text(record.task.title,'effort task title',500,true); studyReference(record.task.studyRef);
          requireValue(task.version===1 && ['practice','reading','workflow'].includes(task.kind) && Number.isInteger(task.minutes) && task.minutes>0 && task.minutes<=240 && Array.isArray(task.scope), 'Invalid daily effort snapshot');
          requireValue(Number.isInteger(record.total) && record.total>0 && Number.isInteger(record.baselineDone) && record.baselineDone>=0 && record.baselineDone<=record.total && Number.isInteger(record.observedDone) && record.observedDone>=record.baselineDone && record.observedDone<=record.total && typeof record.completed==='boolean', 'Invalid daily effort progress');
          if (record.actualMinutes!==undefined) requireValue(Number.isInteger(record.actualMinutes) && record.actualMinutes>=0 && record.actualMinutes<=240,'Invalid daily effort minutes');
          if (record.unitMinutes!==undefined) requireValue(Number.isFinite(record.unitMinutes) && record.unitMinutes>0 && record.unitMinutes<=240,'Invalid daily effort unit');
          if (record.closed!==undefined) requireValue(typeof record.closed==='boolean','Invalid daily effort period');
        }
      }
      if (plan.proposal) {
        requireValue(object(plan.proposal) && validId(plan.proposal.id) && ['ai','local'].includes(plan.proposal.method) && Array.isArray(plan.proposal.items) && plan.proposal.items.length <= 6, 'Invalid daily proposal');
        for (const item of plan.proposal.items) {
          requireValue(object(item) && typeof item.candidateId === 'string' && ['practice','reading','workflow'].includes(item.kind) && Number.isInteger(item.minutes) && item.minutes > 0 && item.minutes <= 240, 'Invalid daily proposal item');
          taskTitle(item.title); text(item.reason, 'proposal reason', 500); studyReference(item.studyRef);
          requireValue(Array.isArray(item.scope) && (item.kind !== 'practice' || item.scope.length > 0) && typeof item.contentDigest === 'string' && /^[a-f0-9]{32}$/.test(item.contentDigest), 'Invalid daily proposal evidence');
        }
      }
    }
  }
}
async function readBoard(target) {
  try {
    const board = parseStoredJson(await readFile(target, "utf8"));
    validateBoard(board);
    return board;
  } catch (error) {
    if (error.code === "ENOENT") return emptyBoard();
    return { ...emptyBoard(), readOnly: true, error: `Cannot read board: ${error.message}. Restore or repair ${target} before editing; the original file has been preserved.` };
  }
}

const actions = new Set(["board.card.add", "board.card.edit", "board.card.move", "board.card.archive", "board.card.remove", "board.card.restore", "board.card.undelete", "board.column.add", "board.column.rename", "board.column.remove"]);

/** One global board, with a locked revision check covering the entire write. */
export async function boardAction(action, args = {}, cwd = "") {
  requireValue(action === "board.get" || actions.has(action), `Unknown board action: ${action}`);
  requireValue(object(args), "Board arguments must be an object");
  safeKeys(args);
  const target = boardPath();
  if (action === "board.get") {
    const board = await readBoard(target);
    return !board.readOnly && args.since === board.revision ? { unchanged: true, revision: board.revision } : board;
  }
  requireValue(Number.isSafeInteger(args.revision) && args.revision >= 0, "A nonnegative integer revision is required. Call board.get and retry with its revision.");
  return boardTransaction(board => {
    requireValue(board.revision === args.revision, `Board revision conflict: expected ${args.revision}, current ${board.revision}. Call board.get, review the latest board, and retry with its revision.`);
    const column = (id) => {
      requireValue(validId(id), "A valid column id is required");
      const found = board.columns.find((entry) => entry.id === id);
      requireValue(found, "Column not found; refresh the board");
      return found;
    };
    const card = () => {
      requireValue(validId(args.id) && Object.hasOwn(board.cards, args.id), "Card not found; refresh the board");
      return board.cards[args.id];
    };
    const detach = (id) => {
      const source = board.columns.find((entry) => entry.cardIds.includes(id));
      source.cardIds.splice(source.cardIds.indexOf(id), 1);
    };
    const now = new Date().toISOString();
    switch (action) {
      case "board.card.add": {
        const destination = column(args.column ?? board.columns[0].id), id = newId();
        const workspace = text(cwd, "workspace", 32768);
        board.cards[id] = { id, title: taskTitle(args.title), note: text(args.note ?? "", "note", 50000), due: dueDate(args.due ?? ""), labels: labels(args.labels ?? []), createdAt: now, updatedAt: now, origin: { workspace, workspaceTitle: workspace.includes("\\") ? win32.basename(workspace) : basename(workspace) },
          ...(args.checklist === undefined ? {} : { checklist: checklist(args.checklist) }),
          ...(args.studyRef === undefined ? {} : { studyRef: studyReference(args.studyRef) }) };
        destination.cardIds.push(id);
        break;
      }
      case "board.card.edit": {
        const entry = card();
        if (Object.hasOwn(args, "title")) entry.title = taskTitle(args.title);
        if (Object.hasOwn(args, "note")) entry.note = text(args.note, "note", 50000);
        if (Object.hasOwn(args, "due")) entry.due = dueDate(args.due);
        if (Object.hasOwn(args, "labels")) entry.labels = labels(args.labels);
        if (Object.hasOwn(args, "checklist")) entry.checklist = checklist(args.checklist);
        entry.updatedAt = now;
        break;
      }
      case "board.card.move": {
        const entry = card(), destination = column(args.column);
        detach(entry.id);
        const index = args.index ?? destination.cardIds.length;
        requireValue(Number.isInteger(index) && index >= 0 && index <= destination.cardIds.length, "index must be a valid final position in the destination column");
        destination.cardIds.splice(index, 0, entry.id);
        entry.updatedAt = now;
        break;
      }
      case "board.card.archive": {
        const entry = card();
        detach(entry.id);
        entry.updatedAt = now;
        board.archived.push(entry);
        delete board.cards[entry.id];
        break;
      }
      case "board.card.remove": {
        requireValue(validId(args.id), "A valid card id is required");
        if (Object.hasOwn(board.cards, args.id)) {
          detach(args.id);
          delete board.cards[args.id];
        } else {
          const index = board.archived.findIndex((entry) => entry.id === args.id);
          requireValue(index >= 0, "Card not found; refresh the board");
          board.archived.splice(index, 1);
        }
        break;
      }
      case "board.card.restore": {
        requireValue(validId(args.id), "A valid card id is required");
        const index = board.archived.findIndex((entry) => entry.id === args.id);
        requireValue(index >= 0, "Archived card not found; refresh the board");
        const destination = column(args.column ?? board.columns[0].id);
        const [entry] = board.archived.splice(index, 1);
        entry.updatedAt = now;
        board.cards[entry.id] = entry;
        const at = args.index ?? destination.cardIds.length;
        requireValue(Number.isInteger(at) && at >= 0 && at <= destination.cardIds.length, "index must be a valid final position in the destination column");
        destination.cardIds.splice(at, 0, entry.id);
        break;
      }
      case "board.card.undelete": {
        // Puts back a card that was just removed, exactly as it was (the panel offers 撤销 after a delete).
        requireValue(object(args.card) && validId(args.card.id), "A card to restore is required");
        requireValue(!Object.hasOwn(board.cards, args.card.id) && !board.archived.some((entry) => entry.id === args.card.id), "A card with this id already exists");
        text(args.card.title, "title", 500, true);
        const entry = structuredClone(args.card);
        const destination = column(args.column ?? board.columns[0].id);
        const at = args.index ?? destination.cardIds.length;
        requireValue(Number.isInteger(at) && at >= 0 && at <= destination.cardIds.length, "index must be a valid final position in the destination column");
        board.cards[entry.id] = entry;
        destination.cardIds.splice(at, 0, entry.id);
        break;
      }
      case "board.column.add":
        board.columns.push({ id: newId(), title: text(args.title, "column title", 100, true), done: false, cardIds: [] });
        break;
      case "board.column.rename":
        column(args.id).title = text(args.title, "column title", 100, true);
        break;
      case "board.column.remove":
        requireValue(column(args.id).cardIds.length === 0, "Only empty columns can be removed");
        requireValue(board.columns.length > 1, "Keep at least one board column");
        board.columns = board.columns.filter((entry) => entry.id !== args.id);
        break;
      default:
        throw new Error(`Unknown board action: ${action}`);
    }
    return board;
  });
}

/** Internal compound writes share the same lock and atomic file replacement as ordinary board edits. */
const unchangedBoardWrite = Symbol('unchanged board write');
export const boardUnchanged = value => ({ [unchangedBoardWrite]: true, value });
export async function boardTransaction(update) {
  const target = boardPath(), directory = join(target, "..");
  // This folder is shared with the notebook registry: writers of this process take turns in one queue, and the file lock only arbitrates between processes (lib/store-lock.js).
  return withStoreLock(directory, async () => {
    const tmp = `${target}.${newId()}.tmp`;
    try {
      const board = await readBoard(target);
      requireValue(!board.readOnly, board.error);
      const result = await update(board);
      if (result?.[unchangedBoardWrite]) return result.value;
      board.revision += 1;
      validateBoard(board);
      await writeFile(tmp, JSON.stringify(board, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await rename(tmp, target);
      return result;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  });
}

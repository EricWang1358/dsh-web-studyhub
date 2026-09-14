import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { id as newId } from "./util.js";
import { basename, join, win32 } from "node:path";
import lockfile from "proper-lockfile";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !forbidden.has(id);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
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
function validateCard(card) {
  requireValue(object(card) && validId(card.id), "Invalid card id");
  text(card.title, "title", 500, true);
  text(card.note, "note", 50000);
  dueDate(card.due);
  labels(card.labels);
  requireValue(typeof card.createdAt === "string" && Number.isFinite(Date.parse(card.createdAt)) && typeof card.updatedAt === "string" && Number.isFinite(Date.parse(card.updatedAt)), "Invalid card timestamps");
  requireValue(object(card.origin) && typeof card.origin.workspace === "string" && typeof card.origin.workspaceTitle === "string", "Invalid card origin");
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
}
async function readBoard(target) {
  try {
    const board = JSON.parse(await readFile(target, "utf8"));
    validateBoard(board);
    return board;
  } catch (error) {
    if (error.code === "ENOENT") return emptyBoard();
    return { ...emptyBoard(), readOnly: true, error: `Cannot read board: ${error.message}. Restore or repair ${target} before editing; the original file has been preserved.` };
  }
}

const actions = new Set(["board.card.add", "board.card.edit", "board.card.move", "board.card.archive", "board.card.remove", "board.card.restore", "board.column.add", "board.column.rename", "board.column.remove"]);

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
  const directory = join(target, "..");
  await mkdir(directory, { recursive: true });
  const release = await lockfile.lock(directory, { realpath: true, retries: { retries: 20, minTimeout: 25, maxTimeout: 250 }, stale: 10000 });
  const tmp = `${target}.${newId()}.tmp`;
  try {
    const board = await readBoard(target);
    requireValue(!board.readOnly, board.error);
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
        board.cards[id] = { id, title: text(args.title, "title", 500, true), note: text(args.note ?? "", "note", 50000), due: dueDate(args.due ?? ""), labels: labels(args.labels ?? []), createdAt: now, updatedAt: now, origin: { workspace, workspaceTitle: workspace.includes("\\") ? win32.basename(workspace) : basename(workspace) } };
        destination.cardIds.push(id);
        break;
      }
      case "board.card.edit": {
        const entry = card();
        if (Object.hasOwn(args, "title")) entry.title = text(args.title, "title", 500, true);
        if (Object.hasOwn(args, "note")) entry.note = text(args.note, "note", 50000);
        if (Object.hasOwn(args, "due")) entry.due = dueDate(args.due);
        if (Object.hasOwn(args, "labels")) entry.labels = labels(args.labels);
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
        destination.cardIds.push(entry.id);
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
    board.revision += 1;
    validateBoard(board);
    await writeFile(tmp, JSON.stringify(board, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(tmp, target);
    return board;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
    await release();
  }
}

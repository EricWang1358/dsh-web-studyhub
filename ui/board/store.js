import { applyBoardAction } from '../../lib/board-model.js';

/* The board store: one subscription serves the navigation badge and the board
   page. Reads are cheap polls (`since` revision). Writes are optimistic: the
   board is patched locally with the same pure model the server uses, the
   writes then go out one at a time, each carrying the revision the previous
   one produced. A failure puts the latest server board back, so the page can
   never freeze or show a state the server does not have. */

const isConflict = (message) => /revision conflict/i.test(String(message));
/* Writes that only add something new. When the board moved on before one of them reached the server (the daily plan
   writes it on its own, #855), it is sent once more on the latest revision: it cannot overwrite a change the learner has
   not seen. Moves and edits are never replayed; they stay refused and the page says so. A time-log add is left out: it
   also undoes a deleted entry, and replaying that undo could log the same minutes twice. */
const REPLAY_ON_CONFLICT = new Set(['board.card.add', 'board.column.add']);

export function createBoardStore(call, { initialBoard = null, onBoard } = {}) {
  let state = { board: initialBoard, error: '', conflict: false, busy: false };
  let server = initialBoard;            // the last board the server confirmed
  let pending = 0;              // writes accepted but not yet settled
  let epoch = 0;                // bumped on failure: older queued writes are dropped
  let reading = false, ticket = 0, chain = Promise.resolve();
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  /** Read the board; `force` skips the `since` shortcut (used to reconcile). */
  async function refresh({ force = false } = {}) {
    if (pending > 0 || reading) return;
    reading = true;
    const mine = ++ticket;
    try {
      const next = await call('board.get', !force && server && !server.readOnly ? { since: server.revision } : {});
      if (mine !== ticket || pending > 0 || next.unchanged) return;
      server = next;
      onBoard?.(next);
      set({ board: next });
    } catch (error) {
      if (mine === ticket) set({ error: error.message, conflict: false });
    } finally {
      reading = false;
    }
  }

  async function mutate(action, args = {}, { optimistic = true } = {}) {
    if (!server || server.readOnly) return false;
    const mine = epoch;
    if (optimistic) {
      const patched = applyBoardAction(state.board, action, args);
      if (patched !== state.board) set({ board: patched });
    }
    ticket++; // any read already in flight is now stale
    pending++;
    set({ busy: true, error: '', conflict: false });
    const send = async () => {
      const next = await call(action, { revision: server.revision, ...args });
      server = next;
      onBoard?.(next);
      if (pending === 1) set({ board: next });
      return true;
    };
    const run = async () => {
      if (mine !== epoch) return false;
      try {
        return await send();
      } catch (error) {
        if (isConflict(error.message) && REPLAY_ON_CONFLICT.has(action) && !Object.hasOwn(args, 'revision')) {
          const before = server;
          try {
            server = await call('board.get', {});
            onBoard?.(server);
            await send();
            /* Writes queued behind this add were made on a board without the change that made it stale. Sent now they
               would carry the revision just read and overwrite that change unseen, so they are dropped and the page
               says so, as when the add itself fails. */
            if (pending > 1) {
              epoch++;
              // Show the board those writes missed at once, so the next one is made on it and not on the old view.
              set({ board: server, error: error.message, conflict: true });
            }
            return true;
          } catch {
            // The board changed under the add and could not be brought up to date: say so, as before the resend, and
            // show the board just read (if any), since the next write will carry its revision.
            if (server !== before) set({ board: server });
          }
        }
        epoch++;
        set({ error: error.message, conflict: isConflict(error.message) });
        return false;
      }
    };
    const result = chain.then(run);
    chain = result.then(() => {}, () => {});
    const ok = await result;
    pending--;
    if (pending === 0) {
      set({ busy: false });
      if (!ok || state.board !== server) await refresh({ force: true });
    }
    return ok;
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh,
    mutate,
    clearError: () => { if (state.error || state.conflict) set({ error: '', conflict: false }); },
    /** Invalidate reads that are in flight (the page is going away). */
    invalidate() { ticket++; },
  };
}

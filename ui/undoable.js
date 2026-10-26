import { ui, uiFormat } from './i18n.js';
import { failureText } from './failure.js';

/* 删除 with 撤销 (the second tier of deletion: everything that is not a source or a question). One unit, two ways:

   commitLater({ keys, message, commit, failed?, undone?, onRestore? })   for an operation the host cannot take back (note.delete, job.delete, workflow.session.delete ...).
     The items named by `keys` are hidden at once (hidden(key) is true) and the app's notice says `message` with 撤销. The host is asked (`commit()`)
     only when that notice leaves: its time ran out, it was closed, a newer notice took its place, the page or the library changed. flush() asks at once
     (the page is hidden or closed, the component goes away). 撤销 before that shows the items again and nothing is sent. A commit that fails shows the
     items again with an error that says why (`failed(reason)` words it). Each entry is committed at most once. `onRestore()` runs whenever the items come back
   (撤销, a failed commit, an abandon): for a page that did more than hide them (closed the note, emptied a thread).
   restoreWith({ message, restore, restored?, secondary? })   for an operation that already happened and has an inverse (job.unarchive, source / deck restore,
     board.card.undelete). The notice says `message` with 撤销, which runs `restore()` (it resolves truthy when it worked); `secondary` is a second quiet action
     ({ label, onClick }), e.g. 永久删除… after an archive.

   `toast` is the app's toast api (ui/components/Feedback.jsx createToastApi): show({ tone, message, action, secondary, undo, timeout, onLeave }), error(), dismiss().
   The notice is the app's one notice slot, so a newer notice ends an older offer: a commitLater entry is then committed, a restoreWith one simply loses its button.
   Plain JavaScript, no React: ui/use-undoable.js wires it to a page (re-render, page hide, unmount, library switch). */

export const UNDO_TIMEOUT = 8000;

const failedOf = (result) => result === false || (result && typeof result === 'object' && result.ok === false);

export function createUndoable({ toast, onChange = () => {}, timeout = UNDO_TIMEOUT } = {}) {
  const entries = [];
  let showing = null, version = 0;
  const say = () => (typeof toast === 'function' ? toast() : toast) || {};
  const changed = () => { version++; onChange(); };
  const drop = (entry) => { const at = entries.indexOf(entry); if (at >= 0) entries.splice(at, 1); };
  const hides = (entry) => entry.state === 'pending' || entry.state === 'committing' || entry.state === 'committed';

  function hidden(key) { return entries.some((entry) => hides(entry) && entry.keys.includes(key)); }

  function settle(entry) {
    if (entry.state !== 'pending') return entry.done || Promise.resolve(entry.state === 'committed');
    entry.state = 'committing';
    entry.done = (async () => {
      let reason = '';
      try {
        const result = await entry.commit();
        if (failedOf(result)) reason = failureText(result?.message) || ui('出了点问题，请重试。');
      } catch (error) { reason = failureText(error) || ui('出了点问题，请重试。'); }
      if (!reason) { entry.state = 'committed'; changed(); return true; }
      entry.state = 'failed';
      drop(entry);
      changed();
      entry.onRestore?.();
      say().error?.(entry.failed ? entry.failed(reason) : uiFormat('没能删除，已放回原处：{0}', [reason]));
      return false;
    })();
    changed();
    return entry.done;
  }

  function leave(entry) {
    if (showing === entry) showing = null;
    return settle(entry);
  }

  function undo(entry) {
    if (entry.state !== 'pending') return false;
    entry.state = 'restored';
    drop(entry);
    if (showing === entry) showing = null;
    changed();
    entry.onRestore?.();
    say().show?.({ tone: 'info', message: entry.undone || ui('已撤销') });
    return true;
  }

  /** Hide `keys` now, ask the host when the notice leaves. Returns the entry, or null when every key is already on its way out (a second click). */
  function commitLater({ keys, message, commit, failed, undone, onRestore }) {
    const fresh = [...new Set((keys || []).filter((key) => key !== undefined && key !== null))].filter((key) => !hidden(key));
    if (!fresh.length || typeof commit !== 'function') return null;
    const entry = { keys: fresh, state: 'pending', commit, failed, undone, onRestore, done: null };
    entries.push(entry);
    showing = entry;
    changed();
    say().show?.({ tone: 'success', message, undo: true, timeout, onLeave: () => { void leave(entry); },
      action: { label: ui('撤销'), onClick: () => undo(entry) } });
    return entry;
  }

  /** The operation already happened: offer its inverse. */
  function restoreWith({ message, restore, restored, secondary, tone = 'success' }) {
    const entry = { state: 'done' };
    say().show?.({ tone, message, undo: true, timeout,
      action: { label: ui('撤销'), onClick: async () => {
        if (entry.state !== 'done') return false;
        entry.state = 'restoring';
        say().dismiss?.();
        let ok = false;
        try { const result = await restore(); ok = !!result && !failedOf(result); } catch (error) { say().error?.(error); }
        entry.state = ok ? 'restored' : 'done';
        if (ok) say().show?.({ tone: 'info', message: restored || ui('已撤销') });
        return ok;
      } },
      ...(secondary ? { secondary: { label: secondary.label, onClick: () => { if (entry.state !== 'done') return; say().dismiss?.(); secondary.onClick(); } } } : {}) });
    return entry;
  }

  /** Commit every entry that is still waiting (the page goes away). Resolves when the host answered. */
  function flush() {
    const waiting = entries.filter((entry) => entry.state === 'pending');
    if (showing && waiting.includes(showing)) { showing = null; say().dismiss?.(); }
    return Promise.all(waiting.map(settle));
  }

  /** The library changed under the page: what was still waiting is NOT sent (it would reach the other library) and shows again. Returns how many entries. */
  function abandon() {
    const waiting = entries.filter((entry) => entry.state === 'pending');
    for (const entry of waiting) { entry.state = 'abandoned'; drop(entry); entry.onRestore?.(); }
    if (showing && waiting.includes(showing)) showing = null;
    if (waiting.length) changed();
    return waiting.length;
  }

  const pending = () => entries.filter((entry) => entry.state === 'pending').length;
  /** Changes whenever an item is hidden or shown again: a memo over a filtered list lists it. */
  const stamp = () => version;
  return { commitLater, restoreWith, hidden, flush, abandon, pending, version: stamp, undo, leave };
}

/** restoreWith without a page unit (it needs no flush): for a component that only offers the inverse of what it just did (a job card's 归档). */
export const offerRestore = (toast, options) => createUndoable({ toast }).restoreWith(options);

/* Every mounted unit, so the library switch can flush (a switch the learner made: before it happens) or abandon (a switch that already happened) them all. */
const units = new Set();
export function registerUndoable(unit) { units.add(unit); return () => { units.delete(unit); }; }
/** Before the learner moves the library: send what is waiting to the library it belongs to. */
export function flushUndoable() { return Promise.all([...units].map((unit) => unit.flush())); }
/** The library already changed: nothing waiting may reach the new one. Returns how many deletions were not made. */
export function abandonUndoable() { return [...units].reduce((total, unit) => total + unit.abandon(), 0); }

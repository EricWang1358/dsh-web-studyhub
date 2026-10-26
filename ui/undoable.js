import { ui, uiFormat } from './i18n.js';
import { failureText } from './failure.js';

/* 删除 with 撤销 (the second tier of deletion: everything that is not a source or a question). One unit, two ways:

   commitLater({ keys, message, commit, failed?, undone?, onRestore?, kept?, focus? })   for an operation the host cannot take back (note.delete, job.delete,
     workflow.session.delete ...). The items named by `keys` are hidden at once (hidden(key) is true) and the app's notice says `message` with 撤销. The host is
     asked (`commit()`) only when that notice leaves: its time ran out, it was closed, a newer notice took its place, the page or the library changed. flush()
     asks at once (the page is hidden or closed, the component goes away, the learner moves the library) and waits for what is already on its way.
     撤销 before that shows the items again and nothing is sent. A commit that fails shows the items again with an error that says why (`failed(reason)` words
     it). Each entry is committed at most once. A commit may answer { ok: true, kept: [key…] }: those items were NOT deleted (a task that started running) and
     show again, with `kept(count)` as the notice. A committed item stays hidden for `holdMs` (the next snapshot no longer lists it), then the unit forgets it, so
     an item that later comes back under the same key is shown and can be deleted again. `onRestore()` runs whenever the items come back (撤销, a failed commit,
     an abandon): for a page that did more than hide them (closed the note). `focus()` returns the element to put the keyboard focus on after 撤销.
   restoreWith({ message, restore, restored?, secondary?, focus? })   for an operation that already happened and has an inverse (job.unarchive, source / deck
     restore, annotation restore). The notice says `message` with 撤销, which runs `restore()` (it resolves truthy when it worked; the notice stays up while it
     runs, and stays usable when it failed); `secondary` is a second quiet action ({ label, onClick }), e.g. 永久删除… after an archive.

   The words: a notice started with the mouse says how long 撤销 lasts and what ends it sooner (「…（8 秒内、下一次删除前可撤销）」: the app has one notice, so
   the next deletion's notice sends this one) and leaves after UNDO_TIMEOUT unless hovered or focused. One started from
   the keyboard (`keyboard()` is true: Enter or Space was the last input) stays until it is closed or replaced, and says no time: the learner may need many
   Tab presses to reach 撤销 (ui/use-undoable.js tracks the input).
   `scope()` names the library an entry was made in; a commit whose library is no longer the current one is not sent (its items show again, with an error).
   `toast` is the app's toast api (ui/components/Feedback.jsx createToastApi): show({ tone, message, action, secondary, undo, timeout, persistent, onLeave }),
   error(), dismiss(). The notice is the app's one notice slot, so a newer notice ends an older offer: a commitLater entry is then committed, a restoreWith one
   simply loses its button. Plain JavaScript, no React: ui/use-undoable.js wires it to a page (re-render, page hide, unmount, library switch). */

export const UNDO_TIMEOUT = 8000;
/** How long a deleted item stays hidden after the host said it is gone: the app's next snapshot (2.5 s) or the page's own reload removes it well before. */
export const COMMITTED_HOLD = 10000;

const failedOf = (result) => result === false || (result && typeof result === 'object' && result.ok === false);
const NO_REASON = () => ui('这次没有成功，也没有拿到具体原因。可以再试一次。');
const defaultLater = (work, ms) => { const timer = setTimeout(work, ms); timer?.unref?.(); return timer; };

export function createUndoable({ toast, onChange = () => {}, timeout = UNDO_TIMEOUT, holdMs = COMMITTED_HOLD, keyboard = () => false, scope = () => '', later = defaultLater } = {}) {
  const entries = [];
  let showing = null, version = 0;
  const say = () => (typeof toast === 'function' ? toast() : toast) || {};
  const changed = () => { version++; onChange(); };
  const drop = (entry) => { const at = entries.indexOf(entry); if (at >= 0) entries.splice(at, 1); };
  const hides = (entry) => entry.state === 'pending' || entry.state === 'committing' || entry.state === 'committed';
  // The keyboard focus after 撤销: the element `focus()` names, once the page drew it again (a few tries, a frame apart).
  const refocus = (focus) => {
    if (typeof focus !== 'function') return;
    let tries = 0;
    const attempt = () => { const target = focus(); if (target?.focus) target.focus({ preventScroll: false }); else if (++tries < 8) later(attempt, 60); };
    later(attempt, 30);
  };
  // What the notice says and how long it lasts: the time is said for a mouse, and a notice started from the keyboard waits for the learner.
  const notice = (message, byKeyboard) => (byKeyboard ? { message, persistent: true } : { message: uiFormat('{0}（{1} 秒内、下一次删除前可撤销）', [message, Math.round(timeout / 1000)]), timeout });

  function hidden(key) { return entries.some((entry) => hides(entry) && entry.keys.includes(key)); }

  function putBack(entry, state) {
    entry.state = state;
    drop(entry);
    changed();
    entry.onRestore?.();
  }

  function settle(entry) {
    if (entry.state !== 'pending') return entry.done || Promise.resolve(entry.state === 'committed');
    entry.state = 'committing';
    entry.done = (async () => {
      let reason = '', result;
      if (scope() !== entry.scope) reason = ui('学习库已更换，这次删除没有执行。');
      else {
        try {
          result = await entry.commit();
          if (failedOf(result)) reason = failureText(result?.message) || NO_REASON();
        } catch (error) { reason = failureText(error) || NO_REASON(); }
      }
      if (reason) {
        putBack(entry, 'failed');
        say().error?.(entry.failed ? entry.failed(reason) : uiFormat('没能删除，已放回原处：{0}', [reason]));
        return false;
      }
      const kept = Array.isArray(result?.kept) ? result.kept.filter((key) => entry.keys.includes(key)) : [];
      entry.state = 'committed';
      if (kept.length) {
        entry.keys = entry.keys.filter((key) => !kept.includes(key));
        if (entry.kept) say().show?.({ tone: 'warning', message: entry.kept(kept.length) });
      }
      changed();
      later(() => { if (entry.state === 'committed') { entry.state = 'released'; drop(entry); changed(); } }, holdMs);
      return true;
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
    if (showing === entry) showing = null;
    putBack(entry, 'restored');
    say().show?.({ tone: 'info', message: entry.undone || ui('已撤销') });
    refocus(entry.focus);
    return true;
  }

  /** Hide `keys` now, ask the host when the notice leaves. Returns the entry, or null when every key is already on its way out (a second click). */
  function commitLater({ keys, message, commit, failed, undone, onRestore, kept, focus }) {
    const fresh = [...new Set((keys || []).filter((key) => key !== undefined && key !== null))].filter((key) => !hidden(key));
    if (!fresh.length || typeof commit !== 'function') return null;
    const entry = { keys: fresh, state: 'pending', commit, failed, undone, onRestore, kept, focus, scope: scope(), done: null };
    entries.push(entry);
    showing = entry;
    changed();
    say().show?.({ tone: 'success', undo: true, ...notice(message, keyboard()), onLeave: () => { void leave(entry); },
      action: { label: ui('撤销'), onClick: () => undo(entry) } });
    return entry;
  }

  /** The operation already happened: offer its inverse. */
  function restoreWith({ message, restore, restored, secondary, focus, tone = 'success' }) {
    const entry = { state: 'done' };
    say().show?.({ tone, undo: true, ...notice(message, keyboard()),
      action: { label: ui('撤销'), onClick: async () => {
        if (entry.state !== 'done') return false;
        entry.state = 'restoring';
        let ok = false;
        try {
          const result = await restore();
          ok = !!result && !failedOf(result);
          // act() resolves undefined when another write held the lock: say so, the offer stays usable for a second try.
          if (result === undefined) say().error?.(ui('上一个操作还没结束，这次没有开始。等它结束后再点一次。'));
        } catch (error) { say().error?.(error); }
        entry.state = ok ? 'restored' : 'done';
        if (ok) { say().show?.({ tone: 'info', message: restored || ui('已撤销') }); refocus(focus); }
        return ok;
      } },
      ...(secondary ? { secondary: { label: secondary.label, onClick: () => { if (entry.state !== 'done') return; say().dismiss?.(); secondary.onClick(); } } } : {}) });
    return entry;
  }

  /** Commit every entry that is still waiting (the page goes away) and wait for those already on their way. Resolves when the host answered all of them. */
  function flush() {
    const waiting = entries.filter((entry) => entry.state === 'pending'), sending = entries.filter((entry) => entry.state === 'committing');
    if (showing && waiting.includes(showing)) { showing = null; say().dismiss?.(); }
    return Promise.all([...waiting.map(settle), ...sending.map((entry) => entry.done)]);
  }

  /** The library changed under the page: what was still waiting is NOT sent (it would reach the other library) and shows again. Returns how many items. */
  function abandon() {
    const waiting = entries.filter((entry) => entry.state === 'pending');
    for (const entry of waiting) { entry.state = 'abandoned'; drop(entry); entry.onRestore?.(); }
    if (showing && waiting.includes(showing)) showing = null;
    if (waiting.length) changed();
    return waiting.reduce((total, entry) => total + entry.keys.length, 0);
  }

  const pending = () => entries.filter((entry) => entry.state === 'pending').length;
  /** Changes whenever an item is hidden or shown again: a memo over a filtered list lists it. */
  const stamp = () => version;
  return { commitLater, restoreWith, hidden, flush, abandon, pending, version: stamp, undo, leave };
}

/** restoreWith without a page unit (it needs no flush): for a component that only offers the inverse of what it just did (a job card's 归档). */
export const offerRestore = (toast, options, extra = {}) => createUndoable({ toast, keyboard: startedByKeyboard, ...extra }).restoreWith(options);

/* Every mounted unit, so the library switch can flush (a switch the learner made: before it happens) or abandon (a switch that already happened) them all. */
const units = new Set();
export function registerUndoable(unit) { units.add(unit); return () => { units.delete(unit); }; }
/** Before the learner moves the library: send what is waiting to the library it belongs to, and wait for what is already on its way. */
export function flushUndoable() { return Promise.all([...units].map((unit) => unit.flush())); }
/** The library already changed: nothing waiting may reach the new one. Returns how many items were not deleted. */
export function abandonUndoable() { return [...units].reduce((total, unit) => total + unit.abandon(), 0); }

/* The input the learner used last: a notice started by Enter or Space must not run out while they Tab to 撤销. Installed once, when this module loads in a page, so
   a page that only offers restoreWith (a job card's 归档, 全部归档, a deck archive) knows it too, whatever else is mounted. */
let lastInput = 'pointer';
export function trackInput(target) {
  if (!target?.addEventListener || target.__undoInput) return;
  target.__undoInput = true;
  target.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') lastInput = 'keyboard'; }, true);
  target.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
}
export const startedByKeyboard = () => lastInput === 'keyboard';
if (typeof document !== 'undefined') trackInput(document);

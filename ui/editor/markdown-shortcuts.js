import { EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

const URL_RE = /^https?:\/\/\S+$/i;

function countCharRun(text, index, ch, step) {
  let count = 0;
  let pos = step < 0 ? index - 1 : index;
  while (pos >= 0 && pos < text.length && text[pos] === ch) {
    count += 1;
    pos += step;
  }
  return count;
}

function repeatedCharOf(marker) {
  if (!marker) return null;
  const first = marker[0];
  for (let i = 1; i < marker.length; i += 1) {
    if (marker[i] !== first) return null;
  }
  return first;
}

function canUnwrapBoundary(leftCount, rightCount, marker) {
  if (marker === '*') return leftCount % 2 === 1 && rightCount % 2 === 1;
  if (marker === '**') return leftCount >= 2 && rightCount >= 2;
  if (marker === '`') return leftCount === 1 && rightCount === 1;
  return true;
}

function innerContainsMarker(inner, marker) {
  if (marker === '*') return /\*/.test(inner.replace(/\*\*/g, ''));
  return inner.includes(marker);
}

/**
 * Toggles an inline Markdown delimiter (`**`, `*`, `` ` ``) around the `[from, to]` selection in `docText`.
 * Unwraps when the selection is directly flanked by `marker` or itself begins and ends with `marker`.
 */
export function wrapOrUnwrapSelection(docText, from, to, marker) {
  const doc = String(docText ?? '');
  const m = marker.length;
  const start = Math.max(0, Math.min(from, to, doc.length));
  const end = Math.max(start, Math.min(Math.max(from, to), doc.length));
  const runChar = repeatedCharOf(marker);

  const hasOuter = start >= m && end + m <= doc.length
    && doc.slice(start - m, start) === marker
    && doc.slice(end, end + m) === marker;
  if (hasOuter) {
    const outerOk = !runChar || canUnwrapBoundary(
      countCharRun(doc, start, runChar, -1),
      countCharRun(doc, end, runChar, 1),
      marker,
    );
    if (outerOk) {
      const replaceFrom = start - m;
      const replaceTo = end + m;
      const insert = doc.slice(start, end);
      return {
        doc: doc.slice(0, replaceFrom) + insert + doc.slice(replaceTo),
        from: replaceFrom,
        to: end - m,
        unwrapped: true,
        change: { from: replaceFrom, to: replaceTo, insert },
      };
    }
  }

  const selected = doc.slice(start, end);
  if (selected.length >= 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(m, selected.length - m);
    const innerOk = !innerContainsMarker(inner, marker) && (!runChar || canUnwrapBoundary(
      countCharRun(selected, 0, runChar, 1),
      countCharRun(selected, selected.length, runChar, -1),
      marker,
    ));
    if (innerOk) {
      return {
        doc: doc.slice(0, start) + inner + doc.slice(end),
        from: start,
        to: end - 2 * m,
        unwrapped: true,
        change: { from: start, to: end, insert: inner },
      };
    }
  }

  const insert = `${marker}${selected}${marker}`;
  return {
    doc: doc.slice(0, start) + insert + doc.slice(end),
    from: start + m,
    to: end + m,
    unwrapped: false,
    change: { from: start, to: end, insert },
  };
}

/**
 * Turns a pasted URL into `[selectedText](url)` when pasting a single HTTP(S) URL over a non-empty,
 * single-line, non-URL text selection; returns `null` otherwise so normal paste proceeds.
 */
export function linkifyPastedUrl(selectedText, clipboardText) {
  if (typeof selectedText !== 'string' || typeof clipboardText !== 'string') return null;
  const trimmedSelection = selectedText.trim();
  if (!trimmedSelection || /[\r\n]/.test(selectedText) || URL_RE.test(trimmedSelection)) return null;
  const url = clipboardText.trim();
  if (!URL_RE.test(url)) return null;
  return `[${selectedText}](${url})`;
}

/** Creates a CodeMirror command that wraps or unwraps each selected range with `marker`. */
export function toggleMarkerCommand(marker) {
  return (target) => {
    if (!target?.state || target.state.readOnly) return false;
    const docText = target.state.doc.toString();
    const spec = target.state.changeByRange((range) => {
      const result = wrapOrUnwrapSelection(docText, range.from, range.to, marker);
      const nextRange = range.anchor <= range.head
        ? EditorSelection.range(result.from, result.to)
        : EditorSelection.range(result.to, result.from);
      return { changes: result.change, range: nextRange };
    });
    target.dispatch(target.state.update(spec, { userEvent: 'input' }));
    return true;
  };
}

export const toggleBold = toggleMarkerCommand('**');
export const toggleItalic = toggleMarkerCommand('*');
export const toggleInlineCode = toggleMarkerCommand('`');

/** CodeMirror paste event handler that linkifies selected text when pasting a URL. */
export function handlePasteUrl(event, view) {
  if (!view?.state || view.state.readOnly) return false;
  const main = view.state.selection.main;
  if (main.empty) return false;
  const clip = event?.clipboardData?.getData?.('text/plain') ?? '';
  const replacement = linkifyPastedUrl(view.state.sliceDoc(main.from, main.to), clip);
  if (!replacement) return false;
  event.preventDefault?.();
  view.dispatch(view.state.update({
    changes: { from: main.from, to: main.to, insert: replacement },
    selection: EditorSelection.cursor(main.from + replacement.length),
    userEvent: 'input.paste',
  }));
  return true;
}

/** Returns `true` when `event` is a Ctrl/Cmd+S shortcut without Alt/Shift. */
export function isSaveShortcut(event) {
  return Boolean(
    event
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey
    && String(event.key ?? '').toLowerCase() === 's',
  );
}

/** Container `keydown` helper for Ctrl/Cmd+S outside CodeMirror (skips if already prevented or inside a dialog). */
export function handleSaveKeyDown(event, onSave) {
  if (!event || event.defaultPrevented || !isSaveShortcut(event)) return false;
  if (event.target?.closest?.('dialog')) return false;
  event.preventDefault?.();
  onSave?.();
  return true;
}

/**
 * Returns CodeMirror extensions adding `Mod-b`, `Mod-i`, ``Mod-` `` formatting toggles, optional `Mod-s` save,
 * and paste-URL-as-Markdown-link behavior.
 */
export function markdownEditorExtensions({ onSave } = {}) {
  const bindings = [
    { key: 'Mod-b', preventDefault: true, run: toggleBold },
    { key: 'Mod-i', preventDefault: true, run: toggleItalic },
    { key: 'Mod-`', preventDefault: true, run: toggleInlineCode },
  ];
  if (onSave) {
    bindings.push({
      key: 'Mod-s',
      preventDefault: true,
      run: () => { onSave(); return true; },
    });
  }
  return [
    Prec.high(keymap.of(bindings)),
    EditorView.domEventHandlers({ paste: handlePasteUrl }),
  ];
}

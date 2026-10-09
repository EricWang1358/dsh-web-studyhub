import { plainReason } from './mineru-history.js';

/* What a local converter (Marker) prints, made fit for the job's log (docs/marker-external.md «日志»): every line plain text with no path, token or folder
   (plainReason, a path keeps only its last part), bounded, and in time. Progress bars (tqdm redraws one line with "\r") collapse to their last state: one
   line per bar when it is done or another one starts, and the bar in hand as a live line that is not logged. A run that prints a lot keeps its first and
   last lines and says how many were left out. A failure keeps the END of what was printed, because the last line of a Python traceback is its cause. */

export const MARKER_LOG = Object.freeze({ headLines: 12, tailLines: 8, lineChars: 300, failureLines: 12, failureChars: 2000, summaryChars: 240, liveEveryMs: 1000 });

const BAR = /^(.*?):?\s*(\d{1,3})%\s*\|[^|]*\|\s*(\d+)\s*\/\s*(\d+)/;
const CARETS = /^[\s^~]+$/;

/** A tqdm progress line ("Recognizing layout: 40%|████      | 2/5 [00:03<00:04, 1.2s/it]") as { label, percent, done, total }, else null. */
export function progressOf(line) {
  const match = BAR.exec(String(line));
  if (!match) return null;
  return { label: match[1].trim().slice(0, 80), percent: Math.min(100, Number(match[2])), done: Number(match[3]), total: Number(match[4]) };
}
const barLine = bar => `${bar.label ? `${bar.label}: ` : ''}${bar.percent}% (${bar.done}/${bar.total})`;

/** One printed line as the log may keep it. */
export const plainLine = (line, secrets = []) => plainReason(String(line), { secrets, limit: MARKER_LOG.lineChars, names: true });

/** The lines of a text, without the empty ones, the progress bars and the "^^^^" markers of a traceback. */
const meaningful = text => String(text ?? '').split(/\r\n|\n|\r/).map(line => line.trimEnd()).filter(line => line.trim() && !CARETS.test(line) && !progressOf(line));
const EXCEPTION = /^\s*(?:[A-Za-z_][\w.]*\.)?[A-Za-z_]\w*(?:Error|Exception|Interrupt|Exit|Failure)\b(?::|$)/;

/**
 * Why a converter run failed, from what it printed: { summary, lines }. `lines` are the last meaningful lines (at most 12, at most 2000 characters, the end kept),
 * each plain; `summary` is the exception of a traceback (its last line of the form "SomeError: ..."), else the last line; at most 240 characters (the exception's name and the start of its message).
 */
export function failureOf(text, { secrets = [] } = {}) {
  const all = meaningful(text);
  const lines = all.slice(-MARKER_LOG.failureLines).map(line => plainLine(line, secrets)).filter(Boolean);
  while (lines.length > 1 && lines.join('\n').length > MARKER_LOG.failureChars) lines.shift();
  if (lines.length === 1 && lines[0].length > MARKER_LOG.failureChars) lines[0] = lines[0].slice(-MARKER_LOG.failureChars);
  const cause = [...all].reverse().find(line => EXCEPTION.test(line)) ?? all[all.length - 1] ?? '';
  return { summary: plainReason(cause, { secrets, limit: MARKER_LOG.summaryChars, names: true }), lines };
}

/**
 * The output of one run as log lines. `emit({ text })` gets a line to log (already plain), `emit({ omitted })` the count of the lines left out between the first and the last ones; `live(bar)` the bar in hand (at most once a second, and once more at the end).
 * write(text) takes what the process printed, in pieces as they come; end() logs the last bar and the kept tail, and resolves nothing.
 */
export function createOutputLog({ emit, live = () => {}, secrets = [], now = Date.now } = {}) {
  let pending = '', count = 0, omitted = 0, bar = null, liveAt = 0;
  const tail = [];
  const closeBar = () => { if (bar) { emit({ text: plainLine(barLine(bar), secrets) }); bar = null; } };
  const line = text => {
    const trimmed = text.trim();
    if (!trimmed || CARETS.test(trimmed)) return;
    const progress = progressOf(trimmed);
    if (progress) {
      if (bar && bar.label !== progress.label) closeBar();
      bar = progress;
      if (now() - liveAt >= MARKER_LOG.liveEveryMs || progress.percent === 100) { liveAt = now(); live({ ...bar, label: plainLine(bar.label, secrets) }); }
      return;
    }
    closeBar();
    count += 1;
    if (count <= MARKER_LOG.headLines) { emit({ text: plainLine(trimmed, secrets) }); return; }
    tail.push(trimmed);
    if (tail.length > MARKER_LOG.tailLines) { tail.shift(); omitted += 1; }
  };
  return {
    write(text) {
      pending += String(text ?? '');
      // A line ends at "\n" or at "\r" (a progress bar redraws itself after "\r"); what is left is the start of the next one.
      const parts = pending.split(/\r\n|\n|\r/);
      pending = parts.pop() ?? '';
      if (pending.length > 4000) { parts.push(pending); pending = ''; }
      for (const part of parts) line(part);
    },
    end() {
      if (pending) { line(pending); pending = ''; }
      closeBar();
      if (omitted) emit({ omitted });
      for (const text of tail.splice(0)) emit({ text: plainLine(text, secrets) });
      return { lines: count, omitted };
    },
  };
}

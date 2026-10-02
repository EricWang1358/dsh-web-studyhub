/* Where the learner was reading, and finding the same place again. Pure arithmetic over numbers the reader measures.

   A position is { sectionOffset, scrollTop, progress } plus the id of the outline entry (kept by the caller): how far the
   top of the viewport is below the top of its section, the scroll offset itself, and 0..1 through the text. The section
   leads when it can be found again (a different window width moves everything, but the section and the offset into it
   still point at the same words); the offset follows when it cannot, and the progress is the last resort. */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** The position to store. `sectionTop` is the section's top in the scroll area's own coordinates (null/undefined: unknown). */
export function captureAnchor({ scrollTop = 0, clientHeight = 0, scrollHeight = 0, sectionTop } = {}) {
  const range = scrollHeight - clientHeight;
  return { sectionOffset: Number.isFinite(sectionTop) ? Math.max(0, Math.round(scrollTop - sectionTop)) : 0,
    scrollTop: Math.max(0, Math.round(scrollTop)), progress: range > 0 ? Math.round(clamp(scrollTop / range, 0, 1) * 1000) / 1000 : 0 };
}

/** The scrollTop that shows the stored place again, never past the end of the text. */
export function restoreTop({ saved, sectionTop, clientHeight = 0, scrollHeight = 0 } = {}) {
  if (!saved) return 0;
  const max = Math.max(0, scrollHeight - clientHeight);
  const top = Number.isFinite(sectionTop) ? sectionTop + (saved.sectionOffset || 0)
    : saved.scrollTop > 0 ? saved.scrollTop : (saved.progress || 0) * max;
  return Math.round(clamp(top, 0, max));
}

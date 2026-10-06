/* The bundled Inter: digits and Latin letters only (owner decision 2026-10-06). Chinese keeps the system fonts, because the range
   below leaves every CJK block out and the browser falls through to the next family of the stack.

   Why: the design leans on large light numerals (--fs-4xl…--fs-10xl at --fw-light: the streak, today's count, scores), and "Inter" in
   the old stack was rarely installed on a Chinese Windows machine, so those digits rendered in Segoe UI or Microsoft YaHei.

   The file is Inter 4.x as published by @fontsource-variable/inter 5.3 (inter-latin-opsz-normal.woff2: Latin subset, axes wght
   100–900 and opsz 14–32, so large numerals take the Display cut by font-optical-sizing:auto; OFL 1.1, the licence is OFL.txt here).
   It is built into the client as a data: URI because DSH serves a plugin's client.*.js chunks only, and the standalone preview serves
   app.js/app.css only. The bytes live in ./inter-data.js (generated from the woff2 by build-inter-data.mjs, a plain JS string, so no
   bundler needs a font loader), loaded with a dynamic import: a chunk of its own that the host
   fetches only when StudyHub is opened, never in the activation path of every DSH page. One <style data-study-inter> carries the one
   @font-face; the family has a private name so it never collides with, or is shadowed by, an "Inter" installed on the machine.

   Which typefaces get it: the system stacks (--font-stack-system, --font-stack-system-display in tokens.css) list it first. The
   serif / kai / round / mono presets do not. A typed "my installed font" comes BEFORE the system stack (customFontStack in
   font-presets.js), so the person's font wins wherever it has a glyph and Inter only fills in what it lacks (digits in a Chinese-only font). */

export const INTER_FAMILY = 'StudyHub Inter';
export const INTER_STYLE_MARKER = 'study-inter';

/* Basic Latin, Latin-1 (without the interpunct U+00B7, which Chinese text uses between names and sets centred in a full-width box),
   dotless i, œ, modifier letters, thin space, en dash, bullet, per mille, primes, guillemets, fraction slash, euro, trade mark, arrows
   up and down (trends) and the true minus. Left to the CJK font on purpose: curly quotes, em dash and ellipsis (Chinese sets them
   full-width or centred), and all of U+2E80 and up (CJK, kana, full-width forms). */
export const INTER_UNICODE_RANGE = [
  'U+0020-007E', 'U+00A0-00B6', 'U+00B8-00FF', 'U+0131', 'U+0152-0153', 'U+02C6', 'U+02DA', 'U+02DC',
  'U+2009', 'U+2013', 'U+2022', 'U+2030', 'U+2032-2033', 'U+2039-203A', 'U+2044', 'U+20AC', 'U+2122', 'U+2191', 'U+2193', 'U+2212',
].join(', ');

/** The one @font-face rule for a woff2 URL (a data: URI in the build). */
export function interFaceCss(url) {
  return [
    '@font-face {',
    `  font-family: "${INTER_FAMILY}";`,
    '  font-style: normal;',
    '  font-display: swap;',
    '  font-weight: 100 900;',
    `  src: url("${url}") format("woff2");`,
    `  unicode-range: ${INTER_UNICODE_RANGE};`,
    '}',
  ].join('\n');
}

const loadData = () => import('./inter-data.js').then(module => module.default);

/** Put the @font-face into the document once. Idempotent (a marker element, replaced only if its text differs), and a font must never
    break the app: no document, a partial document, or a chunk that fails to load all leave the system fonts and resolve quietly.
    `document` and `load` are injectable for tests. */
export async function installInterFace({ document: doc = globalThis.document, load = loadData } = {}) {
  try {
    const head = doc?.head;
    if (!head || typeof head.querySelector !== 'function' || typeof head.appendChild !== 'function' || typeof doc.createElement !== 'function') return;
    const css = interFaceCss(await load());
    let element = head.querySelector(`style[data-${INTER_STYLE_MARKER}]`);
    if (element?.textContent === css) return;
    if (!element) {
      element = doc.createElement('style');
      element.setAttribute(`data-${INTER_STYLE_MARKER}`, '');
      head.appendChild(element);
    }
    element.textContent = css;
  } catch { /* the system stack stays */ }
}

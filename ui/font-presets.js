/* The typefaces of StudyHub, in one pure registry that the interface (设置 › 界面) and the reader (Aa) share. A preset is only an id, a zh
   label (passed through ui() where shown) and a reference to its stack; the stacks themselves are CSS variables defined ONCE in
   tokens.css (--font-stack-*), so no stylesheet repeats a long font list. The one font file that IS bundled (owner decision 2026-10-06)
   is Inter for digits and Latin letters only (ui/fonts/inter-face.js): it is the first family of the two system stacks, and its
   unicode-range excludes CJK, so Chinese stays on the system fonts. Every other typeface is a system stack or the name of a font the
   person has installed; serif, kai, round and mono do not include Inter, and a typed font name comes before the system stack, so the
   person's font wins and Inter only fills in what it lacks. */
const preset = (id, label) => Object.freeze({ label, stack: `var(--font-stack-${id})` });

export const FONT_PRESETS = Object.freeze({
  system: preset('system', '系统默认'),
  serif: preset('serif', '宋体 / 衬线'),
  kai: preset('kai', '楷体'),
  round: preset('round', '圆体'),
  mono: preset('mono', '等宽'),
});
export const FONT_IDS = Object.freeze(Object.keys(FONT_PRESETS));
/** The reader's faces: its `sans` (the first) follows the interface typeface, so a typed font reaches the reading text too. */
export const READER_FACES = Object.freeze(['sans', ...FONT_IDS.filter(id => id !== 'system')]);
/** Headings follow the chosen typeface, or stay on the system one. */
export const TITLE_MODES = Object.freeze(['follow', 'system']);
export const FONT_NAME_MAX = 40;

/** The name of an installed font as typed, or '' when it is not a plain name. Only letters (any script, so CJK too), digits, single
    spaces and hyphens inside, starting with a letter or digit: anything else is rejected whole, never repaired into something else. */
export function cleanFontName(raw) {
  if (typeof raw !== 'string') return '';
  const name = raw.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ');
  return name.length <= FONT_NAME_MAX && /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u.test(name) ? name : '';
}

/** `"Name", <system stack>` for the CSS variable --font-custom; the name is quoted and gated above, so it cannot leave the string. A font
    that is not installed simply falls through to the system stack. */
export function customFontStack(raw) {
  const name = cleanFontName(raw);
  return name ? `"${name}", ${FONT_PRESETS.system.stack}` : '';
}

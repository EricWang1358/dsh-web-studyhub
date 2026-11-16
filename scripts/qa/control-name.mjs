/* How the journey names a control (#1088), apart from the journey itself so a unit test can read it without starting a browser. */

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A control's accessible name as a pattern that does not hang on a typed glyph around its words. #1073 turns the typed → and ＋ into
 *  icons, which are not part of the name, and changes the en key with them: the pattern takes the words with or without the glyph, in
 *  either key, so the journey runs on both sides of that change. `t` is the journey's zh → UI-language lookup. */
export function controlName(t, zh) {
  const glyphFree = (text) => text.replace(/^\s*[＋+]\s*/, "").replace(/\s*→\s*$/, "");
  const words = [...new Set([zh, `${zh} →`, `＋ ${zh}`].map(t).map(glyphFree))];
  return new RegExp(`^\\s*[＋+]?\\s*(?:${words.map(escapeRe).join("|")})\\s*→?\\s*$`);
}

/* A deck's name never carries a number of questions (#199): the count changes as questions are added or dropped, and a number frozen into the
   name goes stale and misleads. The model sometimes writes one ("... (4 题)", the number of parts it saw taken for questions); this removes it from
   what the program names and from how existing names read. Pure. */

const UNIT = "(?:道题|个问题|题|questions?|cards?|items?)";
// "(4 题)", "（共 25 道题）", "[8 cards]" at the end; or a bare "· 8 题" / "- 15 questions" after a separator.
const BRACKETED = new RegExp(`[\\s·\\-—–:：,，]*[（(\\[【]\\s*(?:共\\s*|total\\s*)?\\d+\\s*${UNIT}\\s*[)）\\]】]\\s*$`, "i");
const BARE = new RegExp(`\\s*[·\\-—–:：]\\s*(?:共\\s*)?\\d+\\s*${UNIT}\\s*$`, "i");

/** The name without a trailing count of questions. A name that is only a count, or has nothing else, is returned as it is. */
export function cleanDeckTitle(title) {
  const original = String(title ?? "");
  let text = original.trim();
  for (let round = 0; round < 3; round++) {
    const next = text.replace(BRACKETED, "").replace(BARE, "").trim();
    if (next === text) break;
    text = next;
  }
  return text ? text : original;
}

/** The name a deck gets when the model gave none (a recovered fragment of its reply): the material's own display name, in the language of the request. Never a placeholder. */
export function fallbackDeckTitle(sources = [], language = "") {
  const english = /english/i.test(String(language ?? "")) && !/[㐀-鿿]/.test(String(language ?? ""));
  const names = (Array.isArray(sources) ? sources : []).map((source) => String(source?.title ?? "").replace(/\.(?:md|markdown|pdf|txt|docx?|html?|mp3|wav|m4a)$/i, "").trim()).filter(Boolean);
  if (!names.length) return english ? "New question set" : "新题组";
  const first = names[0].length > 60 ? `${names[0].slice(0, 59)}…` : names[0];
  if (names.length === 1) return first;
  return english ? `${first} and ${names.length - 1} more` : `${first} 等 ${names.length} 份资料`;
}

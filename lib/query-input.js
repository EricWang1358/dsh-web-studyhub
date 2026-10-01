


const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
};

function searchTerms(args) {
  const input = args.query ?? args.terms ?? args.q ?? args.keywords;
  const help = 'Give a query with at least one term of 2+ characters, e.g. {"query":"iframe"}. Accepted fields: query, terms, q, keywords (a string or array of strings).';
  if (typeof input !== "string" && !(Array.isArray(input) && input.every((term) => typeof term === "string")))
    throw new Error(help);
  const text = String(input ?? "");
  const raw = Array.isArray(input)
    ? input
    : /[|,，、"]|\sOR\s/i.test(text)
      ? text.replace(/"/g, "|").split(/\s*(?:\||,|，|、|\sOR\s)\s*/i)
      : text.split(/\s+/);
  const terms = [...new Set(raw.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 2))].slice(0, 12);
  if (!terms.length) throw new Error(help);
  return terms;
}

export { clampInt, searchTerms };

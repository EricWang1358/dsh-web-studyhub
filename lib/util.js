import { randomUUID } from "node:crypto";

export const id = () => randomUUID();

// Windows editors may prefix UTF-8 files with a BOM; JSON content stays strict.
export const parseStoredJson = (text) =>
  JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export const required = (v, label) => {
  if (typeof v !== "string" || !v.trim())
    throw new Error(`${label} is required`);
  return v.trim();
};

/** A missing record. The code lets callers (and the UI, through the host) tell it
 * from other failures without matching the message text. */
export const notFound = (message) => Object.assign(new Error(message), { code: "not-found" });

export const get = (items, id, label) => {
  const found = items.find((x) => x.id === id);
  if (!found) throw notFound(`${label} not found`);
  return found;
};

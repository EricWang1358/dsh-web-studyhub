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

export const get = (items, id, label) => {
  const found = items.find((x) => x.id === id);
  if (!found) throw new Error(`${label} not found`);
  return found;
};

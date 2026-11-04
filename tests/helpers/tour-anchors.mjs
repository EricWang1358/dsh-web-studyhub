/* The `data-tour` anchors the UI source renders, found by reading the source (no browser). One scan for every test that checks a list of
   anchors against the UI: the tour's steps (tests/wp5-tour-steps.test.mjs) and the feature finder's entries (tests/feature-finder-entries.test.mjs). */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NAV_DEFAULTS } from "../../ui/nav-order.js";

/** Every .js / .jsx / .mjs file under `dir`. */
export async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every `data-tour` anchor rendered by the UI source, including the nav items' `nav-${id}`. */
export async function anchorsInSource() {
  const anchors = new Set();
  for (const file of await sourceFiles("ui")) {
    const text = await readFile(file, "utf8");
    // JSX attributes (data-tour="x") and spread props ({ "data-tour": "x" }).
    for (const match of text.matchAll(/data-tour["']?\s*[=:]\s*["']([a-z0-9-]+)["']/g)) anchors.add(match[1]);
    // A settings section names its anchor with the tour prop of SettingsSection (rendered as data-tour).
    if (/\bSettingsSection\b/.test(text)) for (const match of text.matchAll(/\btour=["']([a-z0-9-]+)["']/g)) anchors.add(match[1]);
    if (/data-tour=\{`nav-\$\{id\}`\}/.test(text)) for (const id of Object.values(NAV_DEFAULTS).flat()) anchors.add(`nav-${id}`);
    // Tabs described as data ({ …, tour: "x" } rendered with data-tour={tab.tour}, ui/Generate.jsx).
    if (/data-tour=\{tab\.tour\}/.test(text)) for (const match of text.matchAll(/\btour:\s*["']([a-z0-9-]+)["']/g)) anchors.add(match[1]);
  }
  return anchors;
}

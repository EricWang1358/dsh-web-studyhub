/* 资料 keeps its filters, grouping and organizer behind 「筛选与分组」, which remembers being open (#1694). A test of what is in it starts from a learner who
   left it open (a static render), or presses the button (a browser walk). */

const KEY = root => `study-sources-tools-open:v1:${root || ''}`;

/** Run `draw()` with a browser store that says 「筛选与分组」 of the library at `root` was left open; the store there was before is put back. */
export function withOpenSourcesTools(root, draw) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const kept = new Map([[KEY(root), 'true']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => kept.get(key) ?? null, setItem: (key, value) => { kept.set(key, String(value)); }, removeItem: key => { kept.delete(key); } } });
  try { return draw(); } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before); else delete globalThis.localStorage;
  }
}

/** In a page showing 资料: open 「筛选与分组」 unless it is open already. */
export async function openSourcesTools(page) {
  const toggle = page.locator('.sources-page [data-tour="sources-tools"]');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

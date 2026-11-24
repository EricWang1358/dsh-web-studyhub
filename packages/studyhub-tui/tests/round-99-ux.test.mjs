// Round 99 documentation sync & CommandPalette/theme/density matrix tests:
// - Track C11: Docs sync (`docs/GUIDE.md`, `docs/KEYBINDINGS.md`, `docs/ASSISTANT-UX.md`) for Rounds 82-98
// - Track A17 & B12: CommandPalette unique command coverage across eye-care themes & density modes
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const [{ buildPaletteItems }, { DEFAULT_PREFERENCES }] = await Promise.all([
  import('../src/shell/CommandPalette.tsx'),
  import('../src/state/store.ts'),
]);

describe('Round 99 Track C11 — Documentation Sync for Rounds 82–98', () => {
  const guide = fs.readFileSync(path.join(pkgRoot, 'docs/GUIDE.md'), 'utf8');
  const keys = fs.readFileSync(path.join(pkgRoot, 'docs/KEYBINDINGS.md'), 'utf8');
  const ux = fs.readFileSync(path.join(pkgRoot, 'docs/ASSISTANT-UX.md'), 'utf8');

  it('documents eye-care themes, /density, /proactive, /pin, /terminal, exam planner & assistant memory', () => {
    for (const token of ['warm-amber', 'soft-sage', '/density', '/proactive', '/pin', '/terminal', 'Ctrl+Space', 'DEC 1004']) {
      assert.ok(guide.includes(token), `docs/GUIDE.md missing "${token}"`);
    }
    for (const token of ['/density', '/proactive', '/pin', '/terminal', 'warm-amber', 'soft-sage', 'renderExamScheduleTable', 'renderStatTable']) {
      assert.ok(keys.includes(token), `docs/KEYBINDINGS.md missing "${token}"`);
    }
    for (const token of ['assistant-workflow.ts', 'assistant-memory.ts', '/proactive', '25 题']) {
      assert.ok(ux.includes(token), `docs/ASSISTANT-UX.md missing "${token}"`);
    }
  });
});

describe('Round 99 Track A17 & B12 — CommandPalette Full Action Coverage Across Eye-Care & Density Modes', () => {
  it('emits unique command IDs including /density, /proactive, /terminal, /pin across themes and languages', () => {
    const noop = () => {};
    const actions = {
      loadSample: noop,
      refresh: noop,
      setCourse: noop,
      openImport: noop,
      openModelSettings: noop,
      startDueReview: noop,
      recoverInterrupted: noop,
      quit: noop,
    };

    for (const lang of ['zh', 'en']) {
      for (const theme of ['warm-amber', 'soft-sage']) {
        for (const compactMode of [false, true]) {
          const items = buildPaletteItems(
            {
              page: 'examprep',
              snapshot: null,
              activeRunId: null,
              preferences: { ...DEFAULT_PREFERENCES, language: lang, theme, compactMode },
              navigate: noop,
              setTheme: noop,
              setLanguage: noop,
              toggleSidebar: noop,
              setHelpOpen: noop,
              setVoicePackOpen: noop,
              setCoursePickerOpen: noop,
              setInboxOpen: noop,
              setPreferences: noop,
              notify: noop,
              goBack: noop,
            },
            actions,
          );
          const ids = items.map((x) => x.id);
          assert.equal(new Set(ids).size, ids.length, `Duplicate palette ids for ${lang}/${theme}/${compactMode}`);
          for (const requiredId of ['cmd:density', 'cmd:proactive', 'cmd:terminal', 'cmd:pin', 'cmd:guide']) {
            assert.ok(ids.includes(requiredId), `Missing palette item ${requiredId}`);
          }
        }
      }
    }
  });
});

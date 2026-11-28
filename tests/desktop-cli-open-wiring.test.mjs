import test from 'node:test';
import assert from 'node:assert/strict';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* 「在学习库里打开 agy / codex」 end to end through the real setup panel: DesktopModelSetup reads the saved config and the app core, the button copies
   the opening note, and the card shows what came back. The unit tests cover each piece; this one catches a piece that is not plugged in
   (the panel building its actions without the note's paths, or the row dropping the answer). */
const ui = await loadInteractiveUi(`
  export { default as DesktopModelSetup } from './ui/desktop/DesktopModelSetup.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = ui.React.createElement;
const { DesktopModelSetup, AppContext, setUiLanguage } = ui.exports;

const NODE = String.raw`D:\App\resources\runtime\node\node.exe`;
const STUDY_CLI = String.raw`D:\App\resources\runtime\scripts\study-cli.mjs`;
const LIBRARY = String.raw`D:\Study`;
const CONFIG = {
  mode: 'openai',
  effective: { ready: true },
  studyCliPath: STUDY_CLI,
  studyNodePath: NODE,
  agy: {},
  codex: {},
  providers: [{ id: 'agy', name: 'agy', supported: true, status: 'ready', version: '1.0.0' }],
};

const buttonByText = (mounted, pattern) => mounted.find((node) => node.type === 'button' && pattern.test(mounted.text(node).trim()));

async function withClipboard(clipboard, fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
}

async function openAgyFromSettings(clipboard) {
  const calls = [];
  const core = {
    call: async (action, args) => {
      calls.push({ action, args });
      if (action === 'desktop.config.get') return CONFIG;
      if (action === 'desktop.cli.open') return { ok: true, provider: args.provider, cwd: LIBRARY };
      return {};
    },
    refresh: async () => {},
    refs: { bindingRoot: { current: LIBRARY }, dataRef: { current: null } },
  };
  return withClipboard(clipboard, () => withBrowserGlobals(async () => {
    setUiLanguage('zh');
    const mounted = ui.mount(() => h(AppContext.Provider, { value: { core } }, h(DesktopModelSetup)));
    try {
      await mounted.flush(6);
      const button = buttonByText(mounted, /^在学习库里打开 agy$/);
      assert.ok(button, 'Settings offers 「在学习库里打开 agy」 for the ready CLI');
      await mounted.act(async () => { await click(button); });
      await mounted.flush(6);
      return { calls, text: mounted.text(), textarea: mounted.find((node) => node.type === 'textarea') };
    } finally {
      mounted.unmount();
    }
  }));
}

test('Settings 「在学习库里打开 agy」 copies the opening note with the bundled node, study-cli and --root, then the card says it was copied', async () => {
  const copied = [];
  const { calls, text, textarea } = await openAgyFromSettings({ writeText: async (note) => { copied.push(note); } });
  assert.equal(copied.length, 1, 'the note was copied once');
  assert.ok(copied[0].includes(`"${NODE}" "${STUDY_CLI}" call <action>`), 'the note runs the bundled study-cli with the bundled node');
  assert.ok(copied[0].includes(`--root "${LIBRARY}"`), 'the note names the bound library');
  assert.deepEqual(calls.filter((entry) => entry.action === 'desktop.cli.open'), [{ action: 'desktop.cli.open', args: { provider: 'agy' } }], 'the page still sends only the CLI name');
  assert.match(text, /已在学习库目录打开 agy；开场提示已复制/, 'the card shows the copied receipt');
  assert.equal(textarea, null, 'a copied note is not also shown');
});

test('Settings 「在学习库里打开 agy」 shows the opening note to select when the clipboard refuses', async () => {
  const { text, textarea } = await openAgyFromSettings({ writeText: async () => { throw new Error('Document is not focused.'); } });
  assert.match(text, /没能复制开场提示/);
  assert.ok(textarea, 'the note is shown in a text box to copy by hand');
  assert.ok(String(textarea.props.value).includes(`"${NODE}" "${STUDY_CLI}" call <action>`), 'the shown note is the same note');
  assert.ok(String(textarea.props.value).includes(`--root "${LIBRARY}"`));
});

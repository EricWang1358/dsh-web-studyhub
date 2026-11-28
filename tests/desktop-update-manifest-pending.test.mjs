import test from 'node:test';
import assert from 'node:assert/strict';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* 5.4.2: the update check announced 5.4.2 while release-desktop.yml was still uploading, so the Tauri updater's manifest
   (releases/latest/download/latest.json) answered 404 and 一键更新 showed tauri-plugin-updater's raw English
   "Could not fetch a valid release JSON from the remote". A manifest that cannot be fetched, or one older than the announced
   version, is said plainly; every other updater failure still shows its own message. */

const RAW_404 = 'failed to check for desktop update: Could not fetch a valid release JSON from the remote';
const RAW_NETWORK = 'failed to check for desktop update: error sending request for url (https://github.com/x/latest.json)';

const ui = await loadInteractiveUi(`
  export { default as DesktopUpgradeGuide } from './ui/desktop/DesktopUpgradeGuide.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = ui.React.createElement;
const update = { latest: '5.4.2', current: '5.4.1', setupName: 'StudyHub-Desktop-5.4.2-win-x64-setup.exe', setupUrl: 'https://example.com/setup.exe' };

async function afterClick({ install, language = 'zh', view = update }) {
  let text = '', manual = null, open = null;
  await withBrowserGlobals(async () => {
    ui.exports.setUiLanguage(language);
    const host = { capabilities: { edition: 'desktop' }, updater: { check: async () => ({}), install } };
    const mounted = ui.mount(() => h(ui.exports.DesktopUpgradeGuide, { update: view, host }));
    try {
      const button = mounted.find(node => node.type === 'button');
      await mounted.act(() => click(button));
      await mounted.act(async () => { await new Promise(resolve => setImmediate(resolve)); });
      text = mounted.text();
      const details = mounted.find(node => node.type === 'details');
      manual = !!details;
      open = details?.props?.open;
      const box = mounted.find(node => node.props && 'data-desktop-auto-update' in node.props);
      text = `${box?.props['data-desktop-auto-update']}|${text}`;
    } finally { mounted.unmount(); ui.exports.setUiLanguage('zh'); }
  });
  return { text, manual, open };
}

test('a manifest GitHub cannot serve yet reads as "still uploading", not as the raw Tauri error', async () => {
  const zh = await afterClick({ install: async () => { throw RAW_404; } });
  assert.match(zh.text, /^pending\|/);
  assert.match(zh.text, /桌面安装包还在上传，几分钟后再试/);
  assert.match(zh.text, /5\.4\.2/);
  assert.match(zh.text, /重试自动更新/, 'the button retries');
  assert.doesNotMatch(zh.text, /Could not fetch|failed to check|自动更新没有完成/);
  assert.equal(zh.manual, true, 'the manual download fold stays');
  assert.notEqual(zh.open, true, 'not forced open: the manual links wait for the same upload');

  const en = await afterClick({ install: async () => { throw new Error(RAW_404); }, language: 'en' });
  assert.match(en.text, /still being uploaded/i);
  assert.doesNotMatch(en.text, /Could not fetch|failed to check/);
  assert.doesNotMatch(en.text, /[㐀-鿿]/, 'no untranslated Chinese');
});

test('a manifest older than the announced version (the updater says up to date) reads the same way', async () => {
  const older = await afterClick({ install: async () => ({ status: 'up-to-date', version: '5.4.1' }) });
  assert.match(older.text, /^pending\|/);
  assert.match(older.text, /桌面安装包还在上传，几分钟后再试/);
  // Nothing newer announced: the existing "already up to date" wording stands.
  const same = await afterClick({ install: async () => ({ status: 'up-to-date', version: '5.4.2' }), view: { ...update, current: '5.4.2' } });
  assert.match(same.text, /^up-to-date\|/);
  assert.match(same.text, /当前已是最新可自动更新版本/);
});

test('other updater failures still show their own error with the manual download opened', async () => {
  const other = await afterClick({ install: async () => { throw RAW_NETWORK; } });
  assert.match(other.text, /^error\|/);
  assert.match(other.text, /自动更新没有完成/);
  assert.match(other.text, /error sending request/, 'a real error is not hidden');
  assert.doesNotMatch(other.text, /还在上传/);
  assert.equal(other.open, true);
});

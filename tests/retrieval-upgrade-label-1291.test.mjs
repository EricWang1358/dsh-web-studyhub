import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  INDEX_KEY_VERSION,
  INDEX_TOOLS,
  buildIndex,
  contentHash,
  planIndex,
} from '../lib/retrieval-index.js';
import { documentIndexState } from '../ui/index-coverage.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as IndexBadge, indexLabel, indexShortLabel } from './ui/IndexBadge.jsx';
      export { indexTip, courseScopeLine, indexAction } from './ui/index-scope.js';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text', '.json': 'json' },
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { IndexBadge, indexLabel, indexShortLabel, indexTip, courseScopeLine, indexAction, setUiLanguage } = mod.exports;

test('#1291: planIndex & buildIndex distinguish format-upgrade pages (upgraded) from new/edited pages (added)', async () => {
  const lib = '0123456789abcdef';
  const s1 = { id: 'p1', title: 'Unchanged v1', text: 'Same text before and after upgrade.' };
  const s2 = { id: 'p2', title: 'Edited v1', text: 'New edited content here.' };
  const s3 = { id: 'p3', title: 'Brand new', text: 'Fresh page never indexed.' };
  const manifest = {
    keyVersion: 1,
    libraryId: lib,
    sources: {
      p1: { hash: contentHash(s1.text), at: '2026-10-01T00:00:00.000Z' },
      p2: { hash: contentHash('Old content before edit.'), at: '2026-10-01T00:00:00.000Z' },
    },
  };
  const plan = planIndex({ sources: [s1, s2, s3], library: ['p1', 'p2', 'p3'], manifest, libraryId: lib });
  assert.deepEqual(plan.add.map(s => s.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(plan.migrate.map(s => s.id), ['p1'], 'only unchanged v1 page is in migrate');

  const port = {
    tools: () => [{ name: INDEX_TOOLS.ingest, parameters: { type: 'object', properties: {} } }],
    async call() { return { content: [{ type: 'text', text: '{"ok":true}' }] }; },
  };
  const summary = await buildIndex({ port, sources: [s1, s2, s3], library: ['p1', 'p2', 'p3'], manifest, libraryId: lib });
  assert.equal(summary.upgraded, 1);
  assert.equal(summary.added, 2);
  assert.equal(manifest.keyVersion, INDEX_KEY_VERSION);
});

test('#1291: badge, hover, course line & button never say "edited" for format-upgrade-only pages and split counts when mixed', () => {
  const item = { key: 'doc', sourceIds: ['a', 'b', 'c', 'd'] };

  // 1. Format upgrade only (0 edited, 4 migrate)
  const upgradeOnly = documentIndexState(item, { indexed: [], stale: [], migrate: ['a', 'b', 'c', 'd'], missing: [] });
  assert.deepEqual([upgradeOnly.state, upgradeOnly.stale, upgradeOnly.migrate], ['stale', 0, 4]);
  const upgradeLabel = indexLabel(upgradeOnly, { canIndex: true });
  assert.doesNotMatch(upgradeLabel, /改过/);
  assert.match(upgradeLabel, /正文没有改/);
  assert.match(indexShortLabel(upgradeOnly, { canIndex: true }), /4 页待升级/);
  const upgradeTip = indexTip(upgradeOnly).join('\n');
  assert.doesNotMatch(upgradeTip, /编目录之后改过/);
  assert.match(upgradeTip, /正文没有改.*不调用 AI/);

  // 2. Edited only (1 stale, 0 migrate) keeps existing wording
  const editedOnly = documentIndexState(item, { indexed: ['a', 'b', 'c'], stale: ['d'], migrate: [], missing: [] });
  assert.equal(indexLabel(editedOnly, { canIndex: true }), '索引需要更新 · 这份资料有 1 页改过');

  // 3. Mixed (1 edited + 2 format upgrade) splits both numbers clearly
  const mixed = documentIndexState(item, { indexed: ['a'], stale: ['b'], migrate: ['c', 'd'], missing: [] });
  assert.deepEqual([mixed.state, mixed.stale, mixed.migrate], ['stale', 1, 2]);
  assert.match(indexLabel(mixed, { canIndex: true }), /1 页改过，2 页待升级格式/);
  assert.match(indexTip(mixed).join('\n'), /1 页.*改过.*2 页.*升级/);

  // 4. Course scope line & button say "待升级" instead of "还没建索引" / "补建"
  const courseUpgradeLine = courseScopeLine({ pages: 10, documents: 1, toIndex: 4, toAdd: 0, toUpgrade: 4, unchanged: 6, skipped: 0, toRemove: 0, missing: [], missingDocuments: 0 }, 'OS');
  assert.doesNotMatch(courseUpgradeLine, /还没建索引/);
  assert.match(courseUpgradeLine, /4 页待升级索引格式（正文没有改）/);
  const action = indexAction({
    plan: { pages: 10, toIndex: 4, toAdd: 0, toUpgrade: 4 },
    document: { info: { state: 'indexed', total: 6 }, courses: ['OS'] },
    course: 'OS',
    names: ['OS'],
  });
  assert.match(action.label, /升级 4 页索引格式/);

  // 5. English translations have zero CJK characters
  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(IndexBadge, { info: upgradeOnly, coverage: { canIndex: true } }));
    assert.match(enHtml, /content unchanged/);
    assert.doesNotMatch(enHtml, /edited/);
    assert.doesNotMatch(enHtml, /[㐀-鿿]/);
    const enMixed = indexLabel(mixed, { canIndex: true });
    assert.match(enMixed, /1 page edited, 2 awaiting format upgrade/);
    assert.doesNotMatch(enMixed, /[㐀-鿿]/);
  } finally {
    setUiLanguage('zh');
  }
});

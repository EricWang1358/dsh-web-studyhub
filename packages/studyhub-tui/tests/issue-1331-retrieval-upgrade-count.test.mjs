// #1291 / #1331: `retrieval.index.coverage` lists pages whose text is unchanged but whose index key format is old under
// `migrate`, no longer under `stale`. The settings row must still count them, or a library that only awaits the upgrade
// reads as "no pages".
//
// node --test tests/issue-1331-retrieval-upgrade-count.test.mjs
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const { describeRetrievalCoverage } = await import('../src/views/settings/WorkspaceTab.tsx');

const ids = (n, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const coverage = (parts = {}) => ({ indexed: [], stale: [], missing: [], hasIndex: true, canIndex: true, building: false, ...parts });

describe('settings retrieval row counts pages awaiting an index format upgrade', () => {
  test('a library where every page awaits the upgrade is not shown as empty', () => {
    const zh = describeRetrievalCoverage(coverage({ migrate: ids(12) }), 'zh', false);
    assert.equal(zh, '索引 0/12 · 待升级 12');
    const en = describeRetrievalCoverage(coverage({ migrate: ids(12) }), 'en', true);
    assert.equal(en, 'Idx 0/12, 12 to upgrade');
  });

  test('pages to upgrade are part of the total next to indexed, edited and missing pages', () => {
    const label = describeRetrievalCoverage(
      coverage({ indexed: ids(5, 'i'), stale: ids(2, 's'), missing: ids(1, 'm'), migrate: ids(3, 'g') }),
      'zh',
      false,
    );
    assert.equal(label, '索引 5/11 · 过期 2 · 待升级 3');
  });

  test('a reply without the field reads as before', () => {
    assert.equal(describeRetrievalCoverage(coverage({ indexed: ids(4), stale: ids(1, 's') }), 'zh', false), '索引 4/5 · 过期 1');
    assert.equal(describeRetrievalCoverage(coverage(), 'zh', false), '无资料');
    assert.equal(describeRetrievalCoverage(null, 'zh', false), '');
  });
});

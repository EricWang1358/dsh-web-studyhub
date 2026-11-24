// Regression test for #1418: TUI DocumentReader must follow `next.offset` on
// `source.pages` (and paginate `source.get` fallback) so single pages exceeding
// ~6000 chars load completely, and must append an explicit tail notice if a
// follow-up chunk fails instead of pretending the page ended cleanly.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { after, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ StudyService }, readerMod] = await Promise.all([
  import('../../../lib/service.js'),
  import('../src/views/sources/DocumentReader.tsx'),
]);

test('#1418: fetchFullSourcePage reads all chunks of a >15000-char single page from real StudyService', async (t) => {
  assert.equal(typeof readerMod.fetchFullSourcePage, 'function', 'DocumentReader should export fetchFullSourcePage');
  const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1418-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));

  const service = new StudyService(root);
  const head = '# 长资料开头\n\n';
  const middle = '这是一段用于测试超过六千字单页完整读取的正文内容。'.repeat(650);
  const tail = '\n\n## 结尾字符画\n```\n+--- COMPLETE_TAIL_MARKER_1418 ---+\n```';
  const fullText = head + middle + tail;
  assert.ok(fullText.length > 15000, `fixture must exceed 15k chars (got ${fullText.length})`);

  const added = await service.call('source.add', {
    title: '超长单页讲义.md',
    text: fullText,
    courses: ['系统设计'],
  });

  const calls = [];
  const host = {
    call: async (name, args) => {
      calls.push({ name, args });
      try {
        return { ok: true, value: await service.call(name, args) };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
  };

  const res = await readerMod.fetchFullSourcePage(host, {
    sourceId: added.id,
    from: 1,
    lang: 'zh',
  });

  assert.equal(res.ok, true);
  assert.equal(res.truncated, false);
  assert.equal(res.text, fullText, 'assembled page text must equal the full source text');
  assert.ok(res.text.includes('COMPLETE_TAIL_MARKER_1418'), 'tail marker must be present');
  assert.ok(calls.length >= 3, `expected >= 3 source.pages chunk calls, got ${calls.length}`);
  assert.equal(calls[0].args.offset, undefined);
  assert.ok(typeof calls[1].args.offset === 'number' && calls[1].args.offset > 0);
});

test('#1418: mid-page chunk failure appends explicit tail warning instead of pretending page is complete', async () => {
  assert.equal(typeof readerMod.fetchFullSourcePage, 'function');
  let callCount = 0;
  const host = {
    call: async (_name, args) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          value: {
            documentId: 'doc-1',
            title: '长文档',
            pages: '1-1',
            shown: [{ page: 1, sourceId: 's-1', chars: 12000, text: 'A'.repeat(6000) }],
            next: { from: 1, offset: 6000 },
          },
        };
      }
      assert.equal(args.offset, 6000);
      return { ok: false, error: { message: 'disk read error' } };
    },
  };

  const zh = await readerMod.fetchFullSourcePage(host, { documentId: 'doc-1', from: 1, lang: 'zh' });
  assert.equal(zh.ok, true);
  assert.equal(zh.truncated, true);
  assert.match(zh.text, /后面的内容没有读出来/, 'zh failure must explicitly warn at tail');
  assert.ok(zh.text.startsWith('A'.repeat(6000)), 'already-read prefix is preserved');

  callCount = 0;
  const en = await readerMod.fetchFullSourcePage(host, { documentId: 'doc-1', from: 1, lang: 'en' });
  assert.equal(en.ok, true);
  assert.equal(en.truncated, true);
  assert.match(en.text, /could not be loaded|remaining content/i, 'en failure must explicitly warn at tail');
});

test('#1418: fetchFullSourceGet paginates fallback source.get beyond 20000 chars and warns on partial failure', async () => {
  assert.equal(typeof readerMod.fetchFullSourceGet, 'function', 'DocumentReader should export fetchFullSourceGet');
  const full = 'X'.repeat(20000) + 'Y'.repeat(20000) + 'TAIL_END_45K';
  const offsets = [];
  const host = {
    call: async (name, args) => {
      assert.equal(name, 'source.get');
      offsets.push(args.offset);
      const off = Number(args.offset || 0);
      const lim = Math.min(Number(args.limit || 20000), 20000);
      return {
        ok: true,
        value: {
          id: 's-big',
          title: '大文本',
          chars: full.length,
          offset: off,
          text: full.slice(off, off + lim),
        },
      };
    },
  };

  const complete = await readerMod.fetchFullSourceGet(host, { id: 's-big', lang: 'zh' });
  assert.equal(complete.ok, true);
  assert.equal(complete.truncated, false);
  assert.equal(complete.text, full);
  assert.deepEqual(offsets, [0, 20000, 40000]);

  let count = 0;
  const flakyHost = {
    call: async (_name, args) => {
      count += 1;
      if (count === 1) {
        return {
          ok: true,
          value: { id: 's-big', title: '大文本', chars: 35000, offset: 0, text: 'B'.repeat(20000) },
        };
      }
      assert.equal(args.offset, 20000);
      return { ok: false, error: { message: 'timeout' } };
    },
  };
  const partial = await readerMod.fetchFullSourceGet(flakyHost, { id: 's-big', lang: 'zh' });
  assert.equal(partial.ok, true);
  assert.equal(partial.truncated, true);
  assert.match(partial.text, /后面的内容没有读出来/);
});

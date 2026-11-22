// Unit tests for streaming buffer coalescing: `node --test tests/streaming-buffer.test.mjs`
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { createStreamingCoalescer } = await tsImport(
  '../src/components/useStreamingBuffer.ts',
  import.meta.url,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createStreamingCoalescer', () => {
  test('coalesces 200 rapid-burst chunks to >80% fewer flushes and preserves CJK + emoji output', async () => {
    const flushes = [];
    const coalescer = createStreamingCoalescer((text) => {
      flushes.push(text);
    }, 24);

    const chunks = Array.from({ length: 200 }, (_, i) => {
      if (i % 5 === 0) return `知识点${i}🚀`;
      if (i % 3 === 0) return `·推导(${i}) `;
      return `tok_${i}|`;
    });
    const expected = chunks.join('');

    // Synchronous burst of 200 chunks
    for (const chunk of chunks) {
      coalescer.push(chunk);
    }
    assert.equal(flushes.length, 0, 'should not flush synchronously before interval elapses');
    assert.equal(coalescer.getText(), expected);

    await sleep(45);

    assert.ok(
      flushes.length <= 10,
      `expected <= 10 flushes (>80% reduction vs 200 pushes), got ${flushes.length}`,
    );
    assert.equal(flushes.at(-1), expected, 'concatenated CJK + emoji output must match exactly');
    coalescer.dispose();
  });

  test('coalesces 200 micro-spaced chunks across ~100ms into <= 10 flushes', async () => {
    const flushes = [];
    const coalescer = createStreamingCoalescer((text) => {
      flushes.push(text);
    }, 24);

    const parts = [];
    for (let i = 0; i < 200; i += 1) {
      const chunk = i % 2 === 0 ? `段${i}✨` : `w${i} `;
      parts.push(chunk);
      coalescer.push(chunk);
      if (i % 40 === 39) {
        await sleep(5);
      }
    }
    const final = coalescer.finish();
    const expected = parts.join('');

    assert.equal(final, expected);
    assert.ok(
      flushes.length <= 10,
      `expected <= 10 flushes (>95% reduction vs 200 pushes), got ${flushes.length}`,
    );
    assert.equal(flushes.at(-1), expected);
    coalescer.dispose();
  });

  test('finish() and flush() synchronously deliver remaining buffered text with zero pending timers', async () => {
    const flushes = [];
    const coalescer = createStreamingCoalescer((text) => {
      flushes.push(text);
    }, 50);

    coalescer.push('Hello ');
    coalescer.push('世界 ');
    coalescer.push('🎓');
    assert.equal(flushes.length, 0);

    const out = coalescer.finish();
    assert.equal(out, 'Hello 世界 🎓');
    assert.deepEqual(flushes, ['Hello 世界 🎓']);

    // Subsequent flush/finish when clean should be a no-op and no timer should fire later.
    assert.equal(coalescer.flush(), 'Hello 世界 🎓');
    assert.equal(coalescer.finish(), 'Hello 世界 🎓');
    await sleep(75);
    assert.equal(flushes.length, 1, 'no stray timer should fire after finish()');
    coalescer.dispose();
  });

  test('set() coalesces full-text updates and finish() flushes synchronously', () => {
    const flushes = [];
    const coalescer = createStreamingCoalescer((text) => {
      flushes.push(text);
    }, 30);

    coalescer.set('draft 1');
    coalescer.set('draft 2 中文');
    coalescer.set('final 🎯');
    assert.equal(flushes.length, 0);

    assert.equal(coalescer.finish(), 'final 🎯');
    assert.deepEqual(flushes, ['final 🎯']);
    coalescer.dispose();
  });

  test('reset() and dispose() cancel pending timers so nothing fires after abort or unmount', async () => {
    const resetFlushes = [];
    const c1 = createStreamingCoalescer((text) => {
      resetFlushes.push(text);
    }, 20);
    c1.push('aborted-chunk-1');
    c1.push('aborted-chunk-2');
    c1.reset();
    assert.equal(c1.getText(), '');

    const disposeFlushes = [];
    const c2 = createStreamingCoalescer((text) => {
      disposeFlushes.push(text);
    }, 20);
    c2.push('unmounted-chunk');
    c2.dispose();
    // Pushes after dispose must be ignored
    c2.push('ignored-after-dispose');

    await sleep(50);

    assert.equal(resetFlushes.length, 0, 'timer must be cancelled after reset()');
    assert.equal(disposeFlushes.length, 0, 'timer must be cancelled after dispose()');
  });
});

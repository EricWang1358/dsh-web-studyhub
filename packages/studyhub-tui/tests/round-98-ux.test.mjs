// Round 98 comprehensive behavior, scale & accessibility tests:
// - Track D11: Structured assistant session memory pruning (`pruneTurnsWithSummary`)
// - Track A16: Large-scale throughput for `renderStatTable` (500 rows) & `VirtualList` windowing (1,000 items)
// - Track B11: All-6-theme WCAG AA/AAA contrast + keyboard-first zero-dead-end verification
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [memMod, chartsMod, cjkMod, tokensMod, intentMod, vlistMod] = await Promise.all([
  import('../src/shell/assistant-memory.ts'),
  import('../src/render/charts.ts'),
  import('../src/render/cjk.ts'),
  import('../src/theme/tokens.ts'),
  import('../src/shell/assistant-intent.ts'),
  import('../src/components/VirtualList.tsx'),
]);

const { pruneTurnsWithSummary } = memMod;
const { renderStatTable } = chartsMod;
const { displayWidth } = cjkMod;
const { getTheme } = tokensMod;
const { parseAssistantIntent, buildFallbackPrompt } = intentMod;
const { nextScrollOffset } = vlistMod;

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function contrastRatio(hexA, hexB) {
  const lum = (hex) => {
    const clean = hex.replace('#', '');
    const rgb = [0, 2, 4].map((i) => {
      const c = parseInt(clean.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const [l1, l2] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('Round 98 Track D11 — Structured Assistant Memory Pruning', () => {
  it('condenses evicted turns into a bounded summary header while strictly capping total length', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      id: `t-${i}`,
      at: 1000 + i,
      role: i % 2 === 0 ? 'user' : 'assistant',
      stage: i < 5 ? 'question' : 'retell',
      actionSummary: i % 3 === 0 ? `已完成：动作#${i}` : undefined,
      text: `第 ${i + 1} 轮问题关于操作系统页表与虚拟内存机制`,
    }));

    const pruned = pruneTurnsWithSummary(turns, 24, 'zh');
    assert.equal(pruned.length, 24);
    assert.equal(pruned[0].id, 'assistant-memory-summary');
    assert.match(pruned[0].actionSummary, /已压缩 7 条/);
    assert.match(pruned[0].text, /阶段/);
    assert.ok(pruned[0].text.length <= 220);
    assert.equal(pruned[pruned.length - 1].id, 't-29');

    // Re-pruning after adding more turns accumulates compressed count cleanly without nesting summaries
    const extended = [
      ...pruned,
      { id: 't-30', at: 2000, role: 'user', text: '继续追问 TLB 命中率' },
      { id: 't-31', at: 2001, role: 'assistant', text: 'TLB 是高速缓存。' },
    ];
    const rePruned = pruneTurnsWithSummary(extended, 24, 'zh');
    assert.equal(rePruned.length, 24);
    assert.equal(rePruned[0].id, 'assistant-memory-summary');
    assert.match(rePruned[0].actionSummary, /已压缩 9 条/);
  });
});

describe('Round 98 Track A16 — Large-Scale Stat Table & VirtualList Performance', () => {
  it('renders 500 mixed CJK+ASCII stat table rows in < 200ms with exact width invariant', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      course: i % 2 === 0 ? `操作系统原理第${i + 1}章` : `Algorithms Module ${i + 1}`,
      cards: 20 + (i % 80),
      due: i % 15,
      mastery: `${(i * 7) % 100}%`,
    }));
    const cols = [
      { key: 'course', label: '课程', align: 'left', minWidth: 10 },
      { key: 'cards', label: '题数', align: 'right', width: 5 },
      { key: 'due', label: '到期', align: 'right', width: 5 },
      { key: 'mastery', label: '掌握', align: 'right', width: 6 },
    ];
    const t0 = performance.now();
    const lines = renderStatTable(cols, rows, 76, getTheme('warm-amber'), { ascii: false });
    const elapsedMs = performance.now() - t0;

    assert.equal(lines.length, 502); // header + rule + 500 rows
    assert.ok(elapsedMs < 200, `renderStatTable(500 rows) took ${elapsedMs.toFixed(1)}ms`);
    for (let i = 0; i < lines.length; i += 25) {
      assert.equal(displayWidth(stripAnsi(lines[i])), 76);
    }

    // VirtualList O(1) window offset across 1,000 items
    let offset = 0;
    const t1 = performance.now();
    for (let sel = 0; sel < 1000; sel += 1) {
      offset = nextScrollOffset(sel, offset, 20, 1000);
      assert.ok(sel >= offset && sel < offset + 20);
    }
    assert.ok(performance.now() - t1 < 50);
  });
});

describe('Round 98 Track B11 — All-6-Themes WCAG Accessibility & Zero Dead Ends', () => {
  it('passes WCAG AA on all 6 themes (AAA on high-contrast) and never dead-ends out-of-scope prompts', () => {
    const themeIds = ['dsh-dark', 'warm-paper', 'nord', 'high-contrast', 'warm-amber', 'soft-sage'];
    for (const id of themeIds) {
      const th = getTheme(id);
      assert.equal(th.id, id, `Missing theme ${id}`);
      const textOnBg = contrastRatio(th.text, th.bg);
      const textOnSurface = contrastRatio(th.text, th.surface);
      const mutedOnBg = contrastRatio(th.muted, th.bg);
      assert.ok(textOnBg >= 4.5, `${id} text/bg contrast ${textOnBg.toFixed(2)} < 4.5`);
      assert.ok(textOnSurface >= 4.5, `${id} text/surface contrast ${textOnSurface.toFixed(2)} < 4.5`);
      assert.ok(mutedOnBg >= 3.0, `${id} muted/bg contrast ${mutedOnBg.toFixed(2)} < 3.0`);
      if (id === 'high-contrast') {
        assert.ok(textOnBg >= 7.0, `high-contrast text/bg ${textOnBg.toFixed(2)} < 7.0`);
      }
    }

    // Zero dead-end verification across all unsupported categories
    for (const raw of ['帮我发邮件给同学', '帮我格式化硬盘', '执行 rm -rf /', '帮我查明天天气']) {
      const intent = parseAssistantIntent(raw, { lang: 'zh' });
      assert.equal(intent.kind, 'boundary', `Expected boundary for "${raw}"`);
      assert.ok(intent.alternativeLabel.length > 0);
      assert.ok(intent.alternativeCommand.length > 0);
      const prompt = buildFallbackPrompt({ instruction: raw, course: 'OS', lang: 'zh' });
      assert.match(prompt, /课程：OS/);
    }

    // #1340: normal study questions containing keywords like 格式化 / 发消息 / step 2 / 过去统计 must route to chat
    for (const q of [
      '什么是格式化字符串',
      '进程间发消息是怎么实现的？',
      'wechat 和 telegram 的加密协议有什么区别？',
      'step 2',
      'app 3',
      '第3页提到的格式化字符串是什么？',
      '过去统计的方法有哪些？',
    ]) {
      const intent = parseAssistantIntent(q, { lang: 'zh' });
      assert.equal(intent.kind, 'chat', `Expected chat for normal study question "${q}", got ${intent.kind}`);
    }
  });
});

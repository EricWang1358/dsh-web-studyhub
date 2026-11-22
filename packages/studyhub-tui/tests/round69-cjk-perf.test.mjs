// Round 69 Track 1: Bit-exact CJK/emoji/ANSI correctness + fast-path throughput benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import stripAnsi from 'strip-ansi';
import { eastAsianWidth } from 'get-east-asian-width';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r69-cjk-'));
const renderOutFile = path.join(tempOutDir, 'render.mjs');
await build({
  entryPoints: [path.join(pkgRoot, 'src/render/index.ts')],
  outfile: renderOutFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(tempOutDir, 'node_modules'), 'junction');
const R = await import(pathToFileURL(renderOutFile).href);

after(() => {
  fs.rmSync(tempOutDir, { recursive: true, force: true });
});

// Independent reference oracle using Intl.Segmenter + strip-ansi + get-east-asian-width
const refSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const REF_ANSI_RE =
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const REF_UNICODE_ZERO_CAT = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
function isRefZeroWidthCp(ch, includeExtra = false) {
  if (REF_UNICODE_ZERO_CAT.test(ch)) return true;
  const cp = ch.codePointAt(0);
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (!includeExtra) return false;
  return (
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}
function isRefZeroWidthCluster(g) {
  let hasAny = false;
  for (const ch of g) {
    hasAny = true;
    if (!isRefZeroWidthCp(ch, true)) return false;
  }
  return hasAny;
}
const REF_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REF_EMOJI_PRES = /^\p{Emoji_Presentation}/u;
const REF_REGIONAL = /^\p{Regional_Indicator}/u;

function refGraphemeWidth(g) {
  if (!g) return 0;
  if (isRefZeroWidthCluster(g)) return 0;
  if (REF_REGIONAL.test(g)) return 2;
  if (REF_EMOJI_PRES.test(g)) return 2;
  if (REF_PICTOGRAPHIC.test(g) && (g.includes('\uFE0F') || g.includes('\u200D'))) return 2;
  if (g.includes('\u20E3')) return 2;
  for (const ch of g) {
    if (isRefZeroWidthCp(ch, false)) continue;
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
    return eastAsianWidth(cp, { ambiguousAsWide: false });
  }
  return 0;
}

function refDisplayWidth(str) {
  if (!str) return 0;
  const plain = stripAnsi(str);
  let w = 0;
  for (const seg of refSegmenter.segment(plain)) w += refGraphemeWidth(seg.segment);
  return w;
}

function refTokenize(str) {
  const out = [];
  const re = new RegExp(REF_ANSI_RE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) {
      for (const seg of refSegmenter.segment(str.slice(last, m.index))) {
        out.push({ s: seg.segment, w: refGraphemeWidth(seg.segment), ansi: false });
      }
    }
    out.push({ s: m[0], w: 0, ansi: true });
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < str.length) {
    for (const seg of refSegmenter.segment(str.slice(last))) {
      out.push({ s: seg.segment, w: refGraphemeWidth(seg.segment), ansi: false });
    }
  }
  return out;
}

function refTruncateDisplay(str, maxCols, ellipsis = '…') {
  const max = Math.floor(maxCols);
  if (!(max > 0)) return '';
  if (refDisplayWidth(str) <= max) return str;
  let ell = ellipsis;
  let ellW = refDisplayWidth(ell);
  if (ellW > max) {
    ell = '';
    ellW = 0;
  }
  const target = max - ellW;
  let out = '';
  let w = 0;
  let cut = false;
  for (const tok of refTokenize(str)) {
    if (tok.ansi) {
      out += tok.s;
      continue;
    }
    if (cut) continue;
    if (w + tok.w <= target) {
      out += tok.s;
      w += tok.w;
    } else {
      cut = true;
      out += ell;
    }
  }
  if (!cut) out += ell;
  return out;
}

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertAnsiClosed(line) {
  const sgrOpen = /(?:\u001B\[|\u009B)(?!(?:0|39|49)m)[\d;:]+m/;
  const oscOpen = /\u001B\]8;[^;]*;[^\u0007\u001B\u009C]+(?:\u0007|\u001B\\|\u009C)/;
  if (sgrOpen.test(line)) {
    assert.ok(
      /(?:\u001B\[|\u009B)(?:0|39|49)m/.test(line),
      `expected closed SGR in wrapped line: ${JSON.stringify(line)}`,
    );
  }
  if (oscOpen.test(line)) {
    assert.ok(
      line.includes('\u001B]8;;\u0007') || line.includes('\u001B]8;;\u001B\\'),
      `expected closed OSC-8 link in wrapped line: ${JSON.stringify(line)}`,
    );
  }
}

const TRICKY_STRINGS = [
  '',
  ' ',
  'plain ascii diagnostic line for fast-path verification',
  '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\~`',
  '中文',
  '操作系统原理：虚拟内存与缺页中断处理流程详解',
  '简体中文与繁體中文混合測試',
  '日本語ひらがなカタカナ漢字',
  'がぎぐげごパピプペポ',
  'か\u3099き\u3099は\u309A', // combining dakuten / handakuten
  'アイウ\u309B\u309Cヴ', // standalone voiced marks
  '한국어 테스트',
  '가나다라마바사아자차카타파하',
  '\u1100\u1161\u11A8\u1102\u1161', // Hangul Jamo L+V+T
  '한\u302E글\u302F', // Hangul tone marks (Mc)
  '中\u302A文\u302D', // CJK ideographic level tone marks (Mn)
  '〿\u3040\u3097\u3098', // CJK boundary code points (width 1)
  '全角标点，测试换行！ＡＢＣ１２３——省略号…',
  '￥１００％　全角空格',
  'Mixed ASCII + 日本語 + 한국어 + 中文 end',
  '\u001B[31m重要考点\u001B[39m: Page Table & TLB Hit Ratio',
  '\u001B[38;5;196m256色高亮\u001B[0m + plain',
  '\u001B[38;2;75;111;255mTruecolor 色彩文本\u001B[0m end',
  '\u001B[1;4;32mBold+Underline+Green 中文样式\u001B[0m',
  '\u009B33mC1 CSI 黄色警告\u009B0m ok',
  '\u001B]8;;https://example.com\u0007点击查看参考资料\u001B]8;;\u0007 (p.12)',
  '\u001B]8;id=42;https://studyhub.dev\u001B\\ST Hyperlink 中文\u001B]8;;\u001B\\',
  '👨‍👩‍👧‍👦',
  '👩‍💻',
  '🧑‍🔬 + 🏳️‍🌈',
  '🇨🇳',
  '🇺🇸',
  '🇨🇳🇺🇸🇯🇵 flags',
  '1️⃣',
  '#️⃣0️⃣9️⃣',
  '👍🏽',
  '❤️✂️',
  'e\u0301',
  'a\u0300\u0323',
  'x\u20D7 + y\u0302',
  '中\u0301文\u0308',
  'a\u200Bb\u200Cc',
  'a\u200Db',
  'ctrl\x00\x07\x1F\x7Fend',
  'tab\tseparated\t中文',
  '😀👍🏽👨‍👩‍👧混合中文与English尾缀',
  '「中文引号」与（括号）测试，句号。',
];

describe('Round 69 CJK/ANSI performance & bit-exactness', () => {
  test('1. Bit-exact equivalence & invariants across 45+ tricky strings', () => {
    assert.ok(TRICKY_STRINGS.length >= 40, `expected >= 40 tricky strings, got ${TRICKY_STRINGS.length}`);
    const widths = [0, 1, 2, 3, 4, 5, 8, 12, 20, 40];

    for (const s of TRICKY_STRINGS) {
      // displayWidth exact equivalence
      assert.equal(
        R.displayWidth(s),
        refDisplayWidth(s),
        `displayWidth mismatch for ${JSON.stringify(s)}`,
      );

      // splitGraphemes exact equivalence on ANSI-free strings
      if (!s.includes('\u001B') && !s.includes('\u009B')) {
        assert.deepEqual(
          R.splitGraphemes(s),
          [...refSegmenter.segment(s)].map((seg) => seg.segment),
          `splitGraphemes mismatch for ${JSON.stringify(s)}`,
        );
      }

      for (const w of widths) {
        // truncateDisplay exact equivalence & invariants
        const actualTrunc = R.truncateDisplay(s, w);
        const expectedTrunc = refTruncateDisplay(s, w);
        assert.equal(
          actualTrunc,
          expectedTrunc,
          `truncateDisplay(${JSON.stringify(s)}, ${w}) mismatch`,
        );
        assert.ok(
          R.displayWidth(actualTrunc) <= w,
          `truncateDisplay(${JSON.stringify(s)}, ${w}) exceeded width`,
        );
        assert.equal(hasLoneSurrogate(actualTrunc), false, `lone surrogate in ${JSON.stringify(actualTrunc)}`);
        assert.equal(stripAnsi(actualTrunc).includes('\uFFFD'), false);

        // padDisplay invariants
        for (const align of ['left', 'right', 'center']) {
          const padded = R.padDisplay(s, w, align);
          const expectedMinW = w === 0 && R.displayWidth(s) === 0 ? 0 : w;
          assert.equal(
            R.displayWidth(padded),
            expectedMinW,
            `padDisplay(${JSON.stringify(s)}, ${w}, ${align}) width mismatch`,
          );
          assert.equal(hasLoneSurrogate(padded), false);
        }

        // wrapDisplay invariants (maxCols >= 2 to fit wide graphemes)
        if (w >= 2) {
          const wrapped = R.wrapDisplay(s, w);
          assert.ok(wrapped.length >= 1);
          for (const line of wrapped) {
            assert.ok(
              R.displayWidth(line) <= w,
              `wrapDisplay(${JSON.stringify(s)}, ${w}) line exceeded width: ${JSON.stringify(line)}`,
            );
            assert.equal(hasLoneSurrogate(line), false);
            assertAnsiClosed(line);
          }
        }
      }
    }

    // Custom multi-char / wide / empty ellipsis equivalence
    for (const ell of ['', '...', '…', '··']) {
      for (const s of ['操作系统原理：虚拟内存', 'plain ascii line', '👨‍👩‍👧‍👦中文test', '\u001B[31m红色文本\u001B[0m']) {
        for (const w of [0, 1, 2, 5, 10]) {
          assert.equal(
            R.truncateDisplay(s, w, ell),
            refTruncateDisplay(s, w, ell),
            `truncateDisplay(${JSON.stringify(s)}, ${w}, ${JSON.stringify(ell)})`,
          );
        }
      }
    }
  });

  test('2. 10,000 mixed ASCII+CJK displayWidth + truncateDisplay calls complete in < 200ms', () => {
    const samples = [
      '操作系统原理：虚拟内存与缺页中断处理流程详解',
      'plain ascii diagnostic line for fast-path verification',
      'Mixed ASCII + 日本語 + 한국어 + 中文性能测试 Line 123',
      '全角标点，测试换行！ＡＢＣ１２３ａｂｃｄｅｆｇｈｉｊ',
      'CS162 Lecture 12: 进程调度 Scheduling & 页表 Translation',
      'アルゴリズムとデータ構造：二分探索木と平衡木',
    ];
    const widths = [4, 8, 15, 24, 32, 48];

    // Warm-up JIT
    let warm = 0;
    for (let i = 0; i < 500; i++) {
      const s = samples[i % samples.length];
      const w = widths[i % widths.length];
      warm += R.displayWidth(s) + R.truncateDisplay(s, w).length;
    }
    assert.ok(warm > 0);

    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 5_000; i++) {
      const s = samples[i % samples.length];
      const w = widths[i % widths.length];
      acc += R.displayWidth(s);
      acc += R.truncateDisplay(s, w).length;
    }
    const elapsedMs = performance.now() - t0;
    console.log(`[round69-cjk-perf] 10,000 mixed ASCII+CJK displayWidth+truncateDisplay calls: ${elapsedMs.toFixed(2)}ms`);

    assert.ok(acc > 0);
    assert.ok(
      elapsedMs < 200,
      `10,000 mixed ASCII+CJK displayWidth/truncateDisplay calls took ${elapsedMs.toFixed(1)}ms (budget < 200ms)`,
    );
  });
});

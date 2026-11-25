/** Voice/external-chat study pack export & Head Coach batch mastery sync. */
import { id } from '../../util.js';
import { findCard } from '../../prereq.js';
import { notify } from '../../inbox.js';
import { latestOutcomes, cardLevel, isDue, summarize } from '../../mastery.js';
import { initialReview, schedule } from '../../domain.js';
import { cardScheduleSettings, courseExamByName } from '../../card-schedule.js';
import { courseFocusTopics, stateFocusPredicate } from '../../focus-points.js';
import { learningScope } from '../../learning-scope.js';
import { courseOf, currentCourse } from '../../focus.js';
import { courseAncestors, courseKnown } from '../../course-tree.js';
import { knownCourseNames } from '../../source-courses.js';
import { sortCardsByReadingOrder } from '../../reading-order/card-reading-order.js';
import { slayCard, isSlayDeck } from '../../slay.js';
import { followupQuestion, followupDigest, currentFollowups } from '../../followup.js';
import { unescapeModelText } from '../../model-text.js';
import { GOALS, GOALS_EN } from '../../coach.js';

export const VOICE_PACK_MODES = Object.freeze(['cram', 'weak', 'new', 'due', 'focus', 'all']);
export const VOICE_PACK_BANTER = Object.freeze(['light', 'strict']);
export const VOICE_PACK_DEFAULT_LIMIT = 30;
export const VOICE_PACK_MAX_LIMIT = 100;
export const REVIEW_BATCH_MAX = 100;

const LEVEL_RANK_CRAM = Object.freeze({
  weak: 0,
  new: 1,
  learning: 2,
  familiar: 3,
  mastered: 4,
});

const LEVEL_ZH = Object.freeze({
  new: '新题',
  weak: '薄弱',
  learning: '学习中',
  familiar: '熟悉',
  mastered: '已掌握',
});

const LEVEL_EN = Object.freeze({
  new: 'new',
  weak: 'weak',
  learning: 'learning',
  familiar: 'familiar',
  mastered: 'mastered',
});

function clampLimit(value, fallback = VOICE_PACK_DEFAULT_LIMIT, max = VOICE_PACK_MAX_LIMIT) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`limit 必须是 1–${max} 之间的整数`);
  }
  return n;
}

function compactText(text, max = 360) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function slugFilename(title) {
  const safe = String(title || 'study-voice-pack')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return `${safe || 'study-voice-pack'}-voice-pack.md`;
}

function cardAnswerBrief(card) {
  if (card.kind === 'cloze' && card.cloze?.answers?.length) {
    const blanks = card.cloze.answers.map((a) => `${a.id}: ${a.value}`).join('；');
    return compactText(blanks, 300);
  }
  if (Array.isArray(card.options) && card.options.length) {
    const right = card.options.filter((o) => o.correct).map((o) => o.text).filter(Boolean);
    if (right.length) return compactText(right.join('；'), 300);
  }
  return compactText(card.answer || card.explanation || '', 300);
}

function cardStemBrief(card) {
  if (card.kind === 'cloze' && card.cloze?.text) return compactText(card.cloze.text, 320);
  return compactText(card.prompt, 320);
}

function sourceRefsOf(card, sourceMap) {
  const seen = new Set();
  const out = [];
  for (const cite of card.citations || []) {
    const src = cite?.sourceId ? sourceMap.get(cite.sourceId) : null;
    const label = src?.title || cite?.sourceTitle || cite?.sourceId || '';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= 2) break;
  }
  return out;
}

function resolvePackScope(state, args) {
  if (Array.isArray(args.scope)) return { scope: args.scope };
  if (Array.isArray(args.deckIds) && args.deckIds.length) {
    return { scope: args.deckIds.map((deckId) => ({ deckId })) };
  }
  if (typeof args.deckId === 'string' && args.deckId.trim()) {
    return { scope: [{ deckId: args.deckId.trim(), ...(args.topic ? { topic: String(args.topic).trim() } : {}) }] };
  }
  if (args.course !== undefined) return { course: args.course };
  if (args.currentCourse === true) {
    const active = currentCourse(state);
    return active !== undefined ? { course: active } : {};
  }
  return {};
}

const GOAL_LABELS_EN = GOALS_EN;

function buildProgressSnapshot(state, pool, resolvedCourse, now, language, { matchedCourses = [], byCourse = false } = {}) {
  const en = language === 'en';
  const summary = summarize(pool.map((item) => ({ card: item.card, level: item.level })), now);
  const focusCount = pool.filter((item) => item.focus).length;
  const byTopic = new Map();
  for (const item of pool) {
    const topicName = item.card.topic || (en ? 'General' : '未分类');
    if (!byTopic.has(topicName)) byTopic.set(topicName, []);
    byTopic.get(topicName).push({ card: item.card, level: item.level });
  }
  const topics = [...byTopic.entries()]
    .map(([name, list]) => ({ name, ...summarize(list, now) }))
    .sort((a, b) =>
      b.counts.weak - a.counts.weak ||
      b.counts.new - a.counts.new ||
      a.mastery - b.mastery ||
      b.total - a.total,
    );
  const weakHighlights = pool
    .filter((item) => item.level === 'weak')
    .slice(0, 8)
    .map((item) => ({
      cardId: item.card.id,
      topic: item.card.topic || (en ? 'General' : '未分类'),
      prompt: cardStemBrief(item.card).slice(0, 90),
    }));

  const examTargetCourse = resolvedCourse || (matchedCourses.length === 1 ? matchedCourses[0] : '');
  const examRecord = examTargetCourse ? courseExamByName(state, examTargetCourse) : null;
  let exam = null;
  if (examRecord?.date) {
    const targetMs = Date.parse(`${examRecord.date}T00:00:00`);
    const daysLeft = Number.isFinite(targetMs) ? Math.ceil((targetMs - now) / 86_400_000) : null;
    exam = {
      date: examRecord.date,
      ...(daysLeft !== null ? { daysLeft } : {}),
      ...(examRecord.format ? { format: examRecord.format } : {}),
    };
  }
  const rawFocusTopics = [];
  if (byCourse && resolvedCourse) {
    rawFocusTopics.push(...courseFocusTopics(state, resolvedCourse, { includeDescendants: true }));
  } else if (matchedCourses.length > 0) {
    for (const c of matchedCourses) rawFocusTopics.push(...courseFocusTopics(state, c));
    if (resolvedCourse) rawFocusTopics.push(...courseFocusTopics(state, resolvedCourse));
  } else if (resolvedCourse) {
    rawFocusTopics.push(...courseFocusTopics(state, resolvedCourse, { includeDescendants: true }));
  }
  const focusTopics = [...new Set(rawFocusTopics.filter((t) => typeof t === 'string' && t.trim()))].slice(0, 12);
  const rawGoal = state.learner?.goal;
  const learnerGoal = rawGoal && GOALS[rawGoal]
    ? (en ? (GOAL_LABELS_EN[rawGoal] || rawGoal) : GOALS[rawGoal])
    : '';
  const preferences = Array.isArray(state.learner?.preferences)
    ? state.learner.preferences.filter((p) => typeof p === 'string' && p.trim()).slice(0, 6)
    : [];

  return {
    mastery: summary.mastery,
    total: summary.total,
    due: summary.due,
    focusCount,
    counts: summary.counts,
    topics: topics.slice(0, 15),
    totalTopics: topics.length,
    weakHighlights,
    ...(exam ? { exam } : {}),
    ...(focusTopics.length ? { focusTopics } : {}),
    ...(learnerGoal ? { learnerGoal } : {}),
    ...(preferences.length ? { preferences } : {}),
  };
}

function renderProgressSection(progress, language) {
  const en = language === 'en';
  const c = progress.counts;
  const lines = [];
  if (en) {
    lines.push('## 2. Current Study Progress Snapshot (Read before teaching)');
    lines.push('');
    lines.push(`- **Overall mastery**: **${progress.mastery}%** (${progress.total} questions total · mastered ${c.mastered} / familiar ${c.familiar} / learning ${c.learning} / weak ${c.weak} / untouched ${c.new} · due now: ${progress.due}${progress.focusCount ? ` · focus-marked: ${progress.focusCount}` : ''})`);
    if (progress.learnerGoal) lines.push(`- **Learner goal**: ${progress.learnerGoal}`);
    if (progress.exam?.date) {
      const left = typeof progress.exam.daysLeft === 'number'
        ? (progress.exam.daysLeft >= 0 ? ` (${progress.exam.daysLeft} days left)` : ' (past)')
        : '';
      lines.push(`- **Target exam date**: ${progress.exam.date}${left}`);
    }
    if (progress.focusTopics?.length) lines.push(`- **Course focus topics**: ${progress.focusTopics.join(', ')}`);
    if (progress.preferences?.length) lines.push(`- **Study preferences**: ${progress.preferences.join(' | ')}`);
    if (progress.topics.length) {
      lines.push('');
      lines.push('| Topic | Mastery | Total | Weak | New | Due |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
      for (const t of progress.topics) {
        lines.push(`| ${t.name.replace(/\|/g, '/')} | ${t.mastery}% | ${t.total} | ${t.counts.weak} | ${t.counts.new} | ${t.due} |`);
      }
      if (progress.totalTopics > progress.topics.length) {
        lines.push(`| _(${progress.totalTopics - progress.topics.length} more topics omitted)_ | | | | | |`);
      }
    }
    if (progress.weakHighlights.length) {
      lines.push('');
      lines.push('**Current weak/stumbled spots to prioritize**:');
      for (const w of progress.weakHighlights) {
        lines.push(`- [${w.cardId}] (${w.topic}) ${w.prompt}`);
      }
    }
    lines.push('');
    return lines;
  }

  lines.push('## 2. 当前学习进度快照（带学前请先看清现状）');
  lines.push('');
  lines.push(`- **整体掌握度**：**${progress.mastery}%**（范围内共 ${progress.total} 题 · 已掌握 ${c.mastered} / 熟悉 ${c.familiar} / 学习中 ${c.learning} / 薄弱 ${c.weak} / 未做 ${c.new} · 当前到期 ${progress.due} 题${progress.focusCount ? ` · 重点题 ${progress.focusCount} 题` : ''}）`);
  if (progress.learnerGoal) lines.push(`- **学习目标**：${progress.learnerGoal}`);
  if (progress.exam?.date) {
    const left = typeof progress.exam.daysLeft === 'number'
      ? (progress.exam.daysLeft >= 0 ? `（距考试还有 ${progress.exam.daysLeft} 天）` : '（已过考试日）')
      : '';
    lines.push(`- **目标考试日期**：${progress.exam.date}${left}`);
  }
  if (progress.focusTopics?.length) lines.push(`- **已录入课程重点**：${progress.focusTopics.join('、')}`);
  if (progress.preferences?.length) lines.push(`- **个人学习偏好**：${progress.preferences.join('；')}`);
  if (progress.topics.length) {
    lines.push('');
    lines.push('| 主题 | 掌握度 | 总题数 | 薄弱 | 未做 | 到期 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const t of progress.topics) {
      lines.push(`| ${t.name.replace(/\|/g, '/')} | ${t.mastery}% | ${t.total} | ${t.counts.weak} | ${t.counts.new} | ${t.due} |`);
    }
    if (progress.totalTopics > progress.topics.length) {
      lines.push(`| _（另有 ${progress.totalTopics - progress.topics.length} 个主题未展开）_ | | | | | |`);
    }
  }
  if (progress.weakHighlights.length) {
    lines.push('');
    lines.push('**当前薄弱/卡壳热点（优先盯防）**：');
    for (const w of progress.weakHighlights) {
      lines.push(`- [${w.cardId}]（${w.topic}）${w.prompt}`);
    }
  }
  lines.push('');
  return lines;
}

function renderVoicePackMarkdown({ title, course, only, minutes, goal, language, banter = 'light', cards, totalAvailable, progress }) {
  const en = language === 'en';
  const strict = banter === 'strict';
  const totalCount = cards.length;
  const targetMinutes = minutes || 25;
  const paceLine = en
    ? `Time budget: ~${targetMinutes} minutes across ${totalCount} items (~${Math.max(1, Math.round(targetMinutes / Math.max(1, totalCount)))}–3 min per item; wrap up immediately if I say stop).`
    : `本次时间预算：约 ${targetMinutes} 分钟，覆盖 ${totalCount} 题（单题约 ${Math.max(1, Math.round(targetMinutes / Math.max(1, totalCount)))}–3 分钟；我说停就立刻结算）。`;
  const goalLine = goal
    ? (en ? `Study goal: ${goal}.` : `学习目标：${goal}。`)
    : progress.learnerGoal
      ? (en ? `Study goal: ${progress.learnerGoal}.` : `学习目标：${progress.learnerGoal}。`)
      : (en ? 'Study goal: high-efficiency breadth-first mastery for exams/interviews.' : '学习目标：高效率广度优先速成与应试/面试攻坚。');

  const lines = [];
  if (en) {
    lines.push(`# Voice Study Pack · ${title}`);
    lines.push('');
    lines.push(`> Mode: \`${only}\` · Pace: \`${strict ? 'strict' : 'light-banter'}\` · Included: ${totalCount}/${totalAvailable} questions · Mastery: ${progress.mastery}%${course ? ` · Course: ${course}` : ''}`);
    lines.push('');
    lines.push('## 1. Anti-Drift Voice Tutor Prompt (Send this whole file to Gemini Live / ChatGPT Voice / Doubao)');
    lines.push('');
    lines.push('You are my high-intensity voice study tutor. Keep me strictly on schedule through the checklist below so I finish on time with minimal eye strain.');
    lines.push(goalLine);
    lines.push(paceLine);
    lines.push('');
    lines.push('Hard Guardrails (Anti-Drift Protocol — MUST obey every turn):');
    lines.push(`1. **Mandatory 1-line heartbeat header on EVERY reply**: start every response with \`[Progress k/${totalCount} · Turn t/3 · ~M min left]\` (in voice mode, state the item number briefly). Never drop this cursor — it prevents losing track of the checklist.`);
    lines.push(strict
      ? '2. **Zero-tangent pacing**: stay strictly on the current checklist item. If I ask a side question outside the list, answer in 1 crisp sentence, park it under "External Blind Spots", and immediately pull back: "Back to item #k…".'
      : '2. **Light banter allowed, hard pullback**: brief warm banter (1–2 light sentences) is welcome to keep focus up, NEVER let tangents run past 2 sentences. Park side questions under "External Blind Spots" and immediately say: "Back to item #k…".');
    lines.push('3. **3-turn circuit breaker per item**: spend at most **3 turns** on any single item. If I still stumble on turn 3, give one crystal-clear analogy + one-line contrast, tag `[cardId]` as `Struggled (revisit)`, and **force-advance** to item #k+1 so we finish the list.');
    lines.push('4. **Anti-pseudo-mastery**: never treat "yeah got it" as mastered. Require me to explain the core mechanism, contrast, or a counterexample in 1–2 plain sentences before marking it solid.');
    lines.push('5. **Spoken pace commands I may use anytime**:');
    lines.push('   - **"Skip / Next"** → immediately advance to the next item (mark current as skipped/struggled).');
    lines.push('   - **"Fast-forward"** → compress remaining items to 1-sentence core takeaway + 1 rapid check question each.');
    lines.push('   - **"Wrap up today"** (or "今天先到这，给我结算") → stop teaching immediately and output a compact summary preserving every `[cardId]` with these 5 blocks:');
    lines.push('     - **Struggled & Plain-Language QA**: `[cardId]` + what confused me + the 2–4 sentence plain-language explanation that clicked');
    lines.push('     - **Solid / Mastered**: `[cardId]` + short quote of how I explained it (only when I actively explained it)');
    lines.push('     - **Prerequisite Order Notes**: Concept/Card A must come before Concept/Card B');
    lines.push('     - **Covered but Missing from Pack**: concept + 1-sentence core takeaway (for gap supplementing)');
    lines.push('     - **Uncovered Remaining**: `[cardId]` list not reached today');
    lines.push('');
    lines.push(...renderProgressSection(progress, language));
    lines.push('## 3. Study Checklist (Preserve `[cardId]` Anchors)');
    lines.push('');
    for (const [index, item] of cards.entries()) {
      const tags = [LEVEL_EN[item.level] || item.level, ...(item.focus ? ['focus'] : []), item.topic || 'General'];
      lines.push(`### ${index + 1}. [${item.cardId}] ${item.topic || 'General'} (${tags.join(' · ')})`);
      lines.push(`- **Q**: ${item.prompt}`);
      if (item.answer) lines.push(`- **Core Key**: ${item.answer}`);
      if (item.misconception) lines.push(`- **Common Trap**: ${item.misconception}`);
      if (item.requires?.length) lines.push(`- **Prerequisites**: ${item.requires.map((r) => `[${r}]`).join(', ')}`);
      if (item.sources?.length) lines.push(`- **Source**: ${item.sources.join(' / ')}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('## 4. Post-Session Handoff to StudyHub Head Coach (CLI / DSH)');
    lines.push('');
    lines.push('After finishing the voice session, click **"Send voice recap to Head Coach"** in StudyHub (or paste your transcript into DSH / Codex CLI / `agy` CLI / Claude Code) and say:');
    lines.push('');
    lines.push('> Use `study-coach-team` to run the 4-TA post-session debrief on this transcript: pre-fill plain-language QA (`card.followup.add`), fix prerequisite links (`card.link.batch`), check/fill real missing questions (`supplement` / `capture`), sync mastery grades (`card.review.batch`), and open 5–12 high-signal verification questions in StudyHub (`panel.open`).');
    lines.push('');
    lines.push('> External CLI bridge (outside DSH): run `node scripts/study-cli.mjs call <action> --file <payload.json>` (never edit `.dsh-study/` shards directly).');
    return lines.join('\n');
  }

  lines.push(`# 语音带学任务包 · ${title}`);
  lines.push('');
  lines.push(`> 抽题模式：\`${only}\` · 互动节奏：\`${strict ? '纯硬核' : '轻度闲聊+强拉回'}\` · 本次收录：${totalCount}/${totalAvailable} 题 · 当前掌握度：${progress.mastery}%${course ? ` · 课程：${course}` : ''}`);
  lines.push('');
  lines.push('## 1. 给外部语音 AI 的防发散私教提示词（直接整份复制或拖进 Gemini / ChatGPT / 豆包）');
  lines.push('');
  lines.push('你现在是我的高压速成语音私教，目标是带我闭眼/少盯屏幕、在规定时间内按清单高效率过完下面这批知识点，绝不因为闲聊或跑题导致学不完。');
  lines.push(goalLine);
  lines.push(paceLine);
  lines.push('');
  lines.push('防跑偏硬协议（每一轮都必须严格执行）：');
  lines.push(`1. **每条回复开头强制带 1 行进度心跳**：\`[进度 k/${totalCount} · 本题第 t/3 轮 · 剩约 M 分钟]\`（语音模式简短报出“第 k 题”）。绝不能省略这个锚点——用来锁死主线进度、防止聊着聊着忘掉清单。`);
  lines.push(strict
    ? '2. **零跑题强控**：严格围绕当前清单项。如果我顺嘴插话问清单外内容，最多 1 句话答清、记入「课外盲区」，立刻说“好，拉回第 k 题…”继续主线。'
    : '2. **允许轻度闲聊，但必须强拉回**：为了保持专注不枯燥，允许自然互动/接梗 1–2 句，但**任何跑题或闲聊绝不超过 2 句**；清单外问题记进「课外盲区」，紧接着必须补一句“好，拉回主线，继续第 k 题…”。');
  lines.push('3. **单题 3 轮熔断机制**：每一题最多来回 **3 轮**。如果第 3 轮我还是卡壳，别死磕拖垮全局——直接给一句最直白的类比 + 一句话对比，把该 `[cardId]` 记入「卡壳待回炉」，**强制推进到下一题**。');
  lines.push('4. **禁止“伪学会”**：我说“嗯懂了/明白了”不算通过，必须追问一句让我用大白话复述核心机制、对比区别或举个反例，我真讲清了再标为已稳。');
  lines.push('5. **我随时可以喊的 3 个换挡口令**：');
  lines.push('   - **「跳过 / 下一题」** → 立刻切到下一题（本题记为跳过或卡壳）。');
  lines.push('   - **「快进模式」** → 剩余题目压缩为每题 1 句核心结论 + 1 句极速反问，保证冲完覆盖率。');
  lines.push('   - **「今天先到这，给我结算」** → 立刻停下，务必保留每个 `[cardId]`，按以下 5 块极简输出：');
  lines.push('     - **【卡壳与通俗解释】**：`[cardId]` + 我当时错/混在哪 + 让我听懂的 2–4 句人话解释');
  lines.push('     - **【已稳/讲透的题】**：`[cardId]` + 我自己的复述要点（只列我真正讲清的）');
  lines.push('     - **【前置顺序建议】**：A 应该排在 B 前面学（写明 `[cardId]` 或概念名）');
  lines.push('     - **【讲到但清单没覆盖的盲区】**：概念名 + 一句话核心要点（供课后补题）');
  lines.push('     - **【今日漏网未聊】**：清单里今天没来得及聊的 `[cardId]`');
  lines.push('');
  lines.push(...renderProgressSection(progress, language));
  lines.push('## 3. 今日清单（请保留 `[cardId]` 锚点，方便课后精准回传）');
  lines.push('');
  for (const [index, item] of cards.entries()) {
    const tags = [LEVEL_ZH[item.level] || item.level, ...(item.focus ? ['重点'] : []), item.topic || '未分类'];
    lines.push(`### ${index + 1}. [${item.cardId}] ${item.topic || '未分类'}（${tags.join(' · ')}）`);
    lines.push(`- **题干**：${item.prompt}`);
    if (item.answer) lines.push(`- **核心要点**：${item.answer}`);
    if (item.misconception) lines.push(`- **常见坑**：${item.misconception}`);
    if (item.requires?.length) lines.push(`- **前置题**：${item.requires.map((r) => `[${r}]`).join('、')}`);
    if (item.sources?.length) lines.push(`- **来源**：${item.sources.join(' / ')}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('## 4. 学完回传给 StudyHub 主教练（CLI / DSH）');
  lines.push('');
  lines.push('语音聊完后，点 StudyHub 里的**「回传语音记录给主教练结算」**（或直接把聊天记录贴给 DSH / Codex CLI / `agy` CLI / Claude Code），说一句：');
  lines.push('');
  lines.push('> 用 `study-coach-team` 启动主教练 + 4 助教做课后回馈结算：把卡壳点大白话提前写进 QA（`card.followup.add`）、理顺前置顺序（`card.link.batch`）、查漏补题（`supplement`/`capture`）、同步掌握度（`card.review.batch`），并挑 5–12 道高质量课后验收题推到 StudyHub 面板（`panel.open`）。');
  lines.push('');
  lines.push('> 如果你在 DSH 之外的终端 CLI（Codex CLI / `agy` / Claude Code）结算，请通过 `node scripts/study-cli.mjs call <action> --file <payload.json>` 安全读写学习库，不要手改 `.dsh-study/` 分片文件。');
  return lines.join('\n');
}

/** Build a ready-to-use voice study handoff pack for external voice AI + post-session sync. */
export function buildVoicePack(state, args = {}, now = Date.now()) {
  const only = args.only || 'cram';
  if (!VOICE_PACK_MODES.includes(only)) {
    throw new Error(`only 必须是 ${VOICE_PACK_MODES.join(' / ')} 之一`);
  }
  const limit = clampLimit(args.limit, VOICE_PACK_DEFAULT_LIMIT, VOICE_PACK_MAX_LIMIT);
  const language = args.language === 'en' ? 'en' : 'zh';
  const banter = VOICE_PACK_BANTER.includes(args.banter) ? args.banter : 'light';
  const minutes = args.minutes !== undefined && args.minutes !== null && args.minutes !== ''
    ? Math.max(5, Math.min(240, Math.round(Number(args.minutes) || 0)))
    : undefined;
  const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim().slice(0, 240) : '';
  const topicFilter = typeof args.topic === 'string' && args.topic.trim() ? args.topic.trim().toLowerCase() : '';
  const scopeArgs = resolvePackScope(state, args);
  const selection = learningScope(state, scopeArgs);
  const outcome = latestOutcomes(state.attempts || []);
  const isFocus = stateFocusPredicate(state);
  const sourceMap = new Map((state.sources || []).map((src) => [src.id, src]));

  const scopePool = [];
  const pool = [];
  const deckTitles = new Set();
  const matchedCourseSet = new Set();
  const hasRealDeck = (state.decks || []).some((deck) => deck && !deck.archived && !isSlayDeck(deck) && !deck.systemKind && !deck.sample);
  for (const deck of state.decks || []) {
    if (deck.archived || isSlayDeck(deck) || deck.systemKind) continue;
    if (selection.all && hasRealDeck && deck.sample) continue;
    const deckCourse = courseOf(deck, state);
    const orderedCards = sortCardsByReadingOrder(deck.cards || [], state.sources || []);
    orderedCards.forEach((card, orderIndex) => {
      if (card.suspended) return;
      if (!selection.matches(deck.id, card)) return;
      if (topicFilter && !String(card.topic || '未分类').toLowerCase().includes(topicFilter)) return;
      const level = cardLevel(card, outcome(deck.id, card.id));
      const due = level !== 'new' && isDue(card, now);
      const focus = !!isFocus(deck, card);
      const entry = {
        deckId: deck.id,
        deckTitle: deck.title,
        card,
        level,
        due,
        focus,
        orderIndex,
      };
      deckTitles.add(deck.title);
      if (deckCourse) matchedCourseSet.add(deckCourse);
      scopePool.push(entry);
      if (only === 'weak' && level !== 'weak') return;
      if (only === 'new' && level !== 'new') return;
      if (only === 'due' && !due) return;
      if (only === 'focus' && !focus) return;
      pool.push(entry);
    });
  }

  let ranked = pool;
  if (only === 'cram') {
    const unmastered = args.includeMastered === true ? pool : pool.filter((item) => item.level !== 'mastered');
    const base = unmastered.length ? unmastered : pool;
    ranked = [...base].sort((a, b) =>
      Number(b.focus) - Number(a.focus) ||
      (LEVEL_RANK_CRAM[a.level] ?? 9) - (LEVEL_RANK_CRAM[b.level] ?? 9) ||
      Number(b.due) - Number(a.due) ||
      a.orderIndex - b.orderIndex,
    );
  } else if (only === 'due') {
    ranked = [...pool].sort((a, b) =>
      Number(b.focus) - Number(a.focus) ||
      Date.parse(a.card.review?.due_at || 0) - Date.parse(b.card.review?.due_at || 0) ||
      a.orderIndex - b.orderIndex,
    );
  } else if (only === 'weak' || only === 'focus') {
    ranked = [...pool].sort((a, b) =>
      Number(b.focus) - Number(a.focus) ||
      (LEVEL_RANK_CRAM[a.level] ?? 9) - (LEVEL_RANK_CRAM[b.level] ?? 9) ||
      a.orderIndex - b.orderIndex,
    );
  }

  const picked = ranked.slice(0, limit).map(({ deckId, deckTitle, card, level, focus, due }) => ({
    cardId: card.id,
    deckId,
    deckTitle,
    topic: card.topic || (language === 'en' ? 'General' : '未分类'),
    kind: card.kind,
    level,
    focus,
    due,
    prompt: cardStemBrief(card),
    answer: cardAnswerBrief(card),
    hint: compactText(card.hint || '', 200),
    misconception: compactText(card.misconception || '', 220),
    requires: (card.requires || []).map((r) => r.cardId).filter(Boolean),
    sources: sourceRefsOf(card, sourceMap),
  }));

  const matchedCourses = [...matchedCourseSet];
  let commonCourse = '';
  if (matchedCourses.length === 1) {
    commonCourse = matchedCourses[0];
  } else if (matchedCourses.length > 1) {
    const known = courseKnown(knownCourseNames(state));
    let shared = new Set(courseAncestors(matchedCourses[0], known));
    for (let i = 1; i < matchedCourses.length && shared.size > 0; i += 1) {
      const next = new Set(courseAncestors(matchedCourses[i], known));
      shared = new Set([...shared].filter((anc) => next.has(anc)));
    }
    for (const anc of shared) {
      if (anc.length > commonCourse.length) commonCourse = anc;
    }
  }
  const explicitCourseScope = typeof args.course === 'string' && args.course !== '*';
  const resolvedCourse = explicitCourseScope
    ? args.course
    : selection.course || commonCourse || '';
  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim().slice(0, 120)
    : deckTitles.size === 1
      ? [...deckTitles][0]
      : resolvedCourse || (language === 'en' ? 'Study Library' : '学习库');

  const byCourse = explicitCourseScope || Boolean(selection.course);
  const progress = buildProgressSnapshot(state, scopePool, resolvedCourse, now, language, { matchedCourses, byCourse });

  const markdown = renderVoicePackMarkdown({
    title,
    course: resolvedCourse,
    only,
    minutes,
    goal,
    language,
    banter,
    cards: picked,
    totalAvailable: pool.length,
    progress,
  });

  return {
    title,
    filename: slugFilename(title),
    course: resolvedCourse,
    only,
    banter,
    language,
    count: picked.length,
    totalAvailable: pool.length,
    progress,
    cards: picked,
    markdown,
  };
}

function normalizeBatchId(args) {
  const hasBatchId = args.batchId !== undefined && args.batchId !== null && args.batchId !== '';
  const hasIdem = args.idempotencyKey !== undefined && args.idempotencyKey !== null && args.idempotencyKey !== '';
  if (hasBatchId && typeof args.batchId !== 'string') throw new Error('batchId 必须是非空字符串');
  if (hasIdem && typeof args.idempotencyKey !== 'string') throw new Error('idempotencyKey 必须是非空字符串');
  const b = hasBatchId ? args.batchId.trim().slice(0, 128) : '';
  const k = hasIdem ? args.idempotencyKey.trim().slice(0, 128) : '';
  if (b && k && b !== k) throw new Error('batchId 与 idempotencyKey 不能冲突');
  return b || k;
}

function findExistingBatchAttempt(state, batchId, cardId) {
  if (!batchId) return null;
  return (state.attempts || []).find(
    (att) => att && att.via === 'coach-sync' && att.batchId === batchId && att.quiz_id === cardId,
  ) || null;
}

function prepareBatchItem(state, raw, index, batchId) {
  if (!raw || typeof raw !== 'object') throw new Error('每一项必须是对象');
  const hasGrade = raw.grade !== undefined && raw.grade !== null;
  const hasFocus = typeof raw.focus === 'boolean';
  const hasSlay = raw.slay === true;
  const hasFollowup = !!(raw.followup && typeof raw.followup === 'object');
  if (!hasGrade && !hasFocus && !hasSlay && !hasFollowup) {
    throw new Error('至少需要提供 grade、focus、slay 或 followup 之一');
  }
  if (hasGrade && (!Number.isInteger(raw.grade) || raw.grade < 0 || raw.grade > 5)) {
    throw new Error('grade 必须是 0 到 5 的整数');
  }

  const { deck, card } = findCard(state, raw);
  const existingBatchAttempt = hasGrade ? findExistingBatchAttempt(state, batchId, card.id) : null;
  if (isSlayDeck(deck)) {
    if (hasSlay && !hasGrade && !hasFocus && !hasFollowup) {
      return { index, raw, deck, card, alreadySlainOnly: true };
    }
    if (batchId && hasSlay && existingBatchAttempt && !hasFocus && !hasFollowup) {
      return { index, raw, deck, card, existingBatchAttempt, replaySlain: true };
    }
    throw new Error('这道题已在斩题组中，请先恢复再更新');
  }

  let followupSpec = null;
  if (hasFollowup) {
    const question = followupQuestion(raw.followup.question);
    const answer = typeof raw.followup.answer === 'string' ? raw.followup.answer.trim() : '';
    if (!answer || answer.length > 8000) throw new Error('followup.answer 不能为空，且最多 8000 字');
    followupSpec = { question, answer };
  }

  return {
    index,
    raw,
    deck,
    card,
    hasGrade,
    hasFocus,
    hasSlay,
    hasFollowup,
    followupSpec,
  };
}

/** Batch update FSRS mastery grades, focus flags, follow-up QA notes, and slay state from a Head Coach / CLI debrief. */
export function applyCardReviewBatch(state, args = {}) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length || items.length > REVIEW_BATCH_MAX) {
    throw new Error(`items 需要 1–${REVIEW_BATCH_MAX} 项 {cardId, deckId?, grade?, focus?, slay?, followup?, evidence?, reason?}`);
  }
  const batchId = normalizeBatchId(args);
  const atomic = args.atomic === true;
  const timestamp = new Date().toISOString();
  const results = [];
  let graded = 0;
  let deduplicated = 0;
  let followupsAdded = 0;
  let focusChanged = 0;
  let slain = 0;
  let firstOk = null;

  // In atomic mode, pre-validate every item before mutating any state so no partial batch commits.
  if (atomic) {
    const failures = [];
    for (const [index, raw] of items.entries()) {
      try {
        prepareBatchItem(state, raw, index, batchId);
      } catch (error) {
        failures.push({ index, cardId: raw?.cardId, deckId: raw?.deckId, ok: false, error: error.message });
      }
    }
    if (failures.length) {
      throw Object.assign(new Error(`批量校验失败（${failures.length} 项）：${failures[0].error}`), {
        code: 'batch-validation-failed',
        failures,
      });
    }
  }

  for (const [index, raw] of items.entries()) {
    try {
      const plan = prepareBatchItem(state, raw, index, batchId);
      const { deck, card } = plan;

      if (plan.alreadySlainOnly) {
        results.push({ index, cardId: card.id, deckId: deck.id, ok: true, slain: true, alreadySlain: true });
        continue;
      }
      if (plan.replaySlain) {
        deduplicated++;
        results.push({
          index,
          cardId: card.id,
          deckId: deck.id,
          ok: true,
          grade: plan.existingBatchAttempt.grade,
          level: cardLevel(card, plan.existingBatchAttempt.grade),
          nextDue: card.review?.due_at || plan.existingBatchAttempt.after?.due_at,
          gradeDuplicate: true,
          duplicate: true,
          slain: true,
          alreadySlain: true,
        });
        continue;
      }

      // Pre-compute FSRS schedule before mutating any field on `card` or `state`.
      let gradePlan = null;
      let existingBatchAttempt = null;
      if (plan.hasGrade) {
        existingBatchAttempt = findExistingBatchAttempt(state, batchId, card.id);
        if (!existingBatchAttempt) {
          const sched = cardScheduleSettings(state, deck, card);
          const reviewSnapshot = structuredClone(card.review ?? null);
          const before = structuredClone(reviewSnapshot) ?? initialReview(state.settings);
          const after = schedule(before, raw.grade, timestamp, sched.settings);
          gradePlan = { sched, reviewSnapshot, before, after };
        }
      }

      const out = { index, cardId: card.id, deckId: deck.id, ok: true };

      if (plan.hasFocus) {
        const beforeFocus = !!card.focus;
        if (raw.focus) card.focus = true;
        else delete card.focus;
        if (beforeFocus !== !!card.focus) focusChanged++;
        out.focus = !!card.focus;
      }

      if (plan.hasFollowup) {
        const { question, answer } = plan.followupSpec;
        const digest = followupDigest(card);
        const existing = currentFollowups(card).find((entry) => entry.originalQuestion === question);
        if (existing) {
          out.followupId = existing.id;
          out.followupDuplicate = true;
        } else {
          const entry = {
            id: id(),
            at: timestamp,
            digest,
            originalQuestion: question,
            question,
            answer: unescapeModelText(answer),
            source: 'assistant',
          };
          card.followups = [...(card.followups || []), entry];
          followupsAdded++;
          out.followupId = entry.id;
        }
      }

      if (plan.hasGrade) {
        if (existingBatchAttempt) {
          deduplicated++;
          out.grade = existingBatchAttempt.grade;
          out.level = cardLevel(card, existingBatchAttempt.grade);
          out.nextDue = card.review?.due_at || existingBatchAttempt.after?.due_at;
          out.gradeDuplicate = true;
          out.duplicate = true;
        } else {
          const { sched, reviewSnapshot, before, after } = gradePlan;
          card.review = after;
          const evidence = typeof raw.evidence === 'string' && raw.evidence.trim() ? raw.evidence.trim().slice(0, 500) : '';
          const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 300) : '';
          state.attempts.push({
            id: id(),
            runId: null,
            entryIndex: null,
            quiz_id: card.id,
            deckId: deck.id,
            topic: card.topic,
            timestamp,
            grade: raw.grade,
            assessment: 'coach-sync',
            via: 'coach-sync',
            ...(batchId ? { batchId } : {}),
            ...(evidence ? { learnerAnswer: evidence } : {}),
            ...(reason ? { reason } : {}),
            retry: false,
            reviewSnapshot,
            before,
            after,
          });
          graded++;
          out.grade = raw.grade;
          out.level = cardLevel({ ...card, review: after }, raw.grade);
          out.nextDue = after.due_at;
          if (sched.isFocus) out.focusScheduled = true;
        }
      }

      if (plan.hasSlay) {
        const slainResult = slayCard(state, { deckId: deck.id, cardId: card.id });
        if (!slainResult.alreadySlain) slain++;
        out.slain = true;
        out.deckId = slainResult.deckId;
      }

      firstOk ||= { deckId: deck.id, cardId: card.id };
      results.push(out);
    } catch (error) {
      results.push({ index, cardId: raw?.cardId, deckId: raw?.deckId, ok: false, error: error.message });
    }
  }

  const updated = results.filter((r) => r.ok).length;
  const failed = results.length - updated;
  const hasMutation = graded > 0 || followupsAdded > 0 || focusChanged > 0 || slain > 0;
  if (updated && firstOk && (!batchId || hasMutation)) {
    const label = typeof args.sessionTitle === 'string' && args.sessionTitle.trim()
      ? args.sessionTitle.trim().slice(0, 120)
      : '主教练同步';
    const parts = [];
    if (graded) parts.push(`更新掌握度 ${graded} 题`);
    if (followupsAdded) parts.push(`预填通俗 QA ${followupsAdded} 条`);
    if (focusChanged) parts.push(`调整重点 ${focusChanged} 题`);
    if (slain) parts.push(`斩题 ${slain} 道`);
    notify(state, {
      kind: 'improve',
      deckId: firstOk.deckId,
      cardId: firstOk.cardId,
      detail: `${label}：${parts.length ? parts.join('，') : `处理 ${updated} 题`}`,
    });
  }

  return {
    updated,
    failed,
    graded,
    followupsAdded,
    focusChanged,
    slain,
    ...(batchId ? { batchId, deduplicated } : {}),
    results,
  };
}

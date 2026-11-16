import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* Hand-offs for Interactive Companions (`CompanionViewer` & `CompanionBuildDialog`):
   - Default (`companion.ask`): escalates an in-lesson slide confusion to the main chat (`study-tutor`)
     with `companionId`, exact slide context, quote, and derivation/code slice, guiding `companion.catchup.save`.
   - `mode === 'build'`: hands off cross-discipline interactive companion authoring to the main chat
     so learners (even without a separate StudyHub model key) can co-design & mount via `companion.compile`. */

export function companionAskPrompt(
  {
    mode = 'ask',
    companionId = '',
    course = '',
    title = '',
    topic = '',
    archetype = '',
    mountMode = '',
    sourceIds = [],
    slide = 1,
    slideTitle = '',
    quote = '',
    contextText = '',
    question = '',
  } = {},
  language = getUiLanguage(),
) {
  const cleanCourse = String(course || '').trim();

  if (mode === 'build') {
    const cleanIds = Array.isArray(sourceIds) ? sourceIds.map(id => String(id || '').trim()).filter(Boolean) : [];
    const ask = cleanCourse
      ? say(language, '帮我为课程 {0} 生成一节跨学科交互伴学课，把下面的主题一步步讲透。', [nameData(cleanCourse)])
      : say(language, '帮我生成一节跨学科交互伴学课，把下面的主题一步步讲透。');
    return {
      ask,
      request: String(topic || '').trim(),
      notes: [
        say(language, '规范：先用 study_workspace 读 library.context {"area":"companions"}；若下方列出了参考讲义 ID，先用 source.get 或 source.search 读取依据。'),
        say(language, '编排：按 studyhub-lesson/1 规范组织逐句舞台（含离线 LaTeX 公式与 sandbox、matrix、schematic 或 lanes 互动组件），直接调用 companion.compile 挂载到课程，或在已配好模型时调用 generation.companion.build。'),
      ],
      data: [
        ...(archetype && archetype !== 'auto' ? [['交互母版', String(archetype)]] : []),
        ...(mountMode && mountMode !== 'auto' ? [['导题模式', String(mountMode)]] : []),
        ...(cleanIds.length ? [['参考讲义 ID', cleanIds.join(', ')]] : []),
      ],
    };
  }

  const slideNum = Math.max(1, Math.floor(Number(slide) || 1));
  const label = slideTitle ? `${title} · #${slideNum} ${slideTitle}` : `${title} · #${slideNum}`;
  const ask = cleanCourse
    ? say(language, '我在看课程 {0} 的交互伴学页 {1} 时卡壳了，帮我结合这一页把下面的困惑讲透。', [nameData(cleanCourse), nameData(label)])
    : say(language, '我在看交互伴学页 {0} 时卡壳了，帮我结合这一页把下面的困惑讲透。', [nameData(label)]);
  const cleanId = String(companionId || '').trim();
  return {
    ask,
    request: String(question || '').trim(),
    notes: [
      ...(cleanId ? [say(language, '位置：当前伴学页 id {0} · 第 {1} 页（需要核对整节结构时可用 companion.get 读取）。', [JSON.stringify(cleanId), slideNum])] : []),
      say(language, '定位：当前伴学页摘录与推演片段已在下方 data 围栏中给出，请紧扣这一页的上下文直接点破我混淆的边界。'),
      say(language, '联动：需要查我已学的关联前置题时可用 card.search 或 source.search；若讲完后适合留一道防混闪卡，先征得我同意再用 companion.catchup.save（或 capture）保存，使闪卡关联回当前伴学页。'),
    ],
    data: [
      ...(quote ? [['选中原句', String(quote)]] : []),
      ['当前页上下文', String(contextText || label)],
    ],
  };
}

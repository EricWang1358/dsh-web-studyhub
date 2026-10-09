import React, { useContext } from 'react';
import { ui, uiFormat, uiIsEnglish } from './i18n.js';
import { Banner, Button, Hint, InlineMessage, SetupRequired } from './components/index.js';
import { ModelSettingsContext, useModelSettingsLabel } from './ModelErrorNote.jsx';

/* "There is no AI model yet", said in one place. Every page that needs a model shows this gate instead of its own wording:
     block    a whole step is replaced by it (the submit area of a form, the model pane of Settings): why, the exact steps, the one button
     inline   one line next to a control that cannot work (warning tone, with the same button as a link)
     banner   a page-level line above content that can still be prepared
     compact  one line of muted text with a link, for a control that stands there disabled or a note that was plain text
   `feature` says what the model is for. The copy of every combination is in this file and nowhere else.

   The key is DSH's, not StudyHub's: DSH keeps it (Settings › Models) and StudyHub has no key field. So the steps say where to go in DSH and
   what to do afterwards here, and the button goes to where StudyHub can help: DSH's own model panel when the host offers one, else Settings ›
   学习库与模型, which shows the same state and the same steps (ui/settings/ModelStatus.jsx). The button's name says which (modelSettingsLabel). */

/** The gate's headline: the block names the first step, the smaller shapes state the fact. */
export const gateTitle = (variant = 'block') => (variant === 'block' ? ui('先配置一个 AI 模型') : ui('还没有可用的 AI 模型'));

/** Sentences joined the way the language joins them. */
const say = (...parts) => parts.filter(Boolean).join(uiIsEnglish() ? ' ' : '');

/**
 * The state of a chosen model that cannot be used, in one sentence ('' when nothing is chosen or nothing specific can be said).
 * model: the readiness ({ ready, reason, label }, see modelReadiness). A reason the host did not give claims nothing.
 */
export function modelFact({ reason, label } = {}) {
  if (reason === 'no-credential') return label ? uiFormat('已选择「{0}」，但 DSH 里还没有它的 API Key。', [label]) : ui('已选择模型，但 DSH 里还没有它的 API Key。');
  if (!label) return '';
  if (reason === 'unknown') return uiFormat('已选择「{0}」，但这个 DSH 没有让 StudyHub 调用模型。', [label]);
  if (reason === 'no-route') return uiFormat('已选择「{0}」，但 DSH 里没有这个服务商。', [label]);
  return '';
}

/** "DeepSeek · V4 Flash" is the provider's name and the model's: the card to look for in DSH is the provider's. */
const providerOf = (label) => String(label || '').split(' · ')[0].trim();

/**
 * The steps before the last one, by what is missing. A chosen model needs only its key; no model needs a key and a choice; a provider DSH does not
 * know needs another choice; a DSH that did not hand StudyHub the model has nothing the learner can enter (the sentence above says what to check).
 * `pick` is how this page lets the learner choose a model (the pane of Settings has the choice right there).
 */
function setupSteps({ reason, label } = {}, pick) {
  const choose = { text: pick || ui('选一个模型：在对话输入框的模型选择器里选，或在 StudyHub「设置 › 学习库与模型」的「生成模型」里选') };
  if (reason === 'no-credential') {
    const provider = providerOf(label);
    return [{ text: provider ? uiFormat('在 DSH 打开「设置 › 模型」，在「{0}」卡片填入 API Key 并保存', [provider]) : ui('在 DSH 打开「设置 › 模型」，给所选服务商填入 API Key 并保存') }];
  }
  if (reason === 'unknown' && label) return [];
  if (reason === 'no-route' && label) return [choose];
  return [{ text: ui('在 DSH 打开「设置 › 模型」，选一个服务商，填入它的 API Key 并保存') }, choose];
}

/* Per feature: `why` (block), `then` (the last step of a block), `line` (inline, compact), `note` (banner), `badge` (block, optional), `pick` (block: how to
   choose a model here). A function of the readiness and of what the page can do ({ recheck }: a button to read the state again). */
const FEATURES = {
  generate: ({ reason, label }) => ({
    why: reason === 'no-route' && !label ? ui('还没有选择用来出题的 AI 模型。配置好之后回到这里，已填的内容会保留。')
      : ui('出题需要一个可用的 AI 模型。配置好之后回到这里，已填的内容会保留。'),
    then: ui('回到这里，点「生成并检查题组」'),
    line: ui('生成题目需要先配置模型。'),
    note: ui('可以先选好资料和题型；生成前需要先配置模型。'),
  }),
  // Writing a case paper is generating, with its own button to come back to.
  case: (model) => ({
    ...FEATURES.generate(model),
    then: ui('回到这里，点「出一套案例题」'),
  }),
  grade: () => ({
    badge: ui('批改需要模型'),
    why: ui('批改要调用 AI 模型。答案会先保存；配置好模型后点「重新提交批改」。'),
    then: ui('回到这里，点「重新提交批改」'),
    line: ui('批改需要模型；答案会先保存。'),
    note: ui('可以先作答；批改前需要先配置模型。'),
  }),
  ingest: () => ({
    why: ui('录题要调用 AI 模型整理题目。配置好之后回到这里，已填的内容会保留。'),
    then: ui('回到这里，点「开始录题」'),
    line: ui('录题需要模型整理题目。'),
    note: ui('可以先设置题组；录题前需要先配置模型。'),
  }),
  variants: () => ({
    why: ui('生成变式要调用 AI 模型；上面的「为你推荐」不需要模型，现在就能练。'),
    then: ui('回到这里，让 AI 为错题写变式'),
    line: ui('生成变式需要先配置模型。'),
    note: ui('「为你推荐」现在就能练；生成变式前需要先配置模型。'),
  }),
  // Listing the exam points of a course is one build in the background.
  examprep: () => ({
    why: ui('列考点要调用 AI 模型读课件和样卷。配置好之后回到这里，已填的内容会保留。'),
    then: ui('回到这里，点「开始生成」'),
    line: ui('生成考点清单需要先配置模型。'),
    note: ui('可以先选好资料；生成前需要先配置模型。'),
  }),
  translate: () => ({
    why: ui('翻译要调用 AI 模型。配置好之后回到这里再试一次。'),
    then: ui('回到这里，再翻译一次'),
    line: ui('翻译需要先在设置里连接模型。'),
    note: ui('阅读可以继续；翻译前需要先配置模型。'),
  }),
  // The reader: the outline an AI tidies, and asking about a passage or topping up questions from it.
  outline: () => ({
    why: ui('让 AI 整理目录要调用模型。配置好之后回到这里再试一次；现在仍使用自动目录。'),
    then: ui('回到这里，再让 AI 整理一次目录'),
    line: ui('让 AI 整理目录需要先配置模型；仍使用自动目录。'),
    note: ui('阅读可以继续；整理目录前需要先配置模型。'),
  }),
  ask: () => ({
    why: ui('提问和补题要调用 AI 模型；原文与已有引用仍可浏览。'),
    then: ui('回到这里，再提一次问'),
    line: ui('提问和补题需要先配置模型；原文与已有引用仍可浏览。'),
    note: ui('阅读可以继续；提问和补题前需要先配置模型。'),
  }),
  // The reader (ui/document-preview/ReaderModelGate.jsx): questions about a selected passage and top-up questions from it.
  passage: () => ({
    why: ui('针对原文提问和补题要调用 AI 模型。配置好之后回到这里再试一次。'),
    then: ui('回到这里，再提一次问'),
    line: ui('提问和补题需要先配置模型；原文与已有引用仍可浏览。'),
    note: ui('阅读可以继续；提问和补题前需要先配置模型。'),
  }),
  // The first screen: a model is for the questions, the first import and the tour need none.
  welcome: () => ({
    why: ui('出题、讲解和提问需要 AI 模型；示例导览和已有题组的练习不需要，可以先体验。'),
    then: ui('回到这里，点「导入我的第一份资料」'),
    line: ui('出题、讲解和提问需要先配置模型。'),
    note: ui('可以先体验示例；出题前需要先配置模型。'),
  }),
  // Settings › 学习库与模型: the state itself, so the gate there is "not connected" with the choice and the re-check on the same page.
  settings: ({ reason, label }, { recheck } = {}) => ({
    badge: ui('模型未连接'),
    why: say(reason === 'no-route' && !label ? ui('还没有选择 AI 模型。') : '', ui('出题、讲解和批改要用到它；已有的题组不用模型也能练。')),
    pick: ui('在下面的「生成模型」里选一个模型，或在对话输入框的模型选择器里选'),
    then: recheck ? ui('回到这里，状态会变成「模型已连接」；没有变就点「重新检查」') : ui('回到这里，状态会变成「模型已连接」'),
    line: ui('模型还没有连接。'),
    note: ui('模型还没有连接；按下面的步骤配置。'),
  }),
  // Next to controls that are off without a model, or notes that were plain text.
  organize: () => ({
    why: ui('请 AI 建议课程归属要调用 AI 模型；手动选择课程不需要。'),
    then: ui('回到这里，再点「请 AI 建议」'),
    line: ui('请 AI 建议课程归属需要先配置模型；手动选择课程不需要。'),
    note: ui('可以手动选择课程；请 AI 建议前需要先配置模型。'),
  }),
  merge: () => ({
    why: ui('合并建议要调用 AI 模型；也可以在题组管理中手动合并。'),
    then: ui('回到这里，再点「整理题组」'),
    line: ui('合并建议需要先配置模型；也可以在题组管理中手动合并。'),
    note: ui('可以手动合并题组；合并建议前需要先配置模型。'),
  }),
  workflow: () => ({
    why: ui('学习流的讲解和复述反馈要调用 AI 模型；现在会按主题和题组名匹配材料。'),
    then: ui('回到这里，点「开始学」'),
    line: ui('讲解、复述反馈和后台骨架需要先配置模型；现在会按主题和题组名匹配材料。'),
    note: ui('现在会按主题和题组名匹配材料；讲解和复述反馈前需要先配置模型。'),
  }),
  lesson: () => ({
    why: ui('生成讲解要调用 AI 模型；也可以在下方请主对话补充材料。'),
    then: ui('回到这里，点「生成完整讲解」'),
    line: ui('生成讲解需要先配置模型；也可以在下方请主对话补充材料。'),
    note: ui('生成讲解前需要先配置模型；也可以在下方请主对话补充材料。'),
  }),
  skeleton: () => ({
    why: ui('生成知识骨架要调用 AI 模型；也可以请主对话帮你设计骨架。'),
    then: ui('回到这里，点「一键生成本次范围的骨架」'),
    line: ui('一键生成骨架需要先配置模型；也可以请主对话帮你设计骨架。'),
    note: ui('生成骨架前需要先配置模型；也可以请主对话帮你设计骨架。'),
  }),
  plan: () => ({
    why: ui('协商今天的安排要调用 AI 模型；已接受的行动可以继续。'),
    then: ui('回到这里，再试一次'),
    line: ui('协商安排需要先配置模型；已接受的行动可以继续。'),
    note: ui('已接受的行动可以继续；协商安排前需要先配置模型。'),
  }),
  // Organising the course outline (ui/outline/CourseOutline.jsx).
  outline: () => ({
    why: ui('生成总纲要调用 AI 模型；没有总纲时这里按资料列出。'),
    then: ui('回到这里，点「生成总纲」'),
    line: ui('生成总纲需要先配置模型；没有总纲时这里按资料列出。'),
    note: ui('没有总纲时这里按资料列出；生成总纲前需要先配置模型。'),
  }),
  // Drafting a note from questions (ui/BlogNotes.jsx).
  note: () => ({
    why: ui('AI 起草要调用 AI 模型。配置好之后回到这里，点「AI 起草解析」。'),
    then: ui('回到这里，点「AI 起草解析」'),
    line: ui('AI 起草需要先配置模型；也可以自己写。'),
    note: ui('可以先自己写；AI 起草前需要先配置模型。'),
  }),
};

/** Every feature the gate has wording for. */
export const MODEL_GATE_FEATURES = Object.freeze(Object.keys(FEATURES));

/** The one-line wording of the gate for a feature, for a message that is thrown or toasted rather than drawn (feature: see FEATURES). */
export const gateMessage = (feature = 'generate', model) => (FEATURES[feature] || FEATURES.generate)(model || {}).line;

/**
 * variant: 'block' | 'inline' | 'banner' | 'compact'; feature: one of MODEL_GATE_FEATURES. `model` is the readiness ({ ready, reason, label }, see
 * modelReadiness): a ready model renders nothing.
 * onOpenSettings: the button's action. Left out, the page's own way to the model settings is used (ModelSettingsContext, which App provides);
 * `false` draws no button (the page IS the settings, or cannot go anywhere). With no way at all there is no button.
 * onRecheck (block): a second button that reads the state again (`checking`: it is reading); the last step then says so.
 * quiet (block): the button is a plain secondary one, for a page whose own first action is the primary (the first screen).
 * Other props (data-tour…) go to the outer element.
 */
export default function ModelSetupGate({ variant = 'block', feature = 'generate', model, onOpenSettings, onRecheck, checking = false, quiet = false, className, ...rest }) {
  const fromPage = useContext(ModelSettingsContext), label = useModelSettingsLabel();
  if (model?.ready) return null;
  const copy = (FEATURES[feature] || FEATURES.generate)(model || {}, { recheck: !!onRecheck });
  const handler = onOpenSettings === false ? undefined : onOpenSettings ?? fromPage ?? undefined;
  const open = handler ? { label, onClick: handler } : undefined;
  if (variant === 'compact') return <Hint tone="warning" role="status" className={className} data-model-gate="compact" {...rest}>{copy.line}{open && <>{' '}<Button variant="link" size="sm" onClick={open.onClick}>{open.label}</Button></>}</Hint>;
  if (variant === 'inline') return <InlineMessage tone="warning" title={gateTitle('inline')} action={open} className={className} {...rest}>{copy.line}</InlineMessage>;
  if (variant === 'banner') return <Banner tone="warning" title={gateTitle('banner')} action={open} className={className} {...rest}>{copy.note}</Banner>;
  const setup = setupSteps(model || {}, copy.pick);
  return <SetupRequired icon="model" tone={feature === 'grade' ? 'warning' : 'neutral'} badge={copy.badge} title={gateTitle('block')} why={say(modelFact(model || {}), copy.why)}
    steps={setup.length ? [...setup, { text: copy.then }] : []} primary={open && { ...open, icon: 'model', variant: quiet ? 'secondary' : 'primary' }}
    secondary={onRecheck ? { label: checking ? ui('正在检查…') : ui('重新检查'), icon: 'refresh', disabled: checking, onClick: onRecheck } : undefined} className={className} {...rest} />;
}

import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Banner, InlineMessage, SetupRequired } from './components/index.js';

/* "There is no AI model yet", said in one place. Every page that needs a model shows this gate instead of its own wording:
     block   a whole step is replaced by it (the submit area of a form): why, the steps, the one button
     inline  one line next to a control that cannot work (warning tone, with the same button as a link)
     banner  a page-level line above content that can still be prepared
   `feature` says what the model is for. The copy of every combination is in this file and nowhere else. */

/** The gate's headline: the block names the first step, the smaller shapes state the fact. */
export const gateTitle = (variant = 'block') => (variant === 'block' ? ui('先配置一个 AI 模型') : ui('还没有可用的 AI 模型'));

const FIRST_STEPS = () => [{ text: ui('打开模型设置，选择一个服务商') }, { text: ui('填入这个服务商的 API Key') }];

/* Per feature: `why` (block), `then` (the last step of a block), `line` (inline), `note` (banner), `badge` (block, optional). */
const FEATURES = {
  generate: ({ reason, label }) => ({
    why: reason === 'no-credential'
      ? label ? uiFormat('已选择「{0}」，但还没有可用的 API Key。出题要用它调用模型。', [label]) : ui('已选择模型，但还没有可用的 API Key。出题要用它调用模型。')
      : reason === 'no-route' ? ui('还没有选择用来出题的 AI 模型。配置好之后回到这里，已填的内容会保留。')
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
  // The reader (ui/document-preview/ReaderModelGate.jsx): questions about a selected passage and top-up questions from it, and the AI outline.
  passage: () => ({
    why: ui('针对原文提问和补题要调用 AI 模型。配置好之后回到这里再试一次。'),
    then: ui('回到这里，再提一次问'),
    line: ui('提问和补题需要先配置模型；原文与已有引用仍可浏览。'),
    note: ui('阅读可以继续；提问和补题前需要先配置模型。'),
  }),
  outline: () => ({
    why: ui('让 AI 整理目录要调用 AI 模型。配置好之后回到这里再试一次。'),
    then: ui('回到这里，再让 AI 整理一次'),
    line: ui('让 AI 整理目录需要先配置模型；仍使用自动目录。'),
    note: ui('阅读可以继续；整理目录前需要先配置模型。'),
  }),
  // Drafting a note from questions (ui/BlogNotes.jsx).
  note: () => ({
    why: ui('AI 起草要调用 AI 模型。配置好之后回到这里，点「AI 起草解析」。'),
    then: ui('回到这里，点「AI 起草解析」'),
    line: ui('AI 起草需要先配置模型；也可以自己写。'),
    note: ui('可以先自己写；AI 起草前需要先配置模型。'),
  }),
};

/** The one-line wording of the gate for a feature, for a message that is thrown or toasted rather than drawn (feature: see FEATURES). */
export const gateMessage = (feature = 'generate', model) => (FEATURES[feature] || FEATURES.generate)(model || {}).line;

/**
 * variant: 'block' | 'inline' | 'banner'; feature: 'generate' | 'case' | 'grade' | 'ingest' | 'translate' | 'variants' | 'examprep' | 'passage' | 'outline' | 'note'. `model` is the readiness
 * ({ ready, reason, label }, see modelReadiness): a ready model renders nothing. Without onOpenSettings there is no button.
 * Other props (data-tour…) go to the outer element.
 */
export default function ModelSetupGate({ variant = 'block', feature = 'generate', model, onOpenSettings, className, ...rest }) {
  if (model?.ready) return null;
  const copy = (FEATURES[feature] || FEATURES.generate)(model || {});
  const open = onOpenSettings ? { label: ui('打开模型设置'), onClick: onOpenSettings } : undefined;
  if (variant === 'inline') return <InlineMessage tone="warning" title={gateTitle('inline')} action={open} className={className} {...rest}>{copy.line}</InlineMessage>;
  if (variant === 'banner') return <Banner tone="warning" title={gateTitle('banner')} action={open} className={className} {...rest}>{copy.note}</Banner>;
  return <SetupRequired icon="model" tone={feature === 'grade' ? 'warning' : 'neutral'} badge={copy.badge} title={gateTitle('block')} why={copy.why}
    steps={[...FIRST_STEPS(), { text: copy.then }]} primary={open && { ...open, icon: 'model' }} className={className} {...rest} />;
}

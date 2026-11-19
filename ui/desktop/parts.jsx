import React from 'react';
import { ui, uiFormat, uiIsEnglish } from '../i18n.js';
import { Icon } from '../components/index.js';
import DesktopModelSetup from './DesktopModelSetup.jsx';
import DesktopUpgradeGuide from './DesktopUpgradeGuide.jsx';
import DesktopLibraryNotice from './DesktopLibraryNotice.jsx';

/* Desktop host parts registered into shared StudyHub pages via ui/host-parts.js. */

/* The desktop guide's model section, in the reader's language — the same shape as the plugin's keyGuideUrl (ui/ModelSetupGate.jsx).
   The address is the guide on `main`: it opens only once docs/desktop*.md are merged there. */
const GUIDE = 'https://github.com/EricWang1358/dsh-web-studyhub/blob/main/docs/';
export const desktopGuideUrl = () => (uiIsEnglish()
  ? `${GUIDE}desktop.md#configure-a-model`
  : `${GUIDE}desktop.zh-CN.md#${encodeURIComponent('配置模型')}`);

function guideHint() {
  return (
    <>
      {ui('查看桌面版配置说明：')}
      <a href={desktopGuideUrl()} target="_blank" rel="noreferrer">
        {ui('StudyHub 桌面版说明')}
        <Icon className="sh-icon--inline" name="external" />
        <span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span>
      </a>
    </>
  );
}

function modelFact({ reason, label } = {}) {
  if (reason === 'no-credential') {
    return label
      ? uiFormat('已选择「{0}」，但还没有填写 API Key。', [label])
      : ui('已选择模型，但还没有填写 API Key。');
  }
  if (!label) return '';
  if (reason === 'no-route') return uiFormat('已选择「{0}」，但当前配置里没有这个服务商。', [label]);
  if (reason === 'unknown') return uiFormat('已选择「{0}」，但当前暂不可用。', [label]);
  return '';
}

function modelSetupSteps() {
  return [
    {
      text: ui('如果本机已检测到就绪的 agy 或 codex CLI，可直接一键启用本机 CLI；否则选一个国内直连服务商（智谱、硅基流动、DeepSeek）获取 API Key'),
      hint: guideHint(),
      choose: true,
    },
    { text: ui('保存并测试连通，确认状态变为可用') },
  ];
}

function ModelSetup() {
  return <DesktopModelSetup />;
}

function ModelGateForm() {
  return <DesktopModelSetup compact />;
}

function ModelQuickEnable({ onOffer }) {
  return <DesktopModelSetup compact quick onOffer={onOffer} />;
}

function recheckNote() {
  return ui('已重新检查，还没有读到可用的模型。一键启用本机 CLI，或在设置里填好 API Key 后，再点一次「重新检查」。');
}

function runningNote() {
  return ui('有后台任务在进行（转换、转写、出题等）。关闭桌面版窗口会结束正在运行的任务；已完成并通过核验的部分都会保留，下次打开可点「接着做」继续。');
}

export const DESKTOP_PARTS = Object.freeze({
  ModelSetup,
  ModelGateForm,
  ModelQuickEnable,
  modelSetupSteps,
  modelFact,
  recheckNote,
  appearanceDefaults: Object.freeze({ scale: 'auto' }),
  UpgradeGuide: DesktopUpgradeGuide,
  LibraryNotice: DesktopLibraryNotice,
  runningNote,
});

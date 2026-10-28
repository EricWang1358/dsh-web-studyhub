import React from 'react';
import { ui } from '../i18n.js';
import { Icon } from '../components/index.js';
import ZcodeModelSetup from './ZcodeModelSetup.jsx';
import ZcodeUpgradeGuide from './ZcodeUpgradeGuide.jsx';

/* What the ZCode panel puts into the shared pages (ui/host-parts.js). */

const GUIDE = 'https://github.com/EricWang1358/dsh-web-studyhub/blob/zcode/docs/';
const guideHint = () => <>{ui('去哪拿 Key、要不要充值：看')}<a href={`${GUIDE}zcode.zh-CN.md`} target="_blank" rel="noreferrer">{ui('ZCode 版说明')}<Icon name="external" size={14} />
  <span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a>{ui('（以服务商页面为准）')}</>;

/** The model gate's steps here: the endpoint form is in StudyHub, not in the host. */
const modelSetupSteps = () => [
  { text: ui('选一个服务商（智谱、硅基流动、DeepSeek 都能国内直连），按卡片上的两步拿到 API Key'), hint: guideHint(), choose: true },
  { text: ui('粘贴 API Key，点「保存并测试」') },
];

function ModelSetup() { return <ZcodeModelSetup />; }
function ModelGateForm() { return <ZcodeModelSetup compact />; }

export const ZCODE_PARTS = Object.freeze({
  ModelSetup,
  ModelGateForm,
  modelSetupSteps,
  UpgradeGuide: ZcodeUpgradeGuide,
  runningNote: () => ui('有后台任务在进行（转换、转写、出题等）。退出 ZCode 会结束它们；已完成的部分都保留着，重开后点「接着做」继续。'),
});

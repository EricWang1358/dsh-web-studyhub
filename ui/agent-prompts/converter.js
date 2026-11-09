import { getUiLanguage } from '../i18n.js';
import { situationMessage } from './situation.js';

/* The hand-off of a local PDF converter (MinerU or Marker) that did not install, start or pass its check in Settings › PDF 转换
   (ui/MineruInstallCard.jsx, ui/MarkerInstall.jsx, ui/MarkerSettings.jsx). Built on situation.js: the learner's sentence, the converter's
   state and folder in a Situation fence, the raw error and last log lines in an Error fence, and the boundary (the assistant explains
   the failure, asks before touching the machine, and sends the learner back to the button in Settings to finish). */

const HOW = '做法：先根据下面的「情况」和「错误原文」查清报错原因，用大白话告诉我；需要检查或修复这台电脑的环境（例如 Python 版本、目录权限、端口占用、VC++ 运行库或网络源）时，先说明要运行什么命令并等我同意；如果我急着导入 PDF，也可以先帮我把转换结果写到工作区的 studyhub-work/ 下再用 study_materials 的 document.import 导入。';
const HINTS = [
  '边界：安装、卸载或修改 MinerU 与 Marker 设置只能由我在「设置 › PDF 转换」里点按钮完成；环境修好后，直接告诉我回设置页点哪个按钮（例如「修复」「重试」或「重新检测」）。',
];

/**
 * input: { tool ('mineru' | 'marker'), status, stage, code, summary, folder, tier, source, python, version, command, external, log }.
 */
export function converterFailedPrompt({
  tool = 'mineru', status = '', stage = '', code = '', summary = '', folder = '', tier = '', source = '',
  python = '', version = '', command = '', external = '', log = '',
} = {}, language = getUiLanguage()) {
  const isMarker = tool === 'marker';
  const goal = isMarker ? '排查本机 Marker 的报错并解决' : '排查本机 MinerU 的报错并解决';
  const error = [summary, log].filter(Boolean).join('\n\n');
  return situationMessage({
    area: 'PDF 转换设置',
    goal,
    context: 'imports',
    how: HOW,
    hints: HINTS,
    facts: { tool: isMarker ? 'Marker' : 'MinerU', status, stage, code, folder, tier, source, python, version, command, external },
    error,
  }, language);
}

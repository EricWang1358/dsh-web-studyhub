import React from 'react';
import { ui } from '../i18n.js';
import { Icon } from '../components/index.js';

/* Desktop upgrade steps shown inside UpdateDialog instead of DSH's plugin manager flow (ui/host-parts.js). */
export default function DesktopUpgradeGuide({ update }) {
  const address = update?.assetUrl || update?.url || 'https://github.com/EricWang1358/dsh-web-studyhub/releases';
  return (
    <section className="update-guided" aria-label={ui('手动升级')}>
      <p className="update-lead">
        {ui('StudyHub 桌面版暂不支持应用内自动覆盖安装。按下面 3 步升级到新版本，你的学习库、模型配置与设置都会保留：')}
      </p>
      <ol className="update-steps">
        <li>
          <strong>{ui('下载桌面版')}</strong>
          <span>
            <a className="update-release-link" href={address} target="_blank" rel="noreferrer">
              {update?.assetName || ui('前往 GitHub 发布页下载 .msi 或 .zip')}
              <Icon className="sh-icon--inline" name="external" />
              <span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span>
            </a>
          </span>
        </li>
        <li>
          <strong>{ui('退出当前桌面版')}</strong>
          <span>{ui('关闭 StudyHub 桌面版窗口，确保后台任务已停下（已完成的部分会保留）。')}</span>
        </li>
        <li>
          <strong>{ui('安装或解压覆盖')}</strong>
          <span>{ui('运行新版 .msi 安装程序覆盖安装，或将便携版 .zip 解压到固定目录后启动 StudyHub.exe。')}</span>
        </li>
      </ol>
      <p className="update-note">
        {ui('安全提示：开源桌面版暂未购买商业代码签名证书。若 Windows SmartScreen 弹出提醒，请先对照发布页的 SHA256SUMS 核对校验值，确认一致后点「更多信息 → 仍要运行」。')}
      </p>
    </section>
  );
}

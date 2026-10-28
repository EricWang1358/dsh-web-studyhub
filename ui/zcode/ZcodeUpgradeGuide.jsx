import React from 'react';
import { ui } from '../i18n.js';
import { Icon } from '../components/index.js';

/* The upgrade dialog's steps in ZCode (ui/UpdateCenter.jsx asks for this part instead of DSH's plugin-manager steps).
   The same GitHub release carries StudyHub-ZCode-<version>.zip; ZCode cannot install a plugin from inside a panel, so the
   learner downloads it and runs its installer. The release check, the dialog and the release notes stay the shared ones. */
export default function ZcodeUpgradeGuide({ update }) {
  const address = update.assetUrl || update.url;
  return (
    <section className="update-guided" aria-label={ui('手动升级')}>
      <p className="update-lead">{ui('ZCode 版不能在应用内升级。按下面 4 步换成新版本，学习库、模型和设置都会保留：')}</p>
      <ol className="update-steps">
        <li><strong>{ui('下载新版')}</strong><span>
          <a href={address} target="_blank" rel="noreferrer">{update.assetName || ui('查看发布页')}<Icon name="external" size={14} />
            <span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a>
        </span></li>
        <li><strong>{ui('解压')}</strong><span>{ui('解压到一个固定的文件夹（不要放进 Program Files）；可以覆盖旧版所在的文件夹。')}</span></li>
        <li><strong>{ui('运行安装')}</strong><span>{ui('双击文件夹里的 install.bat，等它显示完成。')}</span></li>
        <li><strong>{ui('重启 ZCode')}</strong><span>{ui('完全退出 ZCode 后重新打开；退出会结束所有对话里正在运行的后台任务，已完成的部分会保留。')}</span></li>
      </ol>
      <p className="update-note">{ui('下载的 zip 先右键「属性」勾选「解除锁定」再解压，否则 Windows 可能拦下 install.bat。')}</p>
    </section>
  );
}

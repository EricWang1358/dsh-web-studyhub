import React, { useEffect, useState } from 'react';
import { errorMessage, ui, uiFormat } from '../i18n.js';
import { Button, Icon, InlineMessage, ProgressBar } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { hasTauriBridge, installDesktopUpdate } from './ipc.js';
import css from './desktop.css';

const RELEASES_FALLBACK = 'https://github.com/EricWang1358/dsh-web-studyhub/releases';

function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function progressCaption(progress) {
  if (progress?.phase === 'installing') {
    return ui('签名校验通过，正在安装并重启 StudyHub…');
  }
  if (Number.isFinite(progress?.percent) && Number(progress?.total) > 0) {
    return uiFormat('正在下载更新… {0}%（{1} / {2}）', [
      progress.percent,
      formatByteSize(progress.downloaded),
      formatByteSize(progress.total),
    ]);
  }
  return ui('正在下载并校验更新包…');
}

function resolveManualDownload(update) {
  const info = update || {};
  const address = info.setupUrl || info.assetUrl || info.url || RELEASES_FALLBACK;
  const primaryLabel = info.setupName || info.assetName || ui('前往 GitHub 发布页下载安装包');
  const altLinks = [
    { label: '.msi', url: info.installerUrl },
    { label: '.zip', url: info.zipUrl },
  ].filter((item) => Boolean(item.url) && item.url !== address);
  return { address, primaryLabel, altLinks };
}

function autoUpdateLead(latest) {
  if (latest) {
    return uiFormat('一键更新到 {0}：下载后自动核验官方 Ed25519 签名、关闭本地服务并重启，学习库、模型配置与设置都会保留。', [latest]);
  }
  return ui('一键下载并安装最新桌面版：自动核验官方 Ed25519 签名、关闭本地服务并重启，学习库、模型配置与设置都会保留。');
}

function autoUpdateButtonLabel(phase, progress, latest) {
  if (phase === 'working') {
    return progress?.phase === 'installing' ? ui('正在安装并重启…') : ui('正在下载更新…');
  }
  if (phase === 'error') return ui('重试自动更新');
  return latest ? uiFormat('立即下载并更新到 {0}', [latest]) : ui('立即下载并重启更新');
}

function resolveUpdaterRunner(host) {
  if (typeof host?.updater?.install === 'function') return host.updater.install;
  if (hasTauriBridge()) return (onProgress) => installDesktopUpdate({ onProgress });
  return null;
}

function AutoUpdateFeedback({ phase, progress, error }) {
  if (phase === 'working') {
    const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : null;
    return (
      <div className="desktop-updater__status" role="status">
        <ProgressBar
          value={percent ?? 0}
          max={100}
          indeterminate={percent === null}
          label={ui('更新下载进度')}
        />
        <p className="desktop-updater__caption">{progressCaption(progress)}</p>
      </div>
    );
  }
  if (phase === 'up-to-date') {
    return (
      <InlineMessage tone="info" boxed>
        {ui('当前已是最新可自动更新版本，或新版本的自动更新清单仍在发布中；你也可以展开下方手动下载安装包。')}
      </InlineMessage>
    );
  }
  if (phase === 'error') {
    return (
      <InlineMessage tone="error" boxed title={ui('自动更新没有完成')}>
        <p>{error || ui('无法下载或校验更新包，请重试或改用下方手动下载。')}</p>
        <p>{ui('若提示「无法打开要写入的文件」或安装写入被拦截，请下载下方 Setup.exe 后右键选择「以管理员身份运行」重试。')}</p>
      </InlineMessage>
    );
  }
  return null;
}

function ManualSteps({ update, showLead }) {
  const { address, primaryLabel, altLinks } = resolveManualDownload(update);
  return (
    <div className="desktop-updater__manual-body">
      {showLead && (
        <p className="update-lead">
          {ui('按下面 3 步升级到新版本，你的学习库、模型配置与设置都会保留：')}
        </p>
      )}
      <ol className="update-steps">
        <li>
          <strong>{ui('下载桌面版')}</strong>
          <span>
            <a className="update-release-link" href={address} target="_blank" rel="noreferrer">
              {primaryLabel}
              <Icon className="sh-icon--inline" name="external" />
              <span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span>
            </a>
            {altLinks.length > 0 && (
              <span className="desktop-updater__alt-links">
                {altLinks.map((item) => (
                  <a key={item.label} className="update-release-link" href={item.url} target="_blank" rel="noreferrer">
                    {item.label}
                  </a>
                ))}
              </span>
            )}
          </span>
        </li>
        <li>
          <strong>{ui('退出当前桌面版')}</strong>
          <span>{ui('关闭 StudyHub 桌面版窗口，确保后台任务已停下（已完成的部分会保留）。')}</span>
        </li>
        <li>
          <strong>{ui('安装或解压覆盖')}</strong>
          <span>{ui('运行新版 Setup.exe（或 .msi）覆盖安装，或将便携版 .zip 解压到固定目录后启动 StudyHub.exe。若安装报错无法写入文件，请右键 Setup.exe 选择「以管理员身份运行」重试。')}</span>
        </li>
      </ol>
      <p className="update-note">
        {ui('安全提示：开源桌面版暂未购买商业代码签名证书。若 Windows SmartScreen 弹出提醒，请先点左下角「查看发布页」对照 SHA256SUMS 核对校验值，确认一致后点「更多信息 → 仍要运行」。')}
      </p>
    </div>
  );
}

/* Desktop upgrade panel shown inside UpdateDialog instead of DSH's plugin manager flow (ui/host-parts.js). */
export default function DesktopUpgradeGuide({ update, host, onBusyChange }) {
  useInjectCss(css, 'study-desktop');
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);

  useEffect(() => {
    onBusyChange?.(phase === 'working');
  }, [phase, onBusyChange]);

  useEffect(() => () => {
    onBusyChange?.(false);
  }, [onBusyChange]);

  const runInstall = resolveUpdaterRunner(host);
  const installFlavor = host?.updater?.installFlavor;
  const manualOnlyFlavor = installFlavor === 'msi' || installFlavor === 'portable';
  const canAutoUpdate = typeof runInstall === 'function' && !manualOnlyFlavor;

  async function startAutoUpdate() {
    if (!runInstall || phase === 'working') return;
    setPhase('working');
    setError('');
    setProgress({ phase: 'downloading', downloaded: 0, total: null, percent: 0 });
    try {
      const receipt = await runInstall((next) => {
        if (next && typeof next === 'object') setProgress(next);
      });
      setPhase(receipt?.status === 'up-to-date' ? 'up-to-date' : 'idle');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('error');
      setManualOpen(true);
    }
  }

  return (
    <section className="update-guided" aria-label={canAutoUpdate ? ui('一键自动更新') : ui('手动升级')}>
      {canAutoUpdate ? (
        <>
          <div className="desktop-updater" data-desktop-auto-update={phase}>
            <p className="update-lead">{autoUpdateLead(update?.latest)}</p>
            <div className="desktop-updater__actions">
              <Button
                variant="primary"
                icon="sparkle"
                busy={phase === 'working'}
                disabled={phase === 'working'}
                onClick={startAutoUpdate}
              >
                {autoUpdateButtonLabel(phase, progress, update?.latest)}
              </Button>
            </div>
            <AutoUpdateFeedback phase={phase} progress={progress} error={error} />
          </div>
          <details
            className="desktop-updater__manual"
            open={manualOpen}
            onToggle={(event) => setManualOpen(event.currentTarget.open)}
          >
            <summary className="desktop-updater__manual-summary">
              {ui('改用手动下载（Setup.exe / .msi / .zip）')}
            </summary>
            <ManualSteps update={update} showLead={false} />
          </details>
        </>
      ) : (
        <>
          {manualOnlyFlavor && (
            <InlineMessage tone="info" boxed>
              {ui('当前是 MSI 或便携版安装，为避免与 Setup.exe 并存产生重复安装，请使用下方手动下载升级。')}
            </InlineMessage>
          )}
          <ManualSteps update={update} showLead />
        </>
      )}
    </section>
  );
}

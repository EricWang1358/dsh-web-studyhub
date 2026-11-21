import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
// Global sheets in the same cascade order as ui/host/workspace.jsx (imported as CSS text strings under loader: { '.css': 'text' }).
import baseStylesCss from './styles.js';
import appearanceThemesCss from './appearance-themes.css';
import appearanceCraftCss from './appearance-craft.css';
import accentCss from './accent.css';
import audioDashboardCss from './audio-dashboard.css';
import App from './App.jsx';
import StudyBoundary from './host/StudyBoundary.jsx';
import { InlineMessage, LoadingState } from './components/index.js';
import { useComponentCss } from './components/css.js';
import { ui } from './i18n.js';
import { registerHostParts } from './host-parts.js';
import { DESKTOP_PARTS } from './desktop/parts.jsx';
import {
  createDesktopCall,
  createDesktopEventSubscription,
  createDesktopHost,
  createSidecarConnection,
  installExternalLinkHandler,
  listenTauriEvent,
  loadBootstrapInfo,
  readDesktopConcurrency,
  subscribeDesktopConcurrency,
  syncDesktopConcurrency,
} from './desktop/ipc.js';

const GLOBAL_CSS = [baseStylesCss, appearanceThemesCss, appearanceCraftCss, accentCss, audioDashboardCss]
  .filter((sheet) => typeof sheet === 'string')
  .join('\n');

document.title = 'StudyHub';
registerHostParts(DESKTOP_PARTS);

function DesktopRoot() {
  useComponentCss(GLOBAL_CSS, 'study-desktop-globals');
  const [boot, setBoot] = useState({ status: 'loading', rpc: null, subscribeLibraryEvents: null, installFlavor: undefined, error: '' });
  const [sidecarCrash, setSidecarCrash] = useState('');
  const [concurrency, setConcurrency] = useState(() => readDesktopConcurrency());

  useEffect(() => subscribeDesktopConcurrency(setConcurrency), []);

  useEffect(() => {
    let active = true;
    let cleanupLinks = () => {};
    let unlistenRestart = () => {};
    let unlistenCrash = () => {};
    loadBootstrapInfo()
      .then(async (info) => {
        if (!active) return;
        const connection = createSidecarConnection(info);
        const rpc = createDesktopCall(connection);
        const subscribeLibraryEvents = createDesktopEventSubscription({ connection });
        cleanupLinks = installExternalLinkHandler(rpc);
        unlistenRestart = await listenTauriEvent('desktop-sidecar-restarted', (payload) => {
          if (!active || !payload?.baseUrl) return;
          connection.update(payload);
          setSidecarCrash('');
        });
        unlistenCrash = await listenTauriEvent('desktop-sidecar-crashed', (payload) => {
          if (!active) return;
          setSidecarCrash(payload?.error || ui('桌面版后台引擎意外停止，且已达到自动重启上限。请关闭并重新打开 StudyHub。'));
        });
        try {
          const cfg = await rpc('desktop.config.get', {});
          if (active) syncDesktopConcurrency(cfg?.effective);
        } catch {
          // Sidecar config probe is best-effort during bootstrap.
        }
        if (active) setBoot({ status: 'ready', rpc, subscribeLibraryEvents, installFlavor: info.installFlavor, error: '' });
      })
      .catch((failure) => {
        if (active) setBoot({ status: 'error', rpc: null, subscribeLibraryEvents: null, installFlavor: undefined, error: failure?.message || ui('无法连接到 StudyHub 桌面版引擎。') });
      });
    return () => {
      active = false;
      cleanupLinks();
      unlistenRestart();
      unlistenCrash();
    };
  }, []);

  const host = useMemo(
    () => createDesktopHost(boot.rpc, concurrency, boot.subscribeLibraryEvents, { installFlavor: boot.installFlavor }),
    [boot.rpc, concurrency, boot.subscribeLibraryEvents, boot.installFlavor],
  );

  if (boot.status === 'loading') {
    return (
      <div className="study-app">
        <LoadingState className="app-loading" label={ui('正在启动 StudyHub 桌面版…')} />
      </div>
    );
  }
  if (boot.status === 'error') {
    return (
      <div className="study-app">
        <InlineMessage tone="error" boxed title={ui('桌面版启动失败')}>
          {boot.error}
        </InlineMessage>
      </div>
    );
  }
  return (
    <StudyBoundary>
      {sidecarCrash && (
        <div className="study-app">
          <InlineMessage tone="error" boxed title={ui('后台引擎已停止')}>
            {sidecarCrash}
          </InlineMessage>
        </div>
      )}
      <App call={boot.rpc} host={host} />
    </StudyBoundary>
  );
}

createRoot(document.getElementById('root')).render(<DesktopRoot />);

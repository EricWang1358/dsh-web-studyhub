import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
// Global sheets in the same cascade order as ui/host/workspace.jsx (imported as CSS text strings under loader: { '.css': 'text' }).
import baseStylesCss from './styles.js';
import appearanceThemesCss from './appearance-themes.css';
import appearanceCraftCss from './appearance-craft.css';
import accentCss from './accent.css';
import audioDashboardCss from './audio-dashboard.css';
import App from './App.jsx';
import { InlineMessage, LoadingState } from './components/index.js';
import { useComponentCss } from './components/css.js';
import { ui } from './i18n.js';
import { registerHostParts } from './host-parts.js';
import { DESKTOP_PARTS } from './desktop/parts.jsx';
import {
  createDesktopCall,
  createDesktopEventSubscription,
  createDesktopHost,
  installExternalLinkHandler,
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
  const [boot, setBoot] = useState({ status: 'loading', rpc: null, subscribeLibraryEvents: null, error: '' });
  const [concurrency, setConcurrency] = useState(() => readDesktopConcurrency());

  useEffect(() => subscribeDesktopConcurrency(setConcurrency), []);

  useEffect(() => {
    let active = true;
    let cleanupLinks = () => {};
    loadBootstrapInfo()
      .then(async (info) => {
        if (!active) return;
        const rpc = createDesktopCall(info);
        const subscribeLibraryEvents = createDesktopEventSubscription(info);
        cleanupLinks = installExternalLinkHandler(rpc);
        try {
          const cfg = await rpc('desktop.config.get', {});
          if (active) syncDesktopConcurrency(cfg?.effective);
        } catch {
          // Sidecar config probe is best-effort during bootstrap.
        }
        if (active) setBoot({ status: 'ready', rpc, subscribeLibraryEvents, error: '' });
      })
      .catch((failure) => {
        if (active) setBoot({ status: 'error', rpc: null, subscribeLibraryEvents: null, error: failure?.message || ui('无法连接到 StudyHub 桌面版引擎。') });
      });
    return () => {
      active = false;
      cleanupLinks();
    };
  }, []);

  const host = useMemo(
    () => createDesktopHost(boot.rpc, concurrency, boot.subscribeLibraryEvents),
    [boot.rpc, concurrency, boot.subscribeLibraryEvents],
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
  return <App call={boot.rpc} host={host} />;
}

createRoot(document.getElementById('root')).render(<DesktopRoot />);

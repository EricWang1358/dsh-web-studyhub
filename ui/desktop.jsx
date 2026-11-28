import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
// Global sheets in the same cascade order as ui/host/workspace.jsx (imported as CSS text strings under loader: { '.css': 'text' }).
import baseStylesCss from './styles.js';
import appearanceThemesCss from './appearance-themes.css';
import appearanceCraftCss from './appearance-craft.css';
import appearanceMinimalCss from './appearance-minimal.css';
import accentCss from './accent.css';
import audioDashboardCss from './audio-dashboard.css';
import App from './App.jsx';
import StudyBoundary from './host/StudyBoundary.jsx';
import { InlineMessage, LoadingState } from './components/index.js';
import { useComponentCss } from './components/css.js';
import { errorMessage, ui, uiLanguageReady, useUiLanguage } from './i18n.js';
import { useAppearance, useAppearanceAttrs } from './use-appearance.js';
import { seatAttrs } from './appearance-prefs.js';
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

const DESKTOP_SHELL_CSS = `
@layer study.features {
  .study-desktop-shell {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background-color: var(--bg-canvas);
  }
  .study-desktop-shell > .study-app {
    flex: 1 1 0;
    min-height: 0;
    height: auto;
  }
  .study-desktop-crash {
    flex: 0 0 auto;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--line);
    background-color: var(--bg-canvas);
  }
  .study-desktop-boot {
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
  }
}
`;

const GLOBAL_CSS = [baseStylesCss, appearanceThemesCss, appearanceCraftCss, appearanceMinimalCss, accentCss, audioDashboardCss, DESKTOP_SHELL_CSS]
  .filter((sheet) => typeof sheet === 'string')
  .join('\n');

const EMPTY_BOOT = Object.freeze({ status: 'loading', rpc: null, subscribeLibraryEvents: null, installFlavor: undefined, error: '' });

export function DesktopRoot({ initialBoot = null, initialCrash = null, AppComponent = App } = {}) {
  useUiLanguage();
  useComponentCss(GLOBAL_CSS, 'study-desktop-globals');
  const [prefs] = useAppearance();
  const look = useAppearanceAttrs(prefs);
  const seatLook = seatAttrs(look);
  const [boot, setBoot] = useState(() => initialBoot || EMPTY_BOOT);
  // Keep crash state structured so the default fallback message translates at render time when UI language changes.
  const [sidecarCrash, setSidecarCrash] = useState(() => (initialCrash ? { detail: initialCrash } : null));
  const [bootAttempt, setBootAttempt] = useState(0);
  const [concurrency, setConcurrency] = useState(() => readDesktopConcurrency());

  const retryBoot = useCallback(() => {
    setBoot(EMPTY_BOOT);
    setBootAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => subscribeDesktopConcurrency(setConcurrency), []);

  useEffect(() => {
    if (initialBoot) return undefined;
    let active = true;
    let connection = null;
    let cleanupLinks = () => {};
    let unlistenRestart = () => {};
    let unlistenCrash = () => {};

    const attachListeners = async () => {
      const stopRestart = await listenTauriEvent('desktop-sidecar-restarted', (payload) => {
        if (!active || !payload?.baseUrl) return;
        if (connection) {
          connection.update(payload);
          setSidecarCrash(null);
          return;
        }
        // If startup failed during the watchdog restart window, automatically re-bootstrap once the sidecar is back.
        setBoot(EMPTY_BOOT);
        setBootAttempt((attempt) => attempt + 1);
      });
      if (!active) {
        stopRestart();
        return;
      }
      unlistenRestart = stopRestart;

      const stopCrash = await listenTauriEvent('desktop-sidecar-crashed', (payload) => {
        if (!active) return;
        setSidecarCrash({ detail: payload?.error ? errorMessage(payload.error) : '' });
      });
      if (!active) {
        stopCrash();
        return;
      }
      unlistenCrash = stopCrash;
    };

    const listenersReady = attachListeners().catch(() => {});

    loadBootstrapInfo()
      .then(async (info) => {
        if (!active) return;
        await listenersReady;
        if (!active) return;
        connection = createSidecarConnection(info);
        const rpc = createDesktopCall(connection);
        const subscribeLibraryEvents = createDesktopEventSubscription({ connection });
        cleanupLinks = installExternalLinkHandler(rpc);
        try {
          const cfg = await rpc('desktop.config.get', {});
          if (active) syncDesktopConcurrency(cfg?.effective);
        } catch {
          // Sidecar config probe is best-effort during bootstrap.
        }
        if (active) setBoot({ status: 'ready', rpc, subscribeLibraryEvents, installFlavor: info.installFlavor, error: '' });
      })
      .catch((failure) => {
        if (!active) return;
        const detail = errorMessage(failure);
        setBoot({ status: 'error', rpc: null, subscribeLibraryEvents: null, installFlavor: undefined, error: detail });
      });

    return () => {
      active = false;
      cleanupLinks();
      unlistenRestart();
      unlistenCrash();
    };
  }, [bootAttempt, initialBoot]);

  const host = useMemo(
    () => createDesktopHost(boot.rpc, concurrency, boot.subscribeLibraryEvents, { installFlavor: boot.installFlavor }),
    [boot.rpc, concurrency, boot.subscribeLibraryEvents, boot.installFlavor],
  );

  if (boot.status === 'loading') {
    return (
      <div className="study-app study-desktop-boot" {...look}>
        <LoadingState className="app-loading" label={ui('正在启动 StudyHub 桌面版…')} />
      </div>
    );
  }
  if (boot.status === 'error') {
    return (
      <div className="study-app study-desktop-boot" {...look}>
        <InlineMessage tone="error" boxed title={ui('桌面版启动失败')} action={{ label: ui('重试'), onClick: retryBoot }}>
          {boot.error || ui('无法连接到 StudyHub 桌面版引擎。')}
        </InlineMessage>
      </div>
    );
  }
  return (
    <div className="study-seat study-desktop-shell" {...seatLook}>
      <StudyBoundary>
        {sidecarCrash && (
          <div className="study-desktop-crash">
            <InlineMessage tone="error" boxed title={ui('后台引擎已停止')}>
              {sidecarCrash.detail || ui('桌面版后台引擎意外停止，且已达到自动重启上限。请关闭并重新打开 StudyHub。')}
            </InlineMessage>
          </div>
        )}
        <AppComponent call={boot.rpc} host={host} />
      </StudyBoundary>
    </div>
  );
}

export async function mountDesktopApp() {
  if (typeof document === 'undefined') return;
  document.title = 'StudyHub';
  registerHostParts(DESKTOP_PARTS);
  await uiLanguageReady();
  const rootElement = document.getElementById('root');
  if (rootElement) createRoot(rootElement).render(<DesktopRoot />);
}

if (typeof document !== 'undefined' && document.getElementById('root')) {
  void mountDesktopApp();
}

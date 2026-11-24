import React, { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from './components/key-dispatcher.js';
import type { CommandPaletteItem, PageId, ThemeId, UiLanguage, ViewProps } from './types/contracts.js';
import { t, useTuiStore } from './state/store.js';
import { computeSnapshotFingerprint } from './state/snapshot-fingerprint.js';
import { loadTuiPreferences, saveTuiPreferences } from './host/tui-prefs.js';
import type { TuiHost } from './host/tui-host.js';
import { Panel } from './components/Panel.js';
import { Spinner } from './components/Badge.js';
import { useTheme } from './theme/tokens.js';
import { nextThemeId } from './theme/index.js';
import { AppShell } from './shell/AppShell.js';
import { createDefaultShellActions, type ShellActions } from './shell/actions.js';

// Lazy-load all views & voice pack modal for fast cold start, tiny App.mjs (~51 KB), and lower idle RSS.
const LibraryView = lazy(() => import('./views/library/LibraryView.js').then((m) => ({ default: m.LibraryView })));

const VoicePackModal = lazy(() => import('./views/library/VoicePackModal.js').then((m) => ({ default: m.VoicePackModal })));

const ReviewView = lazy(() => import('./views/review/ReviewView.js').then((m) => ({ default: m.ReviewView })));
const SourcesView = lazy(() => import('./views/sources/SourcesView.js').then((m) => ({ default: m.SourcesView })));
const GenerateView = lazy(() => import('./views/generate/GenerateView.js').then((m) => ({ default: m.GenerateView })));
const WrongBookView = lazy(() => import('./views/wrongbook/WrongBookView.js').then((m) => ({ default: m.WrongBookView })));
const ExamView = lazy(() => import('./views/exam/ExamView.js').then((m) => ({ default: m.ExamView })));
const DashboardView = lazy(() => import('./views/dashboard/DashboardView.js').then((m) => ({ default: m.DashboardView })));
const BookView = lazy(() => import('./views/book/BookView.js').then((m) => ({ default: m.BookView })));
const SkeletonView = lazy(() => import('./views/skeleton/SkeletonView.js').then((m) => ({ default: m.SkeletonView })));
const ExamCoachView = lazy(() => import('./views/examcoach/ExamCoachView.js').then((m) => ({ default: m.ExamCoachView })));
const ExamPrepView = lazy(() => import('./views/examprep/ExamPrepView.js').then((m) => ({ default: m.ExamPrepView })));
const NotesView = lazy(() => import('./views/notes/NotesView.js').then((m) => ({ default: m.NotesView })));
const BoardView = lazy(() => import('./views/board/BoardView.js').then((m) => ({ default: m.BoardView })));
const TasksView = lazy(() => import('./views/tasks/TasksView.js').then((m) => ({ default: m.TasksView })));
const AudioView = lazy(() => import('./views/audio/AudioView.js').then((m) => ({ default: m.AudioView })));
const SettingsView = lazy(() => import('./views/settings/SettingsView.js').then((m) => ({ default: m.SettingsView })));

interface ErrorBoundaryProps {
  page: PageId;
  lang: UiLanguage;
  isActive: boolean;
  onReset: () => void;
  onGoLibrary: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.page !== this.props.page && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const { page, lang, isActive, onReset, onGoLibrary } = this.props;
    const rawMsg = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return (
      <ViewCrashFallback
        page={page}
        message={rawMsg}
        lang={lang}
        isActive={isActive}
        onRetry={() => {
          this.setState({ error: null });
          onReset();
        }}
        onGoLibrary={() => {
          this.setState({ error: null });
          onGoLibrary();
        }}
      />
    );
  }
}

function ViewCrashFallback({
  page,
  message,
  lang,
  isActive,
  onRetry,
  onGoLibrary,
}: {
  page: PageId;
  message: string;
  lang: UiLanguage;
  isActive: boolean;
  onRetry: () => void;
  onGoLibrary: () => void;
}) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  useInput(
    (input) => {
      if (input === 'r' || input === 'R') onRetry();
      else if (input === '1') onGoLibrary();
    },
    { isActive },
  );
  const clean = message.replace(/\s+/g, ' ').trim();
  const ellipsis = asciiMode ? '...' : '…';
  const summary = clean
    ? clean.length > 240
      ? `${clean.slice(0, 237)}${ellipsis}`
      : clean
    : t(lang, '未知页面渲染错误', 'Unknown view rendering error');
  return (
    <Box flexDirection="column" padding={1}>
      <Panel
        title={t(lang, '页面渲染异常', 'View Error')}
        subtitle={page}
        icon={asciiMode ? '!' : '▲'}
        tone="error"
        focused
      >
        <Text color={theme.error}>{summary}</Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>
            {t(lang, '按 [r] 重试当前页面，或按 [1] 返回学习库。', 'Press [r] to retry, or [1] to return to Library.')}
          </Text>
        </Box>
      </Panel>
    </Box>
  );
}

function LazyFallback({ lang }: { lang: UiLanguage }) {
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  return (
    <Box padding={1}>
      <Spinner label={t(lang, `正在加载页面${ell}`, `Loading view${ell}`)} tone="primary" />
    </Box>
  );
}

export interface StudyHubTuiAppProps {
  host: TuiHost;
  initialPage?: PageId;
  initialTheme?: ThemeId;
  initialLanguage?: UiLanguage;
  initialAsciiMode?: boolean;
  autoLaunchpad?: boolean;
  onExit?: () => void;
}

export function StudyHubTuiApp({
  host,
  initialPage,
  initialTheme,
  initialLanguage,
  initialAsciiMode,
  autoLaunchpad = true,
  onExit,
}: StudyHubTuiAppProps) {
  const lang = useTuiStore((s) => s.preferences.language);
  const syncInFlightRef = useRef<Promise<void> | null>(null);
  const syncPendingRef = useRef(false);
  const syncPendingSilentRef = useRef(true);
  const lastSnapshotFingerprintRef = useRef<string | null>(null);
  const lastBindingJsonRef = useRef<string | null>(null);
  const lastConfigJsonRef = useRef<string | null>(null);

  const syncFromHost = useCallback(
    async (silent = false): Promise<void> => {
      if (syncInFlightRef.current) {
        syncPendingRef.current = true;
        if (!silent) syncPendingSilentRef.current = false;
        await syncInFlightRef.current;
        return;
      }

      const run = (async () => {
        let curSilent = silent;
        while (true) {
          const store = useTuiStore.getState();
          if (!curSilent && !store.refreshing) store.setRefreshing(true);
          try {
            const res = await host.refreshSnapshot();
            if (res.snapshot) {
              const snapFingerprint = computeSnapshotFingerprint(res.snapshot);
              if (snapFingerprint !== lastSnapshotFingerprintRef.current) {
                lastSnapshotFingerprintRef.current = snapFingerprint;
                store.setSnapshot(res.snapshot);
              }
            }
            if (res.binding) {
              const bindJson = JSON.stringify(res.binding);
              if (bindJson !== lastBindingJsonRef.current) {
                lastBindingJsonRef.current = bindJson;
                store.setBinding(res.binding);
              }
            }
            if (res.config) {
              const cfgJson = JSON.stringify(res.config);
              if (cfgJson !== lastConfigJsonRef.current) {
                lastConfigJsonRef.current = cfgJson;
                store.setDesktopConfig(res.config);
              }
            }
            if (store.lastError !== res.error) {
              store.setLastError(res.error);
            }
          } catch (err) {
            store.setLastError(err instanceof Error ? err.message : String(err));
          } finally {
            const latest = useTuiStore.getState();
            if (latest.loading) latest.setLoading(false);
            if (latest.refreshing) latest.setRefreshing(false);
          }

          if (!syncPendingRef.current) break;
          syncPendingRef.current = false;
          curSilent = syncPendingSilentRef.current;
          syncPendingSilentRef.current = true;
        }
      })();

      syncInFlightRef.current = run;
      try {
        await run;
      } finally {
        syncInFlightRef.current = null;
      }
    },
    [host],
  );

  // Initial preferences, CLI overrides, snapshot bootstrap, and live event subscription
  useEffect(() => {
    let alive = true;

    const boot = async () => {
      try {
        const savedPrefs = await loadTuiPreferences({ env: { DSH_HOME: host.dshHome } });
        if (!alive) return;
        const merged = {
          ...savedPrefs,
          ...(initialTheme ? { theme: initialTheme } : {}),
          ...(initialLanguage ? { language: initialLanguage } : {}),
          ...(initialAsciiMode !== undefined ? { asciiMode: initialAsciiMode } : {}),
        };
        const store = useTuiStore.getState();
        store.setPreferences(merged);
        host.setLanguage(merged.language);
        if (initialPage) {
          store.navigate(initialPage);
        }
      } catch {
        // Fallback to defaults if prefs read fails
      }

      if (!alive) return;
      await syncFromHost(false);

      // Refresh config pill once background agy CLI auto-probe settles
      host.autoProbe
        .then((probe) => {
          if (!alive) return;
          const cfg = host.getConfig();
          if (cfg) useTuiStore.getState().setDesktopConfig(cfg);
          if (probe.outcome === 'agy-selected' && probe.agy) {
            const curLang = useTuiStore.getState().preferences.language;
            useTuiStore
              .getState()
              .notify(
                t(
                  curLang,
                  `已自动启用主模型：agy CLI (${probe.agy.model})`,
                  `Auto-enabled primary model: agy CLI (${probe.agy.model})`,
                ),
                'success',
              );
          }
        })
        .catch(() => {});
    };

    void boot();

    const unsubscribe = host.subscribeEvents((event) => {
      if (!alive) return;
      // Matches TUI_CONFIG_CHANGED_EVENT in host/tui-host.ts without statically pulling tui-host/desktop-deps/presets into App.mjs.
      if (event.type === 'tui:config-changed') {
        const cfg = host.getConfig();
        if (cfg) useTuiStore.getState().setDesktopConfig(cfg);
        void syncFromHost(true);
        return;
      }
      void syncFromHost(true);
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [host, initialAsciiMode, initialLanguage, initialPage, initialTheme, syncFromHost]);

  const shellActions = useMemo<Partial<ShellActions>>(() => {
    const base = createDefaultShellActions(host, () => onExit?.());
    return {
      ...base,
      refresh: async () => {
        await syncFromHost(false);
      },
      cycleTheme: () => {
        const cur = useTuiStore.getState().preferences.theme;
        const next = nextThemeId(cur);
        useTuiStore.getState().setTheme(next);
        void saveTuiPreferences({ theme: next }, { env: { DSH_HOME: host.dshHome } }).catch(() => {});
        const l = useTuiStore.getState().preferences.language;
        useTuiStore.getState().notify(t(l, `主题已切换：${next}`, `Theme: ${next}`), 'info');
      },
      toggleLanguage: () => {
        const cur = useTuiStore.getState().preferences.language;
        const next: UiLanguage = cur === 'zh' ? 'en' : 'zh';
        useTuiStore.getState().setLanguage(next);
        host.setLanguage(next);
        void saveTuiPreferences({ language: next }, { env: { DSH_HOME: host.dshHome } }).catch(() => {});
        useTuiStore.getState().notify(next === 'en' ? 'Language: English' : '界面语言：简体中文', 'info');
      },
      quit: () => {
        onExit?.();
      },
    };
  }, [host, onExit, syncFromHost]);

  const extraCommands = useMemo<CommandPaletteItem[]>(() => {
    const curLang = lang;
    return [
      {
        id: 'cmd:toggle-math',
        label: t(curLang, '切换 LaTeX / Unicode 数学公式渲染', 'Toggle LaTeX / Unicode Math Rendering'),
        category: t(curLang, '外观', 'View'),
        keywords: ['math', 'latex', 'unicode', 'formula', '公式'],
        action: () => {
          const prev = useTuiStore.getState().preferences.mathUnicode;
          const next = !prev;
          useTuiStore.getState().setPreferences({ mathUnicode: next });
          void saveTuiPreferences({ mathUnicode: next }, { env: { DSH_HOME: host.dshHome } }).catch(() => {});
          useTuiStore
            .getState()
            .notify(
              t(curLang, next ? '已开启 Unicode 数学公式渲染' : '已切换为原始 LaTeX 显示', next ? 'Unicode Math enabled' : 'Raw LaTeX mode'),
              'info',
            );
        },
      },
      {
        id: 'cmd:rescan-models',
        label: t(curLang, '重新扫描 agy / codex 本地模型', 'Re-scan Local agy / codex Providers'),
        category: t(curLang, '模型', 'Model'),
        keywords: ['agy', 'codex', 'scan', 'model', '模型', '扫描'],
        action: async () => {
          const ell = useTuiStore.getState().preferences.asciiMode ? '...' : '…';
          useTuiStore.getState().notify(t(curLang, `正在扫描本地模型 CLI${ell}`, `Scanning local CLI providers${ell}`), 'info');
          const providers = await host.rescanProviders(true);
          const cfg = host.getConfig();
          if (cfg) useTuiStore.getState().setDesktopConfig(cfg);
          const agy = providers.find((p) => p.id === 'agy');
          useTuiStore
            .getState()
            .notify(
              agy?.ready
                ? t(curLang, `agy CLI 就绪 (${agy.models?.length ?? 0} 个模型)`, `agy CLI ready (${agy.models?.length ?? 0} models)`)
                : t(curLang, '扫描完成，请前往设置查看详情', 'Scan complete — check Settings'),
              agy?.ready ? 'success' : 'warning',
            );
        },
      },
      {
        id: 'cmd:launchpad',
        label: t(curLang, '打开欢迎页 / 快速引导 (Launchpad)', 'Open Welcome Launchpad'),
        category: t(curLang, '导航', 'Navigation'),
        keywords: ['launchpad', 'welcome', 'home', '欢迎', '引导'],
        action: () => {
          useTuiStore.getState().setShowLaunchpad(true);
        },
      },
    ];
  }, [host, lang]);

  const renderPage = useCallback(
    (page: PageId, viewProps: ViewProps) => {
      const content = (() => {
        switch (page) {
          case 'library':
            return <LibraryView {...viewProps} />;
          case 'review':
            return <ReviewView {...viewProps} />;
          case 'sources':
            return <SourcesView {...viewProps} />;
          case 'generate':
            return <GenerateView {...viewProps} />;
          case 'wrongbook':
            return <WrongBookView {...viewProps} />;
          case 'exam':
            return <ExamView {...viewProps} />;
          case 'dashboard':
            return <DashboardView {...viewProps} />;
          case 'book':
            return <BookView {...viewProps} />;
          case 'skeleton':
            return <SkeletonView {...viewProps} />;
          case 'examcoach':
            return <ExamCoachView {...viewProps} />;
          case 'examprep':
            return <ExamPrepView {...viewProps} />;
          case 'notes':
            return <NotesView {...viewProps} />;
          case 'board':
            return <BoardView {...viewProps} />;
          case 'tasks':
            return <TasksView {...viewProps} />;
          case 'audio':
            return <AudioView {...viewProps} />;
          case 'settings':
            return <SettingsView {...viewProps} />;
          default:
            return <LibraryView {...viewProps} />;
        }
      })();

      return (
        <ViewErrorBoundary
          page={page}
          lang={lang}
          isActive={viewProps.isActive}
          onReset={() => void syncFromHost(false)}
          onGoLibrary={() => useTuiStore.getState().navigate('library')}
        >
          <Suspense fallback={<LazyFallback lang={lang} />}>{content}</Suspense>
        </ViewErrorBoundary>
      );
    },
    [lang, syncFromHost],
  );

  return (
    <AppShell
      host={host}
      renderPage={renderPage}
      actions={shellActions}
      extraCommands={extraCommands}
      autoLaunchpad={autoLaunchpad}
      renderVoicePack={(props) => (
        <Suspense fallback={null}>
          <VoicePackModal {...props} host={host} />
        </Suspense>
      )}
    />
  );
}

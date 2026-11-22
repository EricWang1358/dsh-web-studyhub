import React, { Component, Suspense, lazy, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CommandPaletteItem, PageId, ThemeId, UiLanguage, ViewProps } from './types/contracts.js';
import { t, useTuiStore } from './state/store.js';
import {
  TUI_CONFIG_CHANGED_EVENT,
  loadTuiPreferences,
  saveTuiPreferences,
  type TuiHost,
} from './host/index.js';
import { Panel, Spinner, useTheme } from './components/index.js';
import { nextThemeId } from './theme/index.js';
import { AppShell, createDefaultShellActions, type ShellActions } from './shell/index.js';

// Eagerly load the default landing view & voice pack modal; lazy-load secondary views for fast cold start and lower idle RSS.
import { LibraryView, VoicePackModal } from './views/library/index.js';

const ReviewView = lazy(() => import('./views/review/index.js').then((m) => ({ default: m.ReviewView })));
const SourcesView = lazy(() => import('./views/sources/index.js').then((m) => ({ default: m.SourcesView })));
const GenerateView = lazy(() => import('./views/generate/index.js').then((m) => ({ default: m.GenerateView })));
const WrongBookView = lazy(() => import('./views/wrongbook/index.js').then((m) => ({ default: m.WrongBookView })));
const ExamView = lazy(() => import('./views/exam/index.js').then((m) => ({ default: m.ExamView })));
const DashboardView = lazy(() => import('./views/dashboard/index.js').then((m) => ({ default: m.DashboardView })));
const BookView = lazy(() => import('./views/book/index.js').then((m) => ({ default: m.BookView })));
const SkeletonView = lazy(() => import('./views/skeleton/index.js').then((m) => ({ default: m.SkeletonView })));
const ExamCoachView = lazy(() => import('./views/examcoach/index.js').then((m) => ({ default: m.ExamCoachView })));
const ExamPrepView = lazy(() => import('./views/examprep/index.js').then((m) => ({ default: m.ExamPrepView })));
const NotesView = lazy(() => import('./views/notes/index.js').then((m) => ({ default: m.NotesView })));
const BoardView = lazy(() => import('./views/board/index.js').then((m) => ({ default: m.BoardView })));
const TasksView = lazy(() => import('./views/tasks/index.js').then((m) => ({ default: m.TasksView })));
const AudioView = lazy(() => import('./views/audio/index.js').then((m) => ({ default: m.AudioView })));
const SettingsView = lazy(() => import('./views/settings/index.js').then((m) => ({ default: m.SettingsView })));

interface ErrorBoundaryProps {
  page: PageId;
  lang: UiLanguage;
  onReset: () => void;
  onGoLibrary: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ViewErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
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
    const { lang, onReset, onGoLibrary } = this.props;
    return (
      <ViewCrashFallback
        message={this.state.error.message || String(this.state.error)}
        lang={lang}
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
  message,
  lang,
  onRetry,
  onGoLibrary,
}: {
  message: string;
  lang: UiLanguage;
  onRetry: () => void;
  onGoLibrary: () => void;
}) {
  const theme = useTheme();
  useInput((input) => {
    if (input === 'r') onRetry();
    else if (input === '1') onGoLibrary();
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Panel title={t(lang, '页面渲染异常', 'View Error')} tone="error" focused>
        <Text color={theme.error}>{message}</Text>
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
  return (
    <Box padding={1}>
      <Spinner label={t(lang, '正在加载页面…', 'Loading view…')} tone="primary" />
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

  const syncFromHost = useCallback(
    async (silent = false) => {
      const store = useTuiStore.getState();
      if (!silent) store.setRefreshing(true);
      try {
        const res = await host.refreshSnapshot();
        if (res.snapshot) store.setSnapshot(res.snapshot);
        if (res.binding) store.setBinding(res.binding);
        if (res.config) store.setDesktopConfig(res.config);
        store.setLastError(res.error);
      } catch (err) {
        store.setLastError(err instanceof Error ? err.message : String(err));
      } finally {
        store.setLoading(false);
        store.setRefreshing(false);
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
      if (event.type === TUI_CONFIG_CHANGED_EVENT) {
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
          useTuiStore.getState().notify(t(curLang, '正在扫描本地模型 CLI…', 'Scanning local CLI providers…'), 'info');
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
      renderVoicePack={(props) => <VoicePackModal {...props} host={host} />}
    />
  );
}

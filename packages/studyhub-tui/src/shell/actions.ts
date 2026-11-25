import { createContext, useContext } from 'react';
import type { HostClient } from '../types/contracts.js';
import { useTuiStore } from '../state/store.js';

/** Global shell actions (overridable via `<AppShell actions={…} />`, readable via `useShellActions()`). */
export interface ShellActions {
  /** Re-fetch the snapshot into the store. */
  refresh: () => Promise<void>;
  /** Load the built-in sample course. */
  loadSample: () => Promise<void>;
  /** Start the import flow (default: Sources page). */
  importSource: () => void;
  /** Open model configuration (default: Settings page). */
  openModelSettings: () => void;
  /** Switch focused course (`null` = all courses). */
  setCourse: (course: string | null) => Promise<void>;
  /** Create (and focus) a new course. */
  createCourse: (name: string) => Promise<void>;
  /** Exit the TUI. */
  quit: () => void;
}

function errText(res: { error?: { message: string } } | undefined, fallback: string): string {
  return res?.error?.message || fallback;
}

export function requestQuit(quit: () => void): void {
  const s = useTuiStore.getState();
  if (s.commandPaletteOpen) s.setCommandPaletteOpen(false);
  if (s.quitGuard?.()) return;
  quit();
}

export function createDefaultShellActions(host: HostClient, quit: () => void): ShellActions {
  const store = () => useTuiStore.getState();
  const refresh = async () => {
    store().setRefreshing(true);
    try {
      const res = await host.call('snapshot');
      if (res.ok && res.value && typeof res.value === 'object') store().setSnapshot(res.value as never);
      else if (!res.ok) store().notify(errText(res, '刷新失败'), 'error');
    } catch (err) {
      store().notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      store().setRefreshing(false);
    }
  };
  return {
    refresh,
    loadSample: async () => {
      store().notify(store().preferences.language === 'en' ? 'Loading sample course…' : '正在载入示例课程…', 'info');
      const res = await host.call('sample.load', { language: store().preferences.language });
      if (!res.ok) {
        store().notify(errText(res, '示例课程载入失败'), 'error');
        return;
      }
      await refresh();
      store().setShowLaunchpad(false);
      store().notify(store().preferences.language === 'en' ? 'Sample course loaded' : '示例课程已载入', 'success');
    },
    importSource: () => store().navigate('sources', { mode: 'import' }),
    openModelSettings: () => store().navigate('settings', { mode: 'model' }),
    setCourse: async (course) => {
      const res = await host.call('focus.set', { course });
      if (!res.ok) {
        store().notify(errText(res, '切换课程失败'), 'error');
        return;
      }
      await refresh();
      const lang = store().preferences.language;
      store().notify(course ? (lang === 'en' ? `Focused: ${course}` : `已切换到「${course}」`) : lang === 'en' ? 'All courses' : '已切换到全部课程', 'success');
    },
    createCourse: async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const res = await host.call<{ id?: string; name?: string }>('course.save', { name: trimmed });
      if (!res.ok) {
        store().notify(errText(res, '创建课程失败'), 'error');
        return;
      }
      const key = res.value?.name || trimmed;
      const focusRes = await host.call('focus.set', { course: key });
      await refresh();
      const lang = store().preferences.language;
      if (!focusRes.ok) {
        store().notify(
          lang === 'en'
            ? `Course created (${key}), but failed to focus it: ${errText(focusRes, 'focus error')}`
            : `已创建课程「${key}」，但切换课程焦点失败：${errText(focusRes, '切换失败')}`,
          'warning',
        );
        return;
      }
      store().notify(lang === 'en' ? `Course created: ${key}` : `已创建课程「${key}」`, 'success');
    },
    quit: () => requestQuit(quit),
  };
}

const noop = async () => {};
export const ShellActionsContext = createContext<ShellActions>({
  refresh: noop,
  loadSample: noop,
  importSource: () => {},
  openModelSettings: () => {},
  setCourse: noop,
  createCourse: noop,
  quit: () => {},
});

export function useShellActions(): ShellActions {
  return useContext(ShellActionsContext);
}

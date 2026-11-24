import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { BindingSnapshot, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction } from '../../host/sample-actions.js';
import type { TuiConfigSnapshot } from '../../host/tui-host.js';
import { useTheme } from '../../theme/tokens.js';
import { Spinner } from '../../components/Badge.js';
import { useClaimKeys } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { ClickableBox } from '../../components/mouse.js';
import { ModelsTab } from './ModelsTab.js';
import { SETTINGS_TABS, type SettingsTabId } from './types.js';

const AppearanceTab = lazy(() => import('./AppearanceTab.js').then((m) => ({ default: m.AppearanceTab })));
const StudyGenTab = lazy(() => import('./StudyGenTab.js').then((m) => ({ default: m.StudyGenTab })));
const WorkspaceTab = lazy(() => import('./WorkspaceTab.js').then((m) => ({ default: m.WorkspaceTab })));

export const SettingsView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const navContext = useTuiStore((s) => s.navContext);
  const desktopConfig = useTuiStore((s) => s.desktopConfig) as TuiConfigSnapshot | null;
  const binding = useTuiStore((s) => s.binding);
  const setDesktopConfig = useTuiStore((s) => s.setDesktopConfig);
  const setBinding = useTuiStore((s) => s.setBinding);
  const inputCaptured = useTuiStore((s) => s.inputCaptured);

  const [tab, setTab] = useState<SettingsTabId>('models');
  const [editingText, setEditingText] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (navContext.mode === 'model') setTab('models');
  }, [navContext.mode]);

  const refreshConfig = useCallback(async () => {
    const res = await tryAction<TuiConfigSnapshot>(host, 'desktop.config.get', {});
    if (!mountedRef.current) return;
    const hostCfg = host.getConfig() as TuiConfigSnapshot | null;
    if (res.ok && res.value) {
      const merged =
        hostCfg?.effective?.ready && !res.value.effective?.ready
          ? { ...res.value, effective: hostCfg.effective }
          : res.value;
      setDesktopConfig(merged);
    } else if (hostCfg) {
      setDesktopConfig(hostCfg);
    }
  }, [host, setDesktopConfig]);

  const refreshBinding = useCallback(async () => {
    const res = await tryAction<BindingSnapshot>(host, 'binding.get', {});
    if (!mountedRef.current) return;
    if (res.ok && res.value) setBinding(res.value);
  }, [host, setBinding]);

  useEffect(() => {
    void Promise.all([refreshConfig(), refreshBinding()]);
  }, [refreshConfig, refreshBinding]);

  const allowTabKeys = isActive && !inputCaptured && !editingText;
  const claimedDigits = useMemo(() => ['1', '2', '3', '4'], []);
  useClaimKeys(claimedDigits, allowTabKeys);

  useInput(
    (input) => {
      const idx = ['1', '2', '3', '4'].indexOf(input);
      if (idx >= 0) {
        setTab(SETTINGS_TABS[idx].id);
      }
    },
    { isActive: allowTabKeys },
  );

  const footerHints = useMemo(() => {
    const base = [{ key: '1-4', label: t(lang, '切换标签', 'Switch tab') }];
    if (tab === 'models') {
      return [
        ...base,
        { key: 'Tab', label: t(lang, '切栏', 'Pane') },
        { key: 'a/Enter', label: t(lang, '保存启用', 'Save/Activate') },
        { key: 't', label: t(lang, '测试连接', 'Test') },
        { key: 's', label: t(lang, '重扫/保存', 'Scan/Save') },
      ];
    }
    if (tab === 'workspace') {
      return [
        ...base,
        { key: 'e', label: t(lang, '改目录', 'Folder') },
        { key: 's', label: t(lang, '示例课程', 'Sample') },
        { key: 'Enter', label: t(lang, '恢复备份', 'Restore') },
      ];
    }
    if (tab === 'study') {
      return [
        ...base,
        { key: 'j/k', label: t(lang, '选择', 'Select') },
        { key: asciiMode ? 'Left/Right' : '←/→', label: t(lang, '调整并保存', 'Adjust') },
      ];
    }
    return [
      ...base,
      { key: 'j/k', label: t(lang, '选择', 'Select') },
      { key: asciiMode ? 'Left/Right/Enter' : '←/→/Enter', label: t(lang, '切换并保存', 'Toggle') },
    ];
  }, [lang, tab, asciiMode]);
  useFooterHints(footerHints, isActive);

  const bodyH = Math.max(8, height - 3);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {/* Sub-tab header bar */}
      <Box flexDirection="row" justifyContent="space-between" height={1} marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={theme.primary} bold>
            {asciiMode ? t(lang, '$ 设置', '$ Settings') : t(lang, '⚙ 设置', '⚙ Settings')}
          </Text>
          {SETTINGS_TABS.map((item) => {
            const active = item.id === tab;
            const label = lang === 'en' ? item.labelEn : item.labelZh;
            return (
              <ClickableBox key={item.id} onClick={() => setTab(item.id)} clickActive={allowTabKeys}>
                <Text
                  backgroundColor={active ? theme.primary : theme.surface}
                  color={active ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                  bold={active}
                >
                  {` ${item.num} ${label} `}
                </Text>
              </ClickableBox>
            );
          })}
        </Box>
      </Box>

      {tab === 'models' ? (
        <ModelsTab
          host={host}
          config={desktopConfig}
          width={width}
          height={bodyH}
          isActive={isActive}
          onRefreshConfig={refreshConfig}
          onEditingChange={setEditingText}
        />
      ) : null}

      {tab !== 'models' ? (
        <Suspense
          fallback={
            <Box paddingX={1} paddingY={1}>
              <Spinner label={asciiMode ? t(lang, '正在加载设置页...', 'Loading settings...') : t(lang, '正在加载设置页…', 'Loading settings…')} active={isActive} />
            </Box>
          }
        >
          {tab === 'workspace' ? (
            <WorkspaceTab
              host={host}
              binding={binding}
              width={width}
              height={bodyH}
              isActive={isActive}
              onRefreshBinding={refreshBinding}
            />
          ) : null}

          {tab === 'study' ? (
            <StudyGenTab host={host} width={width} height={bodyH} isActive={isActive} />
          ) : null}

          {tab === 'appearance' ? (
            <AppearanceTab host={host} width={width} height={bodyH} isActive={isActive} />
          ) : null}
        </Suspense>
      ) : null}
    </Box>
  );
};

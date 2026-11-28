import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import type { HostClient, ModelProviderInfo } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  TUI_OPENAI_PRESETS,
  describeEnvDetection,
  detectPrimaryEnvProvider,
  findPreset,
} from '../../host/presets.js';
import { saveTuiPreferences } from '../../host/tui-prefs.js';
import { tryAction } from '../../host/sample-actions.js';
import type { TuiConfigSnapshot } from '../../host/tui-host.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner, StatusPill } from '../../components/Badge.js';
import { Panel } from '../../components/Panel.js';
import { SelectList, type SelectOption } from '../../components/SelectList.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { padDisplay, truncateDisplay } from '../../render/cjk.js';
import { AGY_EFFORTS, CODEX_EFFORTS, OPENAI_EFFORTS, effortLabel } from './types.js';

export interface ModelsTabProps {
  host: HostClient;
  config: TuiConfigSnapshot | null;
  width: number;
  height: number;
  isActive: boolean;
  onRefreshConfig: () => Promise<void>;
  onEditingChange?: (editing: boolean) => void;
  onPreferencesSave?: (pending: Promise<void>) => void;
}

type RouteSelection =
  | { kind: 'agy' }
  | { kind: 'codex' }
  | { kind: 'preset'; presetId: string };

interface TestStatus {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export const ModelsTab: React.FC<ModelsTabProps> = memo(function ModelsTab({
  host,
  config,
  width,
  height,
  isActive,
  onRefreshConfig,
  onEditingChange,
  onPreferencesSave,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const lastPresetPref = useTuiStore((s) => s.preferences.lastOpenAiPreset);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const notify = useTuiStore((s) => s.notify);

  const envFallback = useMemo(() => describeEnvDetection(detectPrimaryEnvProvider()), []);
  const envDetection = config?.envDetection ?? envFallback;

  const agyProvider: ModelProviderInfo | undefined = useMemo(
    () => config?.providers?.find((p) => p.id === 'agy'),
    [config?.providers],
  );
  const codexProvider: ModelProviderInfo | undefined = useMemo(
    () => config?.providers?.find((p) => p.id === 'codex'),
    [config?.providers],
  );
  const showCodex = Boolean(
    codexProvider && (codexProvider.ready || codexProvider.executablePath || codexProvider.unauthenticated || config?.mode === 'codex'),
  );

  // Build route list: agy primary, OpenAI presets secondary, codex if detected
  const routes: Array<{ key: string; route: RouteSelection }> = useMemo(() => {
    const list: Array<{ key: string; route: RouteSelection }> = [{ key: 'agy', route: { kind: 'agy' } }];
    for (const p of TUI_OPENAI_PRESETS) {
      list.push({ key: `openai:${p.id}`, route: { kind: 'preset', presetId: p.id } });
    }
    if (showCodex) list.push({ key: 'codex', route: { kind: 'codex' } });
    return list;
  }, [showCodex]);

  const initialRouteIdx = useMemo(() => {
    if (config?.mode === 'codex' && showCodex) return routes.length - 1;
    if (config?.mode === 'openai') {
      const pid = config.openai?.providerId || lastPresetPref || 'deepseek';
      const idx = routes.findIndex((r) => r.route.kind === 'preset' && r.route.presetId === pid);
      if (idx >= 0) return idx;
    }
    return 0;
  }, [config?.mode, config?.openai?.providerId, lastPresetPref, routes, showCodex]);

  const [pane, setPane] = useState<'routes' | 'detail'>('routes');
  const [routeIdx, setRouteIdx] = useState(initialRouteIdx);
  const activeRoute = routes[Math.max(0, Math.min(routeIdx, routes.length - 1))]?.route ?? { kind: 'agy' };

  // agy state
  const [agyModel, setAgyModel] = useState(config?.agy?.model || '');
  const [agyEffort, setAgyEffort] = useState(config?.agy?.effort || '');

  // codex state
  const [codexModel, setCodexModel] = useState(config?.codex?.model || '');
  const [codexEffort, setCodexEffort] = useState(config?.codex?.effort || '');

  // OpenAI form state
  const initialPresetId = config?.openai?.providerId || lastPresetPref || 'deepseek';
  const initialPreset = findPreset(initialPresetId);
  const [openaiPresetId, setOpenaiPresetId] = useState(initialPresetId);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(
    config?.openai?.baseUrl || initialPreset?.baseUrl || (envDetection?.presetId === initialPresetId ? envDetection.baseUrl : ''),
  );
  const [openaiModel, setOpenaiModel] = useState(
    config?.openai?.model || (envDetection?.presetId === initialPresetId ? envDetection.model : '') || initialPreset?.defaultModel || '',
  );
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiEffort, setOpenaiEffort] = useState(config?.reasoningEffort || '');
  const [openaiFieldIdx, setOpenaiFieldIdx] = useState(0); // 0: baseUrl, 1: apiKey, 2: model, 3: effort, 4: save
  const [editingField, setEditingField] = useState<'baseUrl' | 'apiKey' | 'model' | 'codexModel' | null>(null);
  const [fieldDraft, setFieldDraft] = useState('');

  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onEditingChange?.(editingField !== null);
  }, [editingField, onEditingChange]);

  // Sync from incoming config when not actively editing
  useEffect(() => {
    if (!config) return;
    if (!agyModel && config.agy?.model) setAgyModel(config.agy.model);
    if (!agyEffort && config.agy?.effort) setAgyEffort(config.agy.effort);
    if (!codexModel && config.codex?.model) setCodexModel(config.codex.model);
    if (!codexEffort && config.codex?.effort) setCodexEffort(config.codex.effort);
    if (editingField === null) {
      const pid = config.openai?.providerId;
      const preset = pid ? findPreset(pid) : undefined;
      if (pid) setOpenaiPresetId(pid);
      if (!openaiBaseUrl) {
        const nextUrl = config.openai?.baseUrl || preset?.baseUrl || '';
        if (nextUrl) setOpenaiBaseUrl(nextUrl);
      }
      if (!openaiModel) {
        const nextModel = config.openai?.model || preset?.defaultModel || '';
        if (nextModel) setOpenaiModel(nextModel);
      }
      if (config.reasoningEffort !== undefined) setOpenaiEffort(config.reasoningEffort);
    }
  }, [config, agyModel, agyEffort, codexModel, codexEffort, editingField, openaiBaseUrl, openaiModel]);

  const applyPresetSelection = useCallback(
    (presetId: string) => {
      const preset = findPreset(presetId);
      if (!preset) return;
      setOpenaiPresetId(preset.id);
      const isSavedSamePreset = config?.openai?.providerId === preset.id;
      const isEnvSamePreset = envDetection?.presetId === preset.id;
      setOpenaiBaseUrl(
        (isSavedSamePreset && config?.openai?.baseUrl) ||
          preset.baseUrl ||
          (isEnvSamePreset ? envDetection.baseUrl : ''),
      );
      setOpenaiModel(
        (isSavedSamePreset && config?.openai?.model) ||
          (isEnvSamePreset && envDetection.model) ||
          preset.defaultModel ||
          '',
      );
      setOpenaiApiKey('');
      setTestStatus(null);
    },
    [config?.openai, envDetection],
  );

  const handleRescan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    const res = await tryAction<{ providers?: ModelProviderInfo[] }>(host, 'desktop.providers.scan', { force: true });
    await onRefreshConfig();
    if (!mountedRef.current) return;
    setScanning(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '扫描 CLI 失败', 'CLI scan failed'), 'error');
    } else {
      notify(t(lang, '已完成 CLI 提供方扫描', 'Provider scan complete'), 'success');
    }
  }, [host, lang, notify, onRefreshConfig, scanning]);

  const handleActivateAgy = useCallback(
    async (chosenModel?: string) => {
      if (saving) return;
      const targetModel = (chosenModel ?? agyModel) || agyProvider?.models?.[0]?.id || '';
      setSaving(true);
      const res = await tryAction<TuiConfigSnapshot>(host, 'desktop.config.save', {
        mode: 'agy',
        agy: {
          executablePath: agyProvider?.executablePath || config?.agy?.executablePath || '',
          model: targetModel,
          effort: agyEffort,
        },
      });
      await onRefreshConfig();
      if (!mountedRef.current) return;
      setSaving(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存 agy 配置失败', 'Failed to save agy config'), 'error');
        return;
      }
      setAgyModel(targetModel);
      notify(t(lang, `已启用 agy CLI (${targetModel || 'default'})`, `Activated agy CLI (${targetModel || 'default'})`), 'success');
    },
    [agyEffort, agyModel, agyProvider, config?.agy?.executablePath, host, lang, notify, onRefreshConfig, saving],
  );

  const handleActivateCodex = useCallback(
    async (chosenModel?: string) => {
      if (saving) return;
      const targetModel = (chosenModel ?? codexModel) || codexProvider?.models?.[0]?.id || '';
      setSaving(true);
      const res = await tryAction<TuiConfigSnapshot>(host, 'desktop.config.save', {
        mode: 'codex',
        codex: {
          executablePath: codexProvider?.executablePath || config?.codex?.executablePath || '',
          model: targetModel,
          effort: codexEffort,
        },
      });
      await onRefreshConfig();
      if (!mountedRef.current) return;
      setSaving(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存 codex 配置失败', 'Failed to save codex config'), 'error');
        return;
      }
      setCodexModel(targetModel);
      notify(t(lang, `已启用 codex CLI (${targetModel || 'default'})`, `Activated codex CLI (${targetModel || 'default'})`), 'success');
    },
    [codexEffort, codexModel, codexProvider, config?.codex?.executablePath, host, lang, notify, onRefreshConfig, saving],
  );

  const handleSaveOpenAi = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    const patch: Record<string, unknown> = {
      mode: 'openai',
      openai: {
        providerId: openaiPresetId,
        baseUrl: openaiBaseUrl.trim(),
        model: openaiModel.trim(),
        ...(openaiApiKey.trim() ? { apiKey: openaiApiKey.trim() } : {}),
      },
      reasoningEffort: openaiEffort,
    };
    const res = await tryAction<TuiConfigSnapshot>(host, 'desktop.config.save', patch);
    if (res.ok) {
      setPreferences({ lastOpenAiPreset: openaiPresetId });
      const dshHome = (host as { dshHome?: string }).dshHome;
      const prefSave = saveTuiPreferences(
        { lastOpenAiPreset: openaiPresetId },
        dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
      ).then(
        () => undefined,
        () => undefined,
      );
      onPreferencesSave?.(prefSave);
      await prefSave;
    }
    await onRefreshConfig();
    if (!mountedRef.current) return;
    setSaving(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '保存 OpenAI 配置失败', 'Failed to save OpenAI config'), 'error');
      return;
    }
    setOpenaiApiKey('');
    notify(t(lang, `已切换到 ${openaiPresetId} · ${openaiModel}`, `Saved OpenAI (${openaiPresetId} · ${openaiModel})`), 'success');
  }, [
    host,
    lang,
    notify,
    onPreferencesSave,
    onRefreshConfig,
    openaiApiKey,
    openaiBaseUrl,
    openaiEffort,
    openaiModel,
    openaiPresetId,
    saving,
    setPreferences,
  ]);

  const handleTestConnection = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestStatus(null);
    let draft: Record<string, unknown> = {};
    if (activeRoute.kind === 'agy') {
      draft = {
        mode: 'agy',
        agy: {
          executablePath: agyProvider?.executablePath || config?.agy?.executablePath || '',
          model: agyModel || config?.agy?.model || '',
          effort: agyEffort,
        },
      };
    } else if (activeRoute.kind === 'codex') {
      draft = {
        mode: 'codex',
        codex: {
          executablePath: codexProvider?.executablePath || config?.codex?.executablePath || '',
          model: codexModel || config?.codex?.model || '',
          effort: codexEffort,
        },
      };
    } else {
      draft = {
        mode: 'openai',
        openai: {
          providerId: openaiPresetId,
          baseUrl: openaiBaseUrl.trim(),
          model: openaiModel.trim(),
          ...(openaiApiKey.trim() ? { apiKey: openaiApiKey.trim() } : {}),
        },
      };
    }
    const res = await tryAction<TestStatus>(host, 'desktop.config.test', draft);
    if (!mountedRef.current) return;
    setTesting(false);
    if (!res.ok) {
      const msg = res.error?.message || t(lang, '连接测试失败', 'Test failed');
      setTestStatus({ ok: false, message: msg });
      notify(msg, 'error');
      return;
    }
    const status = res.value ?? { ok: false, message: 'No response' };
    setTestStatus(status);
    notify(status.message, status.ok ? 'success' : 'error');
  }, [
    activeRoute.kind,
    agyEffort,
    agyModel,
    agyProvider?.executablePath,
    codexEffort,
    codexModel,
    codexProvider?.executablePath,
    config?.agy?.executablePath,
    config?.agy?.model,
    config?.codex?.executablePath,
    config?.codex?.model,
    host,
    lang,
    notify,
    openaiApiKey,
    openaiBaseUrl,
    openaiModel,
    openaiPresetId,
    testing,
  ]);

  const routeOptions: SelectOption<string>[] = useMemo(() => {
    const out: SelectOption<string>[] = [];
    const agyVer = agyProvider?.version ? `v${agyProvider.version}` : agyProvider?.ready ? 'ready' : t(lang, '未就绪', 'off');
    out.push({
      value: 'agy',
      label: t(lang, 'agy CLI (主模型)', 'agy CLI (Primary)'),
      icon: asciiMode ? '*' : '⚡',
      badge: agyVer,
      badgeTone: agyProvider?.ready ? 'success' : agyProvider?.unauthenticated ? 'warning' : 'muted',
    });
    for (const p of TUI_OPENAI_PRESETS) {
      const hasEnv = envDetection?.presetId === p.id;
      out.push({
        value: `openai:${p.id}`,
        label: lang === 'en' ? p.nameEn : p.name,
        icon: asciiMode ? '@' : '☁',
        badge: hasEnv ? 'ENV' : undefined,
        badgeTone: 'accent',
      });
    }
    if (showCodex) {
      out.push({
        value: 'codex',
        label: 'codex CLI',
        icon: asciiMode ? '>' : '◇',
        badge: codexProvider?.version ? `v${codexProvider.version}` : codexProvider?.ready ? 'ready' : 'off',
        badgeTone: codexProvider?.ready ? 'success' : 'warning',
      });
    }
    return out;
  }, [agyProvider, asciiMode, codexProvider, envDetection?.presetId, lang, showCodex]);

  const currentRouteValue = useMemo(() => {
    if (!config) return '';
    if (config.mode === 'agy') return 'agy';
    if (config.mode === 'codex') return 'codex';
    return `openai:${config.openai?.providerId || 'custom'}`;
  }, [config]);

  const agyModelsList = useMemo(() => {
    const raw = agyProvider?.models ?? [];
    if (raw.length > 0) return raw;
    const cur = agyModel || config?.agy?.model;
    return cur ? [{ id: cur, name: cur }] : [];
  }, [agyModel, agyProvider?.models, config?.agy?.model]);

  const agyModelOptions: SelectOption<string>[] = useMemo(
    () =>
      agyModelsList.map((m) => ({
        value: m.id,
        label: m.label || m.name || m.id,
        hint: m.name && m.name !== m.id ? m.id : undefined,
      })),
    [agyModelsList],
  );

  const codexModelsList = useMemo(() => {
    const raw = codexProvider?.models ?? [];
    if (raw.length > 0) return raw;
    const cur = codexModel || config?.codex?.model;
    return cur ? [{ id: cur, name: cur }] : [];
  }, [codexModel, codexProvider?.models, config?.codex?.model]);

  const codexModelOptions: SelectOption<string>[] = useMemo(
    () => codexModelsList.map((m) => ({ value: m.id, label: m.label || m.name || m.id })),
    [codexModelsList],
  );

  const cliDetailActive = pane === 'detail' && (activeRoute.kind === 'agy' || activeRoute.kind === 'codex');
  const claimedKeys = useMemo(
    () => (cliDetailActive ? ['s', 't', 'j', 'k', 'h', 'l', 'a', 'e', 'm'] : ['s', 't', 'j', 'k', 'h', 'l']),
    [cliDetailActive],
  );

  useKeyScope({
    id: 'settings:models',
    active: isActive && editingField === null,
    keys: claimedKeys,
    onKey: (input, key) => {
      if (key.tab) {
        setPane((p) => (p === 'routes' ? 'detail' : 'routes'));
        return true;
      }
      if (key.ctrl && !key.meta && input === 's') {
        if (activeRoute.kind === 'agy') void handleActivateAgy();
        else if (activeRoute.kind === 'codex') void handleActivateCodex();
        else void handleSaveOpenAi();
        return true;
      }
      const plain = isPlainKey(input, key);
      if (plain && input === 't') {
        void handleTestConnection();
        return true;
      }
      if (plain && input === 's' && activeRoute.kind !== 'preset') {
        void handleRescan();
        return true;
      }
      if (plain && input === 's' && activeRoute.kind === 'preset') {
        void handleSaveOpenAi();
        return true;
      }

      if (pane === 'routes') {
        if (key.rightArrow || (plain && input === 'l')) {
          setPane('detail');
          return true;
        }
        return false;
      }

      // Detail pane shortcuts
      if (key.escape || (key.leftArrow && activeRoute.kind !== 'preset')) {
        setPane('routes');
        return true;
      }

      if (activeRoute.kind === 'agy') {
        if (plain && input === 'a') {
          void handleActivateAgy();
          return true;
        }
        if (plain && input === 'e') {
          setAgyEffort((cur) => AGY_EFFORTS[(AGY_EFFORTS.indexOf(cur) + 1) % AGY_EFFORTS.length]);
          return true;
        }
        return false;
      }

      if (activeRoute.kind === 'codex') {
        if (plain && input === 'a') {
          void handleActivateCodex();
          return true;
        }
        if (plain && input === 'e') {
          setCodexEffort((cur) => CODEX_EFFORTS[(CODEX_EFFORTS.indexOf(cur) + 1) % CODEX_EFFORTS.length]);
          return true;
        }
        if (plain && input === 'm') {
          setFieldDraft(codexModel);
          setEditingField('codexModel');
          return true;
        }
        return false;
      }

      // OpenAI preset form
      const preset = findPreset(openaiPresetId);
      if (key.upArrow || (plain && input === 'k')) {
        setOpenaiFieldIdx((i) => (i + 4) % 5);
        return true;
      }
      if (key.downArrow || (plain && input === 'j')) {
        setOpenaiFieldIdx((i) => (i + 1) % 5);
        return true;
      }
      if ((key.leftArrow || (plain && input === 'h')) && openaiFieldIdx === 0) {
        setPane('routes');
        return true;
      }
      if (openaiFieldIdx === 2 && preset && preset.models.length > 0 && (key.leftArrow || key.rightArrow || (plain && (input === 'h' || input === 'l')))) {
        const dir = key.leftArrow || (plain && input === 'h') ? -1 : 1;
        const idx = preset.models.indexOf(openaiModel);
        const nextIdx = idx < 0 ? 0 : (idx + dir + preset.models.length) % preset.models.length;
        setOpenaiModel(preset.models[nextIdx]);
        return true;
      }
      if (openaiFieldIdx === 3 && (key.leftArrow || key.rightArrow || (plain && (input === 'h' || input === 'l')))) {
        const dir = key.leftArrow || (plain && input === 'h') ? -1 : 1;
        const idx = OPENAI_EFFORTS.indexOf(openaiEffort);
        const nextIdx = idx < 0 ? 0 : (idx + dir + OPENAI_EFFORTS.length) % OPENAI_EFFORTS.length;
        setOpenaiEffort(OPENAI_EFFORTS[nextIdx]);
        return true;
      }
      if (key.return && !key.ctrl && !key.meta) {
        if (openaiFieldIdx === 0) {
          setFieldDraft(openaiBaseUrl);
          setEditingField('baseUrl');
        } else if (openaiFieldIdx === 1) {
          setFieldDraft(openaiApiKey);
          setEditingField('apiKey');
        } else if (openaiFieldIdx === 2) {
          setFieldDraft(openaiModel);
          setEditingField('model');
        } else if (openaiFieldIdx === 3) {
          const idx = OPENAI_EFFORTS.indexOf(openaiEffort);
          setOpenaiEffort(OPENAI_EFFORTS[(Math.max(0, idx) + 1) % OPENAI_EFFORTS.length]);
        } else {
          void handleSaveOpenAi();
        }
        return true;
      }
      return false;
    },
  });

  const effectiveReady = Boolean(config?.effective?.ready);
  const effectiveLabel = config?.effective?.label || t(lang, '未配置模型', 'No model configured');
  const effectiveReason = config?.effective?.reason || '';

  const bannerH = 4;
  const splitH = Math.max(8, height - bannerH);

  const selectedPreset = activeRoute.kind === 'preset' ? findPreset(activeRoute.presetId) : undefined;
  const agyCurIdx = Math.max(0, agyModelOptions.findIndex((o) => o.value === agyModel));
  const codexCurIdx = Math.max(0, codexModelOptions.findIndex((o) => o.value === codexModel));

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Active Model Banner */}
      <Panel
        title={t(lang, '当前生效模型', 'Active Model Route')}
        subtitle={config?.configPath ? truncateDisplay(config.configPath, 36, asciiMode ? '...' : '…') : undefined}
        width={width}
        height={bannerH}
      >
        <Box flexDirection="row" justifyContent="space-between" width={Math.max(10, width - 4)}>
          <Box flexDirection="row" gap={1}>
            <StatusPill
              label={effectiveLabel}
              status={testing || scanning || saving ? 'busy' : effectiveReady ? 'ok' : 'warn'}
              bold
            />
            {config?.keyFromEnv && config.mode === 'openai' ? (
              <Badge label={`ENV: ${envDetection?.envKey || 'API_KEY'}`} tone="accent" variant="soft" />
            ) : null}
            {!config?.keyFromEnv && envDetection ? (
              <Badge
                label={t(lang, `检测到 ${envDetection.envKey}`, `Detected ${envDetection.envKey}`)}
                tone="info"
                variant="outline"
              />
            ) : null}
          </Box>
          <Box flexDirection="row" gap={1}>
            {testing ? <Spinner label={t(lang, asciiMode ? '测试连接中...' : '测试连接中…', asciiMode ? 'Testing...' : 'Testing…')} active={isActive} /> : null}
            {scanning ? <Spinner label={t(lang, asciiMode ? '扫描 CLI...' : '扫描 CLI…', asciiMode ? 'Scanning...' : 'Scanning…')} active={isActive} /> : null}
            {testStatus && !testing ? (
              <Badge
                label={`${testStatus.ok ? (asciiMode ? '+' : '✓') : (asciiMode ? 'x' : '✕')} ${truncateDisplay(testStatus.message, 28, asciiMode ? '...' : '…')}${testStatus.latencyMs ? ` (${testStatus.latencyMs}ms)` : ''}`}
                tone={testStatus.ok ? 'success' : 'error'}
                variant="soft"
              />
            ) : !effectiveReady && effectiveReason ? (
              <Text color={theme.warning}>{truncateDisplay(effectiveReason, 32, asciiMode ? '...' : '…')}</Text>
            ) : null}
          </Box>
        </Box>
      </Panel>

      <SplitPane
        width={width}
        height={splitH}
        leftWidth={0.34}
        minLeft={24}
        minRight={34}
        activePane={pane === 'routes' ? 'left' : 'right'}
        leftLabel={t(lang, '模型提供方', 'Providers')}
        rightLabel={t(lang, '详细配置', 'Config')}
        left={(size) => (
          <Panel
            title={t(lang, '提供方与预设', 'Routes & Presets')}
            focused={isActive && pane === 'routes'}
            width={size.width}
            height={size.height}
          >
            <SelectList
              options={routeOptions}
              selectedIndex={routeIdx}
              currentValue={currentRouteValue}
              numberShortcuts={false}
              width={Math.max(10, size.width - 4)}
              maxHeight={Math.max(3, size.height - 3)}
              isActive={isActive && pane === 'routes' && editingField === null}
              onChange={(opt, idx) => {
                setRouteIdx(idx);
                if (opt.value.startsWith('openai:')) {
                  applyPresetSelection(opt.value.slice('openai:'.length));
                }
              }}
              onSelect={(opt, idx) => {
                setRouteIdx(idx);
                if (opt.value.startsWith('openai:')) {
                  applyPresetSelection(opt.value.slice('openai:'.length));
                }
                setPane('detail');
              }}
            />
          </Panel>
        )}
        right={(size) => {
          const innerW = Math.max(12, size.width - 4);
          if (activeRoute.kind === 'agy') {
            return (
              <Panel
                title={asciiMode ? '* agy CLI (Primary)' : '⚡ agy CLI (Primary)'}
                subtitle={agyProvider?.version ? `v${agyProvider.version}` : undefined}
                badge={config?.mode === 'agy' ? t(lang, '当前启用', 'ACTIVE') : undefined}
                badgeTone="success"
                focused={isActive && pane === 'detail'}
                width={size.width}
                height={size.height}
              >
                <Box flexDirection="row" gap={1}>
                  <Text color={theme.muted}>{t(lang, '状态:', 'Status:')}</Text>
                  <Text color={agyProvider?.ready ? theme.success : theme.warning}>
                    {agyProvider?.reason || (agyProvider?.ready ? 'Ready' : t(lang, '未检测到 agy CLI', 'Not detected'))}
                  </Text>
                </Box>
                <Box flexDirection="row" gap={1}>
                  <Text color={theme.muted}>{t(lang, '路径:', 'Path:')}</Text>
                  <Text color={theme.dim}>{truncateDisplay(agyProvider?.executablePath || config?.agy?.executablePath || '-', innerW - 8, asciiMode ? '...' : '…')}</Text>
                </Box>
                <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginY={0}>
                  <Box flexShrink={0}>
                    <Text color={theme.muted}>{t(lang, '思考强度 [e]:', 'Effort [e]:')}</Text>
                  </Box>
                  {AGY_EFFORTS.map((eff) => (
                    <Box key={eff || 'auto'} flexShrink={0}>
                      <Text
                        backgroundColor={agyEffort === eff ? theme.primary : theme.surface}
                        color={agyEffort === eff ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                        bold={agyEffort === eff}
                      >
                        {` ${effortLabel(eff, lang)} `}
                      </Text>
                    </Box>
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={theme.heading} bold>
                    {t(lang, `可用模型 (${agyModelOptions.length}) — Enter/a 启用:`, `Available Models (${agyModelOptions.length}) — Enter/a activate:`)}
                  </Text>
                  <SelectList
                    options={agyModelOptions}
                    initialIndex={agyCurIdx >= 0 ? agyCurIdx : 0}
                    currentValue={agyModel || config?.agy?.model}
                    numberShortcuts={false}
                    width={innerW}
                    maxHeight={Math.max(3, size.height - 9)}
                    isActive={isActive && pane === 'detail' && editingField === null}
                    emptyText={t(lang, '未探测到模型，按 [s] 重新扫描 CLI', 'No models found; press [s] to rescan CLI')}
                    onChange={(opt) => setAgyModel(opt.value)}
                    onSelect={(opt) => void handleActivateAgy(opt.value)}
                  />
                </Box>
                <Box flexDirection="row" gap={2} marginTop={0}>
                  <Text color={theme.accent}>{`[a] ${t(lang, '启用并保存', 'Activate & Save')}`}</Text>
                  <Text color={theme.accent}>{`[s] ${t(lang, '重新扫描 CLI', 'Rescan CLI')}`}</Text>
                  <Text color={theme.accent}>{`[t] ${t(lang, '测试连接', 'Test')}`}</Text>
                </Box>
              </Panel>
            );
          }

          if (activeRoute.kind === 'codex') {
            return (
              <Panel
                title={asciiMode ? '> codex CLI' : '◇ codex CLI'}
                subtitle={codexProvider?.version ? `v${codexProvider.version}` : undefined}
                badge={config?.mode === 'codex' ? t(lang, '当前启用', 'ACTIVE') : undefined}
                badgeTone="success"
                focused={isActive && pane === 'detail'}
                width={size.width}
                height={size.height}
              >
                <Text color={theme.muted}>
                  {t(lang, '状态:', 'Status:')} <Text color={codexProvider?.ready ? theme.success : theme.warning}>{codexProvider?.reason || '-'}</Text>
                </Text>
                <Text color={theme.muted}>
                  {t(lang, '路径:', 'Path:')} <Text color={theme.dim}>{truncateDisplay(codexProvider?.executablePath || config?.codex?.executablePath || '-', innerW - 8, asciiMode ? '...' : '…')}</Text>
                </Text>
                <Box flexDirection="row" gap={1}>
                  <Text color={theme.muted}>{t(lang, '强度 [e]:', 'Effort [e]:')}</Text>
                  {CODEX_EFFORTS.map((eff) => (
                    <Text
                      key={eff || 'auto'}
                      backgroundColor={codexEffort === eff ? theme.primary : theme.surface}
                      color={codexEffort === eff ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                    >
                      {` ${effortLabel(eff, lang)} `}
                    </Text>
                  ))}
                </Box>
                {editingField === 'codexModel' ? (
                  <Box marginTop={1}>
                    <TextInput
                      value={fieldDraft}
                      onChange={setFieldDraft}
                      onSubmit={(v) => {
                        setCodexModel(v.trim());
                        setEditingField(null);
                      }}
                      onCancel={() => setEditingField(null)}
                      width={innerW}
                      isActive={isActive}
                      prompt={asciiMode ? 'Model >' : 'Model ›'}
                    />
                  </Box>
                ) : (
                  <Box marginTop={1} flexDirection="column">
                    <SelectList
                      options={codexModelOptions}
                      initialIndex={codexCurIdx >= 0 ? codexCurIdx : 0}
                      currentValue={codexModel || config?.codex?.model}
                      numberShortcuts={false}
                      width={innerW}
                      maxHeight={Math.max(3, size.height - 9)}
                      isActive={isActive && pane === 'detail'}
                      emptyText={t(lang, '按 [m] 手动输入模型 ID', 'Press [m] to enter model ID')}
                      onChange={(opt) => setCodexModel(opt.value)}
                      onSelect={(opt) => void handleActivateCodex(opt.value)}
                    />
                  </Box>
                )}
                <Box flexDirection="row" gap={2}>
                  <Text color={theme.accent}>{`[a] ${t(lang, '启用 codex', 'Activate')}`}</Text>
                  <Text color={theme.accent}>{`[s] ${t(lang, '重扫', 'Rescan')}`}</Text>
                  <Text color={theme.accent}>{`[t] ${t(lang, '测试', 'Test')}`}</Text>
                </Box>
              </Panel>
            );
          }

          // OpenAI Compatible Preset Panel
          const savedSamePreset = config?.openai?.providerId === openaiPresetId;
          const envMatched = envDetection?.presetId === openaiPresetId;
          const maskDot = asciiMode ? '*' : '•';
          const ell = asciiMode ? '...' : '…';
          const sepDash = asciiMode ? '-' : '—';
          const keyBadge = openaiApiKey
            ? `${maskDot.repeat(8)} (${t(lang, '新密钥已填写', 'new key staged')})`
            : savedSamePreset && config?.openai?.hasKey
              ? `${maskDot.repeat(8)}${config.openai.keyLast4 || ''} (${t(lang, '已保存', 'saved')})`
              : envMatched
                ? `ENV: ${envDetection?.envKey} (${asciiMode ? '...' : '···'}${envDetection?.keyLast4})`
                : t(lang, `(未填写 ${sepDash} 回车输入)`, `(empty ${sepDash} Enter to input)`);

          const fields: Array<{ label: string; value: string; field?: 'baseUrl' | 'apiKey' | 'model' }> = [
            {
              label: 'Base URL',
              value:
                openaiBaseUrl ||
                (selectedPreset?.baseUrl
                  ? t(lang, `默认: ${selectedPreset.baseUrl}`, `Default: ${selectedPreset.baseUrl}`)
                  : t(lang, `(未填写 ${sepDash} 回车输入)`, `(empty ${sepDash} Enter to input)`)),
              field: 'baseUrl',
            },
            { label: 'API Key', value: keyBadge, field: 'apiKey' },
            {
              label: 'Model ID',
              value:
                openaiModel ||
                (selectedPreset?.defaultModel
                  ? t(lang, `默认: ${selectedPreset.defaultModel}`, `Default: ${selectedPreset.defaultModel}`)
                  : t(lang, `(未填写 ${sepDash} 回车输入)`, `(empty ${sepDash} Enter to input)`)),
              field: 'model',
            },
            { label: t(lang, 'Reasoning Effort', 'Reasoning Effort'), value: effortLabel(openaiEffort, lang) },
            {
              label: t(lang, '操作', 'Action'),
              value: saving
                ? t(lang, `保存中${ell}`, `Saving${ell}`)
                : t(
                    lang,
                    `${asciiMode ? '>' : '▶'} 保存并切换到 OpenAI 兼容接口 [Enter / s]`,
                    `${asciiMode ? '>' : '▶'} Save & Switch to OpenAI [Enter / s]`,
                  ),
            },
          ];

          return (
            <Panel
              title={`${asciiMode ? '@' : '☁'} ${selectedPreset ? (lang === 'en' ? selectedPreset.nameEn : selectedPreset.name) : openaiPresetId}`}
              badge={config?.mode === 'openai' && savedSamePreset ? t(lang, '当前启用', 'ACTIVE') : undefined}
              badgeTone="success"
              focused={isActive && pane === 'detail'}
              width={size.width}
              height={size.height}
            >
              {selectedPreset?.keyUrl ? (
                <Text color={theme.dim}>{`API Key: ${selectedPreset.keyUrl}`}</Text>
              ) : null}

              <Box flexDirection="column" marginTop={1}>
                {fields.map((f, idx) => {
                  const selected = pane === 'detail' && openaiFieldIdx === idx;
                  const isEditingThis = Boolean(f.field && editingField === f.field);
                  return (
                    <Box key={f.label} flexDirection="column">
                      <Box
                        flexDirection="row"
                        height={1}
                        backgroundColor={selected && !isEditingThis ? theme.selectionBg : undefined}
                      >
                        <Text color={selected ? theme.primary : theme.dim}>{selected ? (asciiMode ? '> ' : '❯ ') : '  '}</Text>
                        <Text color={selected ? theme.selectionFg : theme.muted} bold={selected}>
                          {padDisplay(f.label, 18)}
                        </Text>
                        {isEditingThis ? (
                          <Text color={theme.accent}>{t(lang, `[编辑中 ${sepDash} Enter 确认 / Esc 取消]`, `[Editing ${sepDash} Enter save / Esc cancel]`)}</Text>
                        ) : (
                          <Text
                            color={idx === 4 ? theme.success : selected ? theme.accent : theme.text}
                            bold={idx === 4 || selected}
                          >
                            {truncateDisplay(f.value, Math.max(10, innerW - 22), ell)}
                          </Text>
                        )}
                      </Box>
                      {isEditingThis ? (
                        <Box paddingLeft={4}>
                          <TextInput
                            value={fieldDraft}
                            onChange={setFieldDraft}
                            mask={f.field === 'apiKey' ? '*' : undefined}
                            width={Math.max(12, innerW - 6)}
                            isActive={isActive}
                            prompt={asciiMode ? '>' : '›'}
                            onSubmit={(val) => {
                              const trimmed = val.trim();
                              if (f.field === 'baseUrl') setOpenaiBaseUrl(trimmed);
                              if (f.field === 'apiKey') setOpenaiApiKey(trimmed);
                              if (f.field === 'model') setOpenaiModel(trimmed);
                              setEditingField(null);
                            }}
                            onCancel={() => setEditingField(null)}
                          />
                        </Box>
                      ) : null}
                    </Box>
                  );
                })}
              </Box>

              {selectedPreset && selectedPreset.models.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={theme.muted}>
                    {t(
                      lang,
                      `预设模型快捷切换 (Model 行 ${asciiMode ? '<-/->' : '←/→'}):`,
                      `Preset models (${asciiMode ? '<-/->' : '←/→'} on Model row):`,
                    )}
                  </Text>
                  <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                    {selectedPreset.models.map((m) => (
                      <Text
                        key={m}
                        backgroundColor={openaiModel === m ? theme.primary : theme.surface}
                        color={openaiModel === m ? (theme.dark ? theme.bg : '#ffffff') : theme.text}
                      >
                        {` ${m} `}
                      </Text>
                    ))}
                  </Box>
                </Box>
              ) : null}

              <Box flexDirection="row" gap={2} marginTop={1}>
                <Text color={theme.accent}>{`[Enter] ${t(lang, '编辑/保存', 'Edit/Save')}`}</Text>
                <Text color={theme.accent}>{`[t] ${t(lang, '测试连接', 'Test Connection')}`}</Text>
                <Text color={theme.accent}>{`[Tab] ${t(lang, '返回列表', 'Back to Routes')}`}</Text>
              </Box>
            </Panel>
          );
        }}
      />
    </Box>
  );
});

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { isAbsolute, resolve } from 'node:path';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  Panel,
  ScrollView,
  Spinner,
  SplitPane,
  StatusPill,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useInputCapture,
  useTheme,
} from '../../components/index.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/index.js';
import { cleanPathInput, tryAction } from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from '../sources/path-complete.js';

interface AudioKeyState {
  set?: boolean;
  hint?: string;
}

interface AudioSettingsInfo {
  freeKey?: AudioKeyState;
  paidKey?: AudioKeyState;
  groqKey?: AudioKeyState;
  siliconflowKey?: AudioKeyState;
  textProvider?: string;
  transcribeModel?: string;
  groqTranscribeModel?: string;
  siliconflowTranscribeModel?: string;
  [k: string]: unknown;
}

interface AudioResultItem {
  id: string;
  title?: string;
  text?: string;
  courses?: string[];
  sourceId?: string;
  durationSec?: number;
  createdAt?: string;
  [k: string]: unknown;
}

type AudioOverlay = 'none' | 'import' | 'settings';
type ImportField = 'path' | 'title' | 'course';
type ProviderKeyField = 'siliconflowKey' | 'groqKey' | 'freeKey' | 'paidKey';

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.webm'];

const PROVIDERS: ReadonlyArray<{ field: ProviderKeyField; tier: string; label: string }> = [
  { field: 'siliconflowKey', tier: 'siliconflow', label: '硅基流动 SenseVoice (推荐/国内直连)' },
  { field: 'groqKey', tier: 'groq', label: 'Groq Whisper' },
  { field: 'freeKey', tier: 'free', label: 'Google Gemini (免费额度)' },
  { field: 'paidKey', tier: 'paid', label: 'Google Gemini (付费密钥)' },
];

export const AudioView: React.FC<ViewProps> = memo(function AudioView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const focusCourse = currentCourse(snapshot);

  const [audioSettings, setAudioSettings] = useState<AudioSettingsInfo | null>(null);
  const [results, setResults] = useState<AudioResultItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTranscript, setActiveTranscript] = useState<{ id: string; text: string }>({ id: '', text: '' });
  const [loadingList, setLoadingList] = useState(false);

  const [overlay, setOverlay] = useState<AudioOverlay>('none');
  const [busy, setBusy] = useState(false);

  // Import modal state
  const [importField, setImportField] = useState<ImportField>('path');
  const [audioPath, setAudioPath] = useState('');
  const [audioTitle, setAudioTitle] = useState('');
  const [audioCourse, setAudioCourse] = useState(focusCourse || '');
  const [pathMatches, setPathMatches] = useState<string[]>([]);
  const cachedCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  // Settings modal state
  const [providerIdx, setProviderIdx] = useState(0);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [testReport, setTestReport] = useState<Record<string, { ok?: boolean; message?: string }> | null>(null);

  const loadAudioData = useCallback(async () => {
    setLoadingList(true);
    const [settingsRes, listRes] = await Promise.all([
      tryAction<AudioSettingsInfo>(host, 'audio.settings.get', {}),
      tryAction<{ results?: AudioResultItem[] }>(host, 'results', {}),
    ]);
    setLoadingList(false);
    if (settingsRes.ok && settingsRes.value) setAudioSettings(settingsRes.value);
    if (listRes.ok && Array.isArray(listRes.value?.results)) {
      setResults(listRes.value.results);
    }
  }, [host]);

  useEffect(() => {
    if (!isActive) return;
    void loadAudioData();
  }, [isActive, loadAudioData]);

  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedIndex]);

  const selectedResult = results[selectedIndex];

  // Load selected transcript detail on demand (bounded to 1 active transcript — memory NFR)
  useEffect(() => {
    if (!isActive || !selectedResult) {
      setActiveTranscript({ id: '', text: '' });
      return;
    }
    if (typeof selectedResult.text === 'string' && selectedResult.text) {
      setActiveTranscript({ id: selectedResult.id, text: selectedResult.text });
      return;
    }
    if (activeTranscript.id === selectedResult.id) return;
    let cancelled = false;
    void tryAction<AudioResultItem>(host, 'result.get', { id: selectedResult.id }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.value) {
        setActiveTranscript({ id: selectedResult.id, text: String(res.value.text || '') });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [host, isActive, selectedResult, activeTranscript.id]);

  // Pre-fetch path completions while typing audio path
  useEffect(() => {
    if (!isActive || overlay !== 'import' || importField !== 'path') return;
    let cancelled = false;
    void completeFsPath(cleanPathInput(audioPath), { extensions: AUDIO_EXTS }).then((res) => {
      if (cancelled) return;
      cachedCompletionRef.current = { input: audioPath, completed: res.completed };
      setPathMatches(res.matches.slice(0, 6));
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, overlay, importField, audioPath]);

  const handleTabComplete = useCallback((val: string) => {
    const cached = cachedCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    void completeFsPath(cleanPathInput(val), { extensions: AUDIO_EXTS }).then((res) => {
      cachedCompletionRef.current = { input: res.completed, completed: res.completed };
      setPathMatches(res.matches.slice(0, 6));
      if (res.completed && res.completed !== val) setAudioPath(res.completed);
    });
    return undefined;
  }, []);

  const handleImportSubmit = useCallback(async () => {
    if (busy) return;
    const expanded = expandHomePath(cleanPathInput(audioPath));
    if (!expanded) {
      notify(t(lang, '请输入音频文件路径', 'Please enter an audio file path'), 'warning');
      return;
    }
    const absPath = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    setBusy(true);
    const res = await tryAction<{ jobId?: string; id?: string }>(host, 'audio.import', {
      path: absPath,
      ...(audioTitle.trim() ? { title: audioTitle.trim() } : {}),
      ...(audioCourse.trim() ? { courses: [audioCourse.trim()] } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '音频导入失败', 'Audio import failed'), 'error');
      return;
    }
    setOverlay('none');
    setAudioPath('');
    setAudioTitle('');
    await refresh();
    const jobId = res.value?.jobId || res.value?.id;
    notify(t(lang, '音频转写任务已启动', 'Audio transcription job started'), 'success');
    if (jobId) navigate('tasks', { jobId });
  }, [busy, audioPath, audioTitle, audioCourse, host, lang, notify, refresh, navigate]);

  const handleSaveKey = useCallback(async () => {
    if (busy) return;
    const chosen = PROVIDERS[providerIdx] ?? PROVIDERS[0];
    setBusy(true);
    const res = await tryAction<AudioSettingsInfo>(host, 'audio.settings.set', {
      [chosen.field]: apiKeyInput.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '保存音频设置失败', 'Failed to save audio settings'), 'error');
      return;
    }
    if (res.value) setAudioSettings(res.value);
    setApiKeyInput('');
    notify(t(lang, '已保存转写服务密钥', 'Transcription key saved'), 'success');
  }, [busy, providerIdx, host, apiKeyInput, notify, lang]);

  const handleTestProviders = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const res = await tryAction<Record<string, { ok?: boolean; message?: string }>>(host, 'audio.test', {});
    setBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '连通性测试失败', 'Connectivity test failed'), 'error');
      return;
    }
    setTestReport(res.value ?? {});
    notify(t(lang, '转写服务检测完成', 'Provider test complete'), 'info');
  }, [busy, host, lang, notify]);

  const configuredProviders = useMemo(() => {
    if (!audioSettings) return [];
    const list: string[] = [];
    if (audioSettings.siliconflowKey?.set) list.push('硅基流动 SenseVoice');
    if (audioSettings.groqKey?.set) list.push('Groq Whisper');
    if (audioSettings.freeKey?.set) list.push('Gemini Free');
    if (audioSettings.paidKey?.set) list.push('Gemini Paid');
    return list;
  }, [audioSettings]);

  const listActive = isActive && overlay === 'none';
  useClaimKeys(['i', 's', 't', 'g', 'r'], listActive);
  useInputCapture(isActive && overlay !== 'none');

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'i', label: t(lang, '导入音频', 'Import Audio') },
      { key: 's', label: t(lang, '转写服务设置', 'Provider Settings') },
      { key: 't', label: t(lang, '测试连通性', 'Test Keys') },
      { key: 'g', label: t(lang, '据此出题', 'Generate') },
      { key: 'r', label: t(lang, '刷新', 'Refresh') },
    ],
    [lang],
  );
  useFooterHints(hints, isActive);

  useInput(
    (input, key) => {
      if (overlay === 'import') {
        const order: ImportField[] = ['path', 'title', 'course'];
        const idx = order.indexOf(importField);
        if (key.downArrow || (key.ctrl && input === 'n')) setImportField(order[(idx + 1) % order.length]);
        else if (key.upArrow || (key.ctrl && input === 'p')) setImportField(order[(idx - 1 + order.length) % order.length]);
        else if (key.ctrl && input === 's') void handleImportSubmit();
        return;
      }
      if (overlay === 'settings') {
        if (key.upArrow) setProviderIdx((i) => (i - 1 + PROVIDERS.length) % PROVIDERS.length);
        else if (key.downArrow) setProviderIdx((i) => (i + 1) % PROVIDERS.length);
        else if (key.ctrl && input === 't') void handleTestProviders();
        return;
      }
      if (!listActive) return;

      if (input === 'i') {
        setImportField('path');
        setOverlay('import');
      } else if (input === 's') {
        setOverlay('settings');
      } else if (input === 't') {
        void handleTestProviders();
      } else if (input === 'r') {
        void loadAudioData();
      } else if (input === 'g' && selectedResult) {
        const targetId = selectedResult.sourceId || selectedResult.id;
        navigate('generate', {
          sourceIds: [targetId],
          ...(selectedResult.courses?.[0] ? { course: selectedResult.courses[0] } : focusCourse ? { course: focusCourse } : {}),
        });
      }
    },
    { isActive },
  );

  const narrowBar = width < 88;
  const bannerH = 2;
  const splitH = Math.max(4, height - bannerH);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Top Status Banner */}
      <Box height={bannerH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center" width={Math.max(10, width - 2)}>
          <Box flexShrink={0}>
            <Text bold color={theme.primary} wrap="truncate-end">
              {narrowBar ? t(lang, '♪ 音频转写', '♪ Audio') : t(lang, '♪ 音频转写工作台', '♪ Audio Transcription')}
            </Text>
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            <StatusPill
              label={
                configuredProviders.length > 0
                  ? configuredProviders.join(' · ')
                  : t(lang, '未配置密钥', 'No key')
              }
              status={configuredProviders.length > 0 ? 'ok' : 'warn'}
            />
          </Box>
          <Box flexGrow={1} />
          {!narrowBar ? (
            <Box flexShrink={0}>
              <Text color={theme.dim} wrap="truncate-end">
                {t(lang, '[i] 导入音频  [s] 密钥设置  [t] 测试', '[i] Import  [s] Settings  [t] Test')}
              </Text>
            </Box>
          ) : null}
        </Box>
        <Text color={theme.dim} wrap="truncate-end">
          {t(
            lang,
            '说明：实时麦克风录音需要桌面/浏览器音频捕获，纯终端模式已禁用；可直接导入本地录音文件转写。',
            'Note: Live mic capture requires desktop/browser audio and is disabled in terminal mode. Import local audio files below.',
          )}
        </Text>
      </Box>

      {/* Main SplitPane */}
      <Box height={splitH} width={width}>
        <SplitPane
          width={width}
          height={splitH}
          leftWidth={0.42}
          leftLabel={t(lang, '转写文稿', 'Transcripts')}
          rightLabel={t(lang, '正文预览', 'Transcript Text')}
          left={({ width: lw, height: lh }) => (
            <Panel
              title={t(lang, '已完成转写稿', 'Completed Transcripts')}
              badge={results.length}
              width={lw}
              height={lh}
              focused={listActive}
            >
              {loadingList ? (
                <Spinner label={t(lang, '加载转写记录…', 'Loading transcripts…')} />
              ) : results.length === 0 ? (
                <EmptyState
                  title={t(lang, '暂无音频转写记录', 'No transcripts yet')}
                  hint={t(lang, '按 [i] 导入 .mp3 / .wav / .m4a / .ogg / .flac 录音', 'Press [i] to import .mp3 / .wav / .m4a / .ogg / .flac')}
                  width={Math.max(12, lw - 4)}
                  height={Math.max(4, lh - 2)}
                />
              ) : (
                <VirtualList
                  items={results}
                  height={Math.max(1, lh - 2)}
                  width={Math.max(12, lw - 4)}
                  selectedIndex={selectedIndex}
                  onChange={(idx) => setSelectedIndex(idx)}
                  isActive={listActive}
                  keyExtractor={(r) => r.id}
                  renderItem={(item, ctx) => {
                    const label = String(item.title || item.id);
                    const courseTag = item.courses?.[0] ? `[${item.courses[0]}] ` : '';
                    const maxW = Math.max(8, ctx.width - courseTag.length - 5);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                        {courseTag ? <Text color={theme.accent}>{courseTag}</Text> : null}
                        <Text color={theme.text} bold={ctx.selected}>
                          {truncateDisplay(label, maxW, asciiMode ? '...' : '…')}
                        </Text>
                      </Box>
                    );
                  }}
                />
              )}
            </Panel>
          )}
          right={({ width: rw, height: rh }) => (
            <Panel
              title={selectedResult?.title || t(lang, '文稿内容', 'Transcript')}
              subtitle={selectedResult ? t(lang, '[g] 据此出题', '[g] Generate') : undefined}
              width={rw}
              height={rh}
            >
              {!selectedResult ? (
                <EmptyState
                  title={t(lang, '选择一条转写记录查看全文', 'Select a transcript')}
                  width={Math.max(12, rw - 4)}
                  height={Math.max(4, rh - 2)}
                />
              ) : (
                <ScrollView
                  content={
                    activeTranscript.id === selectedResult.id && activeTranscript.text
                      ? activeTranscript.text
                      : t(lang, '（暂无转写正文）', '(Empty transcript)')
                  }
                  width={Math.max(12, rw - 4)}
                  height={Math.max(2, rh - 2)}
                  isActive={false}
                />
              )}
            </Panel>
          )}
        />
      </Box>

      {/* Import Audio Modal */}
      {overlay === 'import' ? (
        <Modal
          title={t(lang, '导入本地音频转写', 'Import Local Audio')}
          subtitle={asciiMode ? '.mp3 / .wav / .m4a / .ogg / .flac' : '.mp3 · .wav · .m4a · .ogg · .flac'}
          icon={asciiMode ? '>' : '♪'}
          width={72}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Tab', label: t(lang, '路径补全', 'Complete') },
            { key: '↑/↓', label: t(lang, '切换字段', 'Field') },
            { key: 'Ctrl+S', label: t(lang, '开始转写', 'Transcribe') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={importField === 'path' ? theme.primary : theme.muted} bold={importField === 'path'}>
            {t(lang, '音频文件路径 (支持 ~, /, \\, C:\\...):', 'Audio file path (supports ~, /, \\, C:\\...):')}
          </Text>
          <TextInput
            value={audioPath}
            onChange={setAudioPath}
            onTab={handleTabComplete}
            onSubmit={() => void handleImportSubmit()}
            onCancel={() => setOverlay('none')}
            placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\lecture.mp3' : '~/Downloads/lecture.mp3'}
            width={modalContentWidth(72) - 4}
            isActive={isActive && !busy && importField === 'path'}
            prompt="›"
          />
          {pathMatches.length > 0 && importField === 'path' ? (
            <Text color={theme.dim}>{`${t(lang, '候选:', 'Matches:')} ${pathMatches.join('  ')}`}</Text>
          ) : null}

          <Box marginTop={1}>
            <Text color={importField === 'title' ? theme.primary : theme.muted} bold={importField === 'title'}>
              {t(lang, '标题 (可选):', 'Title (optional):')}
            </Text>
          </Box>
          <TextInput
            value={audioTitle}
            onChange={setAudioTitle}
            onSubmit={() => void handleImportSubmit()}
            onCancel={() => setOverlay('none')}
            width={modalContentWidth(72) - 4}
            isActive={isActive && !busy && importField === 'title'}
            prompt="›"
          />

          <Box marginTop={1}>
            <Text color={importField === 'course' ? theme.primary : theme.muted} bold={importField === 'course'}>
              {t(lang, '课程归属 (可选):', 'Course (optional):')}
            </Text>
          </Box>
          <TextInput
            value={audioCourse}
            onChange={setAudioCourse}
            onSubmit={() => void handleImportSubmit()}
            onCancel={() => setOverlay('none')}
            width={modalContentWidth(72) - 4}
            isActive={isActive && !busy && importField === 'course'}
            prompt="›"
          />

          {busy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, '正在提交转写任务…', 'Submitting transcription…')} />
            </Box>
          ) : null}
        </Modal>
      ) : null}

      {/* Audio Provider Settings Modal */}
      {overlay === 'settings' ? (
        <Modal
          title={t(lang, '音频转写服务配置', 'Audio Transcription Providers')}
          width={72}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: '↑/↓', label: t(lang, '选择服务商', 'Provider') },
            { key: 'Enter', label: t(lang, '保存密钥', 'Save Key') },
            { key: 'Ctrl+T', label: t(lang, '测试连通', 'Test') },
            { key: 'Esc', label: t(lang, '关闭', 'Close') },
          ]}
        >
          <Box flexDirection="column" marginBottom={1}>
            {PROVIDERS.map((p, idx) => {
              const active = idx === providerIdx;
              const info = audioSettings?.[p.field] as AudioKeyState | undefined;
              const testRes = testReport?.[p.tier];
              return (
                <Box key={p.field} flexDirection="row" alignItems="center">
                  <Text color={active ? theme.primary : theme.muted}>{active ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                  <Text color={theme.text} bold={active}>{p.label}</Text>
                  <Text> </Text>
                  <Badge
                    label={info?.set ? `${t(lang, '已配置', 'Set')}${info.hint ? ` ${info.hint}` : ''}` : t(lang, '未配置', 'Unset')}
                    tone={info?.set ? 'success' : 'muted'}
                    variant="soft"
                  />
                  {testRes ? (
                    <Text color={testRes.ok ? theme.success : theme.error}>
                      {` · ${testRes.ok ? 'OK' : testRes.message || 'Failed'}`}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
          </Box>

          <Text color={theme.primary} bold>
            {`${t(lang, '设置密钥', 'Set API Key')} (${PROVIDERS[providerIdx]?.label}):`}
          </Text>
          <TextInput
            value={apiKeyInput}
            onChange={setApiKeyInput}
            onSubmit={() => void handleSaveKey()}
            onCancel={() => setOverlay('none')}
            mask
            placeholder={t(lang, '输入 API Key (留空回车可清除)', 'Enter API key (blank + Enter to clear)')}
            width={modalContentWidth(72) - 4}
            isActive={isActive && !busy}
            prompt="›"
          />
        </Modal>
      ) : null}
    </Box>
  );
});

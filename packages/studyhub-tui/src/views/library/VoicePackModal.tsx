import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner, StatusPill } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { truncateDisplay } from '../../render/cjk.js';
import { currentCourse } from '../../shell/data.js';
import type { VoicePackRenderProps } from '../../shell/AppShell.js';
import {
  atomicWriteExportText,
  defaultBackupFilePath,
  resolveSafeBackupExportPath,
} from '../../host/atomic-write.js';
import { cleanPathInput, getVoicePack, tryAction } from '../../host/sample-actions.js';

export type VoicePackMode = 'due' | 'weak' | 'all';
export type VoicePackScope = 'course' | 'deck' | 'all';

interface VoicePackResponse {
  title?: string;
  filename?: string;
  course?: string | null;
  only?: string;
  count?: number;
  totalAvailable?: number;
  markdown?: string;
}

export interface VoicePackModalProps extends VoicePackRenderProps {
  host: HostClient;
  initialCourse?: string | null;
  initialDeckId?: string | null;
}

const MODES: readonly VoicePackMode[] = ['due', 'weak', 'all'];
const LIMITS: readonly number[] = [10, 15, 20, 30, 50, 80, 100];
const MINUTES: readonly number[] = [10, 15, 20, 30, 45, 60, 90, 120];

function stepOption(list: readonly number[], cur: number, dir: -1 | 1): number {
  const idx = list.indexOf(cur);
  if (idx === -1) return dir > 0 ? list[Math.min(list.length - 1, 2)] : list[0];
  return list[Math.max(0, Math.min(list.length - 1, idx + dir))];
}

export const VoicePackModal = memo(function VoicePackModal({
  host,
  isActive,
  onClose,
  width,
  height,
  initialCourse,
  initialDeckId,
}: VoicePackModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);

  const activeCourse = initialCourse !== undefined ? initialCourse : currentCourse(snapshot);
  const activeDeck = useMemo(
    () => (initialDeckId ? (snapshot?.decks ?? []).find((d) => d.id === initialDeckId) ?? null : null),
    [initialDeckId, snapshot?.decks],
  );

  const availableScopes = useMemo<VoicePackScope[]>(() => {
    const list: VoicePackScope[] = [];
    if (activeDeck) list.push('deck');
    if (activeCourse) list.push('course');
    list.push('all');
    return list;
  }, [activeDeck, activeCourse]);

  const [scope, setScope] = useState<VoicePackScope>(() =>
    activeDeck ? 'deck' : activeCourse ? 'course' : 'all',
  );
  const [mode, setMode] = useState<VoicePackMode>('due');
  const [limit, setLimit] = useState<number>(20);
  const [minutes, setMinutes] = useState<number>(30);
  const [reloadTick, setReloadTick] = useState<number>(0);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [pack, setPack] = useState<VoicePackResponse | null>(null);

  const [exporting, setExporting] = useState<boolean>(false);
  const [exportPath, setExportPath] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [savedPath, setSavedPath] = useState<string>('');

  const effectiveScope: VoicePackScope = availableScopes.includes(scope)
    ? scope
    : availableScopes[0];

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');

    const timer = setTimeout(() => {
      const args: Record<string, unknown> = {
        only: mode,
        limit,
        minutes,
        banter: 'light',
        language: lang,
      };
      if (effectiveScope === 'deck' && activeDeck) {
        args.deckId = activeDeck.id;
      } else if (effectiveScope === 'course' && activeCourse) {
        args.course = activeCourse;
      }

      void (async () => {
        const res = await tryAction<VoicePackResponse>(host, 'study.voicePack', args);
        if (!alive) return;
        if (res.ok && res.value) {
          setPack(res.value);
          setError('');
        } else {
          // Fallback to helper wrapper if host expects it
          try {
            const direct = await getVoicePack<VoicePackResponse>(host, args);
            if (!alive) return;
            setPack(direct);
            setError('');
          } catch {
            if (!alive) return;
            setPack(null);
            setError(res.error?.message || t(lang, '生成语音学习包失败', 'Failed to generate voice pack'));
          }
        }
        setLoading(false);
      })();
    }, 100);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [host, effectiveScope, activeDeck, activeCourse, mode, limit, minutes, lang, reloadTick]);

  const defaultExportPath = useMemo(() => {
    const baseDir = host.getLibraryRoot() || process.cwd();
    const rawSlug = pack?.filename
      ? pack.filename.replace(/\.md$/i, '')
      : effectiveScope === 'deck' && activeDeck
        ? `${activeDeck.title ?? activeDeck.id}-${mode}`
        : effectiveScope === 'course' && activeCourse
          ? `${activeCourse}-${mode}`
          : mode;
    return basename(defaultBackupFilePath(baseDir, 'studyhub-voicepack', '.md', rawSlug));
  }, [host, pack?.filename, effectiveScope, activeDeck, activeCourse, mode]);

  const openExportPrompt = useCallback(() => {
    if (!pack?.markdown) {
      notify(t(lang, '当前没有可导出的内容', 'Nothing to export yet'), 'warning');
      return;
    }
    setExportPath(defaultExportPath);
    setExporting(true);
  }, [pack?.markdown, defaultExportPath, notify, lang]);

  const handleExportSubmit = useCallback(
    async (raw: string) => {
      const cleaned = cleanPathInput(raw);
      if (!cleaned) {
        setExporting(false);
        return;
      }
      const md = pack?.markdown;
      if (!md) {
        setExporting(false);
        return;
      }
      const baseDir = host.getLibraryRoot() || process.cwd();
      let safePath: string;
      try {
        safePath = resolveSafeBackupExportPath(baseDir, cleaned, 'studyhub-voicepack', '.md', mode);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(
          t(lang, `导出路径必须在学习库 backups/ 目录内：${msg}`, `Export path must stay inside library backups/: ${msg}`),
          'error',
        );
        return;
      }
      setSaving(true);
      try {
        const written = await atomicWriteExportText(safePath, md);
        setSavedPath(written.path);
        setExporting(false);
        notify(t(lang, `已导出到 ${written.path}`, `Exported to ${written.path}`), 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(t(lang, `导出失败：${msg}`, `Export failed: ${msg}`), 'error');
      } finally {
        setSaving(false);
      }
    },
    [pack?.markdown, host, mode, notify, lang],
  );

  useInput(
    (input, key) => {
      if (exporting || saving) return;
      if (key.return || input === 'e') {
        openExportPrompt();
        return;
      }
      if (input === 's' || key.tab) {
        setScope((prev) => {
          const idx = availableScopes.indexOf(prev);
          return availableScopes[(idx + 1) % availableScopes.length];
        });
        return;
      }
      if (input === '1') setMode('due');
      else if (input === '2') setMode('weak');
      else if (input === '3') setMode('all');
      else if (input === 'm') {
        setMode((prev) => MODES[(MODES.indexOf(prev) + 1) % MODES.length]);
      } else if (input === '-' || input === '_') {
        setLimit((v) => stepOption(LIMITS, v, -1));
      } else if (input === '+' || input === '=') {
        setLimit((v) => stepOption(LIMITS, v, 1));
      } else if (input === '[') {
        setMinutes((v) => stepOption(MINUTES, v, -1));
      } else if (input === ']') {
        setMinutes((v) => stepOption(MINUTES, v, 1));
      } else if (input === 'r') {
        setReloadTick((n) => n + 1);
      }
    },
    { isActive: isActive && !exporting && !saving },
  );

  const frameW = Math.max(46, Math.min(96, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const previewH = Math.max(4, frameH - (exporting ? 12 : 10));

  const hints = useMemo<KeyHint[]>(
    () =>
      exporting
        ? [
            { key: 'Enter', label: t(lang, '写入 .md', 'Save .md') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]
        : [
            { key: 's', label: t(lang, '范围', 'Scope') },
            { key: '1/2/3', label: t(lang, '模式', 'Mode') },
            { key: '-/+', label: t(lang, '题数', 'Limit') },
            { key: '[/]', label: t(lang, '时长', 'Mins') },
            { key: 'e/Enter', label: t(lang, '导出.md', 'Export') },
            { key: 'Esc', label: t(lang, '关闭', 'Close') },
          ],
    [exporting, lang],
  );

  const scopeLabel =
    effectiveScope === 'deck' && activeDeck
      ? `${t(lang, '题组', 'Deck')}: ${truncateDisplay(String(activeDeck.title ?? activeDeck.name ?? activeDeck.id), 20)}`
      : effectiveScope === 'course' && activeCourse
        ? `${t(lang, '课程', 'Course')}: ${truncateDisplay(activeCourse, 20)}`
        : t(lang, '全部课程', 'All courses');

  const modeLabel = (m: VoicePackMode) => {
    if (m === 'due') return t(lang, '到期 due', 'Due');
    if (m === 'weak') return t(lang, '薄弱 weak', 'Weak');
    return t(lang, '全部 all', 'All');
  };

  return (
    <Modal
      title={t(lang, '语音带学包导出', 'Voice Study Pack')}
      icon="♪"
      tone="ai"
      subtitle={pack ? `${pack.count ?? 0}/${pack.totalAvailable ?? 0} ${t(lang, '题', 'cards')}` : undefined}
      width={frameW}
      height={frameH}
      onClose={exporting ? () => setExporting(false) : onClose}
      isActive={isActive && !exporting}
      hints={hints}
    >
      {/* Config strip */}
      <Box flexDirection="column" marginTop={0} flexShrink={0}>
        <Box flexDirection="row" gap={1} flexWrap="nowrap" overflow="hidden">
          <Badge label={scopeLabel} tone="accent" variant="soft" />
          {MODES.map((m, idx) => (
            <Badge
              key={m}
              label={`${idx + 1}:${modeLabel(m)}`}
              tone={mode === m ? 'primary' : 'neutral'}
              variant={mode === m ? 'solid' : 'outline'}
            />
          ))}
        </Box>
        <Box flexDirection="row" gap={2} marginTop={0} height={1}>
          <Text color={theme.muted}>
            {t(lang, '题数上限', 'Limit')}: <Text color={theme.text} bold>{limit}</Text>
          </Text>
          <Text color={theme.muted}>
            {t(lang, '时长预算', 'Budget')}: <Text color={theme.text} bold>{minutes}{t(lang, '分钟', 'm')}</Text>
          </Text>
          {savedPath ? (
            <StatusPill label={truncateDisplay(savedPath, Math.max(12, innerW - 36))} status="ok" />
          ) : null}
        </Box>
      </Box>

      <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>

      {/* Export Path Input */}
      {exporting ? (
        <Box flexDirection="column" marginY={0} flexShrink={0}>
          <Text color={theme.accent} bold>
            {t(lang, '导出 Markdown 文件路径 (支持相对或绝对路径):', 'Export Markdown file path:')}
          </Text>
          <Box borderStyle={asciiMode ? 'classic' : 'round'} borderColor={theme.borderActive} paddingX={1}>
            <TextInput
              value={exportPath}
              onChange={setExportPath}
              onSubmit={(val) => {
                void handleExportSubmit(val);
              }}
              onCancel={() => setExporting(false)}
              isActive={isActive && exporting && !saving}
              width={Math.max(12, innerW - 6)}
              placeholder={defaultExportPath}
            />
          </Box>
        </Box>
      ) : null}

      {/* Preview Body */}
      <Box flexDirection="column" height={previewH} width={innerW} overflow="hidden">
        {loading ? (
          <Box height={previewH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, '正在生成语音带学包…', 'Building voice pack…')} active={isActive} />
          </Box>
        ) : error ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color={theme.error} bold>{t(lang, '生成失败', 'Generation failed')}</Text>
            <Text color={theme.muted}>{error}</Text>
          </Box>
        ) : pack?.markdown ? (
          <MarkdownView
            markdown={pack.markdown}
            width={innerW}
            height={previewH}
            isActive={isActive && !exporting}
          />
        ) : (
          <Box paddingY={1}>
            <Text color={theme.muted}>
              {t(lang, '当前筛选条件下没有可导出的题目，请切换范围或模式。', 'No matching cards for this scope/mode.')}
            </Text>
          </Box>
        )}
      </Box>
    </Modal>
  );
});

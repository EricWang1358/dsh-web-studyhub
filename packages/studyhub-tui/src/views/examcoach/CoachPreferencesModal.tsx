import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  Divider,
  EmptyState,
  Modal,
  Spinner,
  TextInput,
  VirtualList,
  modalContentWidth,
  useInputCapture,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/index.js';

export interface CoachPreferencesModalProps {
  host: HostClient;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
}

interface CoachProfileResult {
  consent?: boolean | null | { prep?: boolean | null };
  goal?: string;
  preferences?: string[];
  summary?: string;
  memoryRevision?: number;
  signals?: {
    got?: number;
    confused?: number;
    easy?: number;
    hard?: number;
    up?: number;
    down?: number;
  };
  updatedAt?: string | null;
  ready?: number;
}

const PREF_MAX_ITEMS = 12;
const PREF_MAX_CHARS = 120;
const GOAL_KEYS = ['', 'exam', 'interview', 'work', 'explore'] as const;
type LearnerGoalKey = (typeof GOAL_KEYS)[number];

function formatGoalLabel(goal: string | undefined, lang: 'zh' | 'en'): string {
  switch (goal) {
    case 'exam':
      return t(lang, '应付考试', 'Pass Exam');
    case 'interview':
      return t(lang, '面试求职', 'Job Interview');
    case 'work':
      return t(lang, '工作中落地', 'Apply at Work');
    case 'explore':
      return t(lang, '兴趣拓展', 'Explore');
    default:
      return t(lang, '未设定', 'Not set');
  }
}

export const CoachPreferencesModal = memo(function CoachPreferencesModal({
  host,
  isActive,
  width,
  height,
  onClose,
}: CoachPreferencesModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<CoachProfileResult | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [addMode, setAddMode] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [confirmKind, setConfirmKind] = useState<'consent-opt-in' | 'forget' | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const seqRef = useRef(0);

  // Hold input capture for the modal lifetime even while ConfirmDialog mounts on top.
  useInputCapture(isActive);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadProfile = useCallback(async () => {
    const seq = ++seqRef.current;
    setError(null);
    const res = await tryAction<CoachProfileResult>(host, 'coach.profile', {});
    if (!mountedRef.current || seq !== seqRef.current) return;
    if (res.ok && res.value) {
      setProfile(res.value);
    } else {
      setError(res.error?.message || t(lang, '读取学习者画像失败', 'Failed to load learner profile'));
    }
    setLoading(false);
  }, [host, lang]);

  useEffect(() => {
    setLoading(true);
    void loadProfile();
  }, [loadProfile]);

  const preferences = useMemo(() => profile?.preferences ?? [], [profile?.preferences]);

  useEffect(() => {
    if (preferences.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
    } else if (selectedIndex >= preferences.length) {
      setSelectedIndex(preferences.length - 1);
    }
  }, [preferences.length, selectedIndex]);

  const selectedPref = preferences[selectedIndex];

  const handleAddSubmit = useCallback(
    async (raw: string) => {
      if (busyRef.current || busy) return;
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) {
        notify(t(lang, '请输入一条学习偏好内容', 'Enter a study preference first'), 'warning');
        return;
      }
      if (text.length > PREF_MAX_CHARS) {
        notify(
          t(lang, `每条学习偏好不超过 ${PREF_MAX_CHARS} 字`, `Max ${PREF_MAX_CHARS} characters per preference`),
          'warning',
        );
        return;
      }
      busyRef.current = true;
      setBusy(true);
      const res = await tryAction<{ preferences?: string[]; memoryRevision?: number }>(host, 'coach.preferences', {
        add: text,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        busyRef.current = false;
        setBusy(false);
        notify(res.error?.message || t(lang, '添加学习偏好失败', 'Failed to add preference'), 'error');
        return;
      }
      setAddMode(false);
      setDraftText('');
      await loadProfile();
      if (!mountedRef.current) return;
      busyRef.current = false;
      setBusy(false);
      notify(t(lang, '已添加学习偏好', 'Study preference added'), 'success');
    },
    [busy, host, lang, loadProfile, notify],
  );

  const handleRemoveSelected = useCallback(async () => {
    if (busyRef.current || busy || !selectedPref) return;
    busyRef.current = true;
    setBusy(true);
    const res = await tryAction<{ preferences?: string[]; memoryRevision?: number }>(host, 'coach.preferences', {
      remove: selectedPref,
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      busyRef.current = false;
      setBusy(false);
      notify(res.error?.message || t(lang, '删除学习偏好失败', 'Failed to remove preference'), 'error');
      return;
    }
    await loadProfile();
    if (!mountedRef.current) return;
    busyRef.current = false;
    setBusy(false);
    notify(t(lang, '已移除学习偏好', 'Study preference removed'), 'success');
  }, [busy, selectedPref, host, lang, loadProfile, notify]);

  const handleCycleGoal = useCallback(async () => {
    if (busyRef.current || busy || loading || addMode) return;
    const currentGoal = profile?.goal ?? '';
    const currentIdx = GOAL_KEYS.indexOf(currentGoal as LearnerGoalKey);
    const nextGoal = GOAL_KEYS[currentIdx >= 0 ? (currentIdx + 1) % GOAL_KEYS.length : 1];
    const expectedRevision = typeof profile?.memoryRevision === 'number' ? profile.memoryRevision : undefined;

    busyRef.current = true;
    setBusy(true);
    const res = await tryAction<{ goal?: string; memoryRevision?: number }>(host, 'coach.goal', {
      goal: nextGoal,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    if (!mountedRef.current) return;
    busyRef.current = false;
    setBusy(false);
    if (!res.ok || !res.value) {
      const errMsg = res.error?.message || t(lang, '更新学习目标失败', 'Failed to update learning goal');
      notify(errMsg, 'error');
      if (res.error?.code === 'MEMORY_REVISION_CONFLICT' || /刷新后重试/.test(errMsg)) {
        void loadProfile();
      }
      return;
    }
    const savedGoal = typeof res.value.goal === 'string' ? res.value.goal : nextGoal;
    const nextRevision = typeof res.value.memoryRevision === 'number' ? res.value.memoryRevision : expectedRevision;
    setProfile((prev) =>
      prev
        ? {
            ...prev,
            goal: savedGoal,
            ...(typeof nextRevision === 'number' ? { memoryRevision: nextRevision } : {}),
          }
        : prev,
    );
    notify(
      t(
        lang,
        `学习目标已切换为: ${formatGoalLabel(savedGoal, lang)}`,
        `Learning goal updated: ${formatGoalLabel(savedGoal, lang)}`,
      ),
      'success',
    );
  }, [busy, loading, addMode, profile?.goal, profile?.memoryRevision, host, lang, notify, loadProfile]);

  const prepConsent = useMemo(() => {
    const raw = profile?.consent;
    if (typeof raw === 'boolean') return raw;
    if (raw && typeof raw === 'object') return raw.prep === true;
    return false;
  }, [profile?.consent]);

  const handleConsentChange = useCallback(
    async (nextPrep: boolean) => {
      if (busyRef.current || busy) return;
      busyRef.current = true;
      setBusy(true);
      const res = await tryAction<{ consent?: boolean | null; ready?: number }>(host, 'coach.consent', {
        prep: nextPrep,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        busyRef.current = false;
        setBusy(false);
        notify(res.error?.message || t(lang, '更新后台备题授权失败', 'Failed to update auto-prep consent'), 'error');
        return;
      }
      await loadProfile();
      if (!mountedRef.current) return;
      busyRef.current = false;
      setBusy(false);
      notify(
        nextPrep
          ? t(lang, '已开启后台变式备题授权', 'Background variant prep enabled')
          : t(lang, '已关闭后台变式备题授权', 'Background variant prep disabled'),
        'success',
      );
    },
    [busy, host, lang, loadProfile, notify],
  );

  const handleForgetProfile = useCallback(async () => {
    if (busyRef.current || busy) return;
    busyRef.current = true;
    setBusy(true);
    const res = await tryAction<CoachProfileResult>(host, 'coach.forget', {});
    if (!mountedRef.current) return;
    if (!res.ok) {
      busyRef.current = false;
      setBusy(false);
      notify(res.error?.message || t(lang, '重置学习者画像失败', 'Failed to reset learner profile'), 'error');
      return;
    }
    if (res.value) {
      setProfile(res.value);
    } else {
      await loadProfile();
      if (!mountedRef.current) return;
    }
    setSelectedIndex(0);
    busyRef.current = false;
    setBusy(false);
    notify(
      t(lang, '已重置学习者画像与待备变式题（练习记录已保留）', 'Learner profile & pending prepared cards reset (practice history kept)'),
      'success',
    );
  }, [busy, host, lang, loadProfile, notify]);

  useInput(
    (input) => {
      if (loading || busyRef.current || busy || addMode || confirmKind !== null) return;
      if (input === 'r') {
        setLoading(true);
        void loadProfile();
        return;
      }
      if (!profile) return;
      if (input === 'g') {
        void handleCycleGoal();
        return;
      }
      if (input === 'p') {
        if (prepConsent) {
          void handleConsentChange(false);
        } else {
          setConfirmKind('consent-opt-in');
        }
        return;
      }
      if (input === 'F') {
        setConfirmKind('forget');
        return;
      }
      if (input === 'a') {
        if (preferences.length >= PREF_MAX_ITEMS) {
          notify(
            t(lang, `学习偏好最多保存 ${PREF_MAX_ITEMS} 条`, `Up to ${PREF_MAX_ITEMS} preferences allowed`),
            'warning',
          );
          return;
        }
        setDraftText('');
        setAddMode(true);
        return;
      }
      if (input === 'd' && selectedPref) {
        void handleRemoveSelected();
      }
    },
    { isActive: isActive && !loading && !busy && !addMode && confirmKind === null },
  );

  const frameW = Math.max(46, Math.min(82, width - 2));
  const frameH = Math.max(16, Math.min(28, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);
  const summaryLinesCount = bodyH >= 15 ? 2 : 1;
  const addAreaRows = addMode ? 3 : 0;
  // Budget: 1 (goal/consent) + 1 (signals) + summaryLinesCount + 1 (divider) + 1 (list title) + addAreaRows
  const listH = Math.max(3, bodyH - (4 + summaryLinesCount + addAreaRows));
  const ell = asciiMode ? '...' : '…';

  const hints = useMemo<KeyHint[]>(() => {
    if (addMode) {
      return [
        { key: 'Enter', label: t(lang, '保存偏好', 'Save') },
        { key: 'Esc', label: t(lang, '取消输入', 'Cancel') },
      ];
    }
    const out: KeyHint[] = [
      { key: 'g', label: t(lang, '目标', 'Goal') },
      { key: 'p', label: t(lang, '备题', 'Prep') },
      { key: 'a', label: t(lang, '添加', 'Add') },
    ];
    if (preferences.length > 0) {
      out.push({ key: 'd', label: t(lang, '删除', 'Del') });
    }
    out.push({ key: 'F', label: t(lang, '重置', 'Reset') });
    out.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    out.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return out;
  }, [addMode, preferences.length, lang]);

  const signalsText = useMemo(() => {
    const sig = profile?.signals;
    if (!sig) return '';
    return t(
      lang,
      `反馈信号: 懂了 ${sig.got ?? 0} · 困惑 ${sig.confused ?? 0} · 太简 ${sig.easy ?? 0} · 太难 ${sig.hard ?? 0} · 赞 ${sig.up ?? 0} · 踩 ${sig.down ?? 0}`,
      `Signals: Got ${sig.got ?? 0} · Confused ${sig.confused ?? 0} · Easy ${sig.easy ?? 0} · Hard ${sig.hard ?? 0} · Up ${sig.up ?? 0} · Down ${sig.down ?? 0}`,
    );
  }, [profile?.signals, lang]);

  const summaryLines = useMemo(() => {
    const raw = (profile?.summary ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) {
      return [t(lang, '画像摘要: 暂无（完成练习与反馈后将自动沉淀）', 'Summary: None yet (builds from practice & feedback)')];
    }
    const prefix = t(lang, '画像摘要: ', 'Summary: ');
    const full = `${prefix}${raw}`;
    if (summaryLinesCount === 1) {
      return [truncateDisplay(full, innerW, ell)];
    }
    const first = truncateDisplay(full, innerW, '');
    const rest = full.slice(first.length).trim();
    if (!rest) return [first, ''];
    return [first, truncateDisplay(rest, innerW, ell)];
  }, [profile?.summary, summaryLinesCount, innerW, ell, lang]);

  const renderPrefRow = useCallback(
    (pref: string, ctx: VirtualListRenderContext) => {
      const marker = ctx.selected ? (asciiMode ? '>' : '▸') : asciiMode ? '-' : '•';
      const label = `${marker} ${ctx.index + 1}. ${pref}`;
      return (
        <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
          {truncateDisplay(label, ctx.width, ell)}
        </Text>
      );
    },
    [asciiMode, theme, ell],
  );

  return (
    <>
      <Modal
        title={t(lang, '学习者画像与长期偏好', 'Learner Profile & Preferences')}
        icon={asciiMode ? 'o' : '◎'}
        tone="primary"
        subtitle={profile ? `${preferences.length}/${PREF_MAX_ITEMS}` : undefined}
        width={frameW}
        height={frameH}
        onClose={addMode || confirmKind !== null ? undefined : onClose}
        isActive={isActive && confirmKind === null}
        hints={hints}
      >
        {loading ? (
          <Box height={bodyH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, `正在读取学习者画像与偏好${ell}`, `Loading learner profile & preferences${ell}`)} active={isActive} />
          </Box>
        ) : error && !profile ? (
          <EmptyState
            icon={asciiMode ? '!' : '✕'}
            title={t(lang, '无法读取学习者画像', 'Cannot load learner profile')}
            hint={error}
            actions={[
              { key: 'r', label: t(lang, '重试', 'Retry') },
              { key: 'Esc', label: t(lang, '关闭', 'Close') },
            ]}
            width={innerW}
            height={bodyH}
          />
        ) : (
          <Box flexDirection="column" height={bodyH} overflow="hidden">
            {/* Row 1: Goal, Consent & Ready status */}
            <Box height={1} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
              <Box gap={1} overflow="hidden">
                <Badge label={`${t(lang, '[g] 目标', '[g] Goal')}: ${formatGoalLabel(profile?.goal, lang)}`} tone="accent" variant="soft" />
                <Badge
                  label={
                    prepConsent
                      ? t(lang, '[p] 后台备题: ON', '[p] Auto-Prep: ON')
                      : t(lang, '[p] 后台备题: OFF', '[p] Auto-Prep: OFF')
                  }
                  tone={prepConsent ? 'success' : 'muted'}
                  variant="outline"
                />
                {typeof profile?.ready === 'number' ? (
                  <Badge label={`${t(lang, '已备题', 'Ready')}: ${profile.ready}`} tone={profile.ready > 0 ? 'primary' : 'muted'} variant="soft" />
                ) : null}
              </Box>
              <Box flexShrink={0}>{busy ? <Spinner label={t(lang, `保存中${ell}`, `Saving${ell}`)} active={isActive} /> : null}</Box>
            </Box>

            {/* Row 2: Signals overview */}
            <Box height={1} overflow="hidden" flexShrink={0}>
              <Text color={theme.muted} wrap="truncate-end">
                {truncateDisplay(signalsText, innerW, ell)}
              </Text>
            </Box>

            {/* Row 3..4: Profile summary */}
            <Box height={summaryLinesCount} flexDirection="column" overflow="hidden" flexShrink={0}>
              {summaryLines.slice(0, summaryLinesCount).map((line, i) => (
                <Text key={i} color={profile?.summary?.trim() ? theme.text : theme.dim} wrap="truncate-end">
                  {line || ' '}
                </Text>
              ))}
            </Box>

            <Divider width={innerW} />

            {/* Preferences header */}
            <Box height={1} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
              <Text color={theme.heading} bold>
                {t(lang, `长期学习偏好 (${preferences.length}/${PREF_MAX_ITEMS})`, `Study Preferences (${preferences.length}/${PREF_MAX_ITEMS})`)}
              </Text>
              <Text color={theme.dim} wrap="truncate-end">
                {addMode
                  ? t(lang, `输入中${ell}`, `Typing${ell}`)
                  : t(lang, `[a] 添加  [d] 删除  [F] 重置画像`, `[a] Add  [d] Remove  [F] Reset`)}
              </Text>
            </Box>

            {/* Preferences VirtualList */}
            <Box height={listH} flexDirection="column" overflow="hidden" flexShrink={0}>
              <VirtualList
                items={preferences}
                width={innerW}
                height={listH}
                selectedIndex={selectedIndex}
                onChange={setSelectedIndex}
                isActive={isActive && !loading && !busy && !addMode && confirmKind === null}
                keyExtractor={(item, idx) => `${idx}:${item}`}
                emptyText={t(lang, '暂无自定义学习偏好', 'No study preferences yet')}
                emptyHint={t(
                  lang,
                  '按 [a] 添加，例如“多举工程实例”或“先给直观直觉再写推导”',
                  'Press [a] to add, e.g. "Prefer concrete engineering examples"',
                )}
                renderItem={renderPrefRow}
              />
            </Box>

            {/* Inline Add Input */}
            {addMode ? (
              <Box height={3} flexDirection="column" overflow="hidden" flexShrink={0}>
                <Text color={theme.primary} bold wrap="truncate-end">
                  {t(
                    lang,
                    `新增偏好（≤${PREF_MAX_CHARS}字，Enter 保存 / Esc 取消）：`,
                    `New preference (<=${PREF_MAX_CHARS} chars, Enter save / Esc cancel):`,
                  )}
                </Text>
                <TextInput
                  value={draftText}
                  onChange={setDraftText}
                  placeholder={t(lang, `输入长期学习偏好${ell}`, `Enter a long-term study preference${ell}`)}
                  isActive={isActive && addMode && !busy}
                  width={Math.max(10, innerW - 4)}
                  maxLength={PREF_MAX_CHARS}
                  onSubmit={(val) => void handleAddSubmit(val)}
                  onCancel={() => {
                    setAddMode(false);
                    setDraftText('');
                  }}
                />
                <Text color={theme.dim} wrap="truncate-end">
                  {`${draftText.trim().length}/${PREF_MAX_CHARS}`}
                </Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Modal>

      {confirmKind === 'consent-opt-in' ? (
        <ConfirmDialog
          title={t(lang, '开启后台变式备题', 'Enable Background Variant Prep')}
          message={t(
            lang,
            '开启后，教练会在后台调用 AI 为近期错题预备举一反三变式题。可随时按 [p] 关闭。是否确认开启？',
            'Opting in lets the Coach call AI in the background to prepare variant questions for recent mistakes. You can turn this off anytime with [p]. Enable now?',
          )}
          confirmLabel={t(lang, '确认开启', 'Enable')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && confirmKind === 'consent-opt-in' && !busy}
          onConfirm={() => {
            setConfirmKind(null);
            void handleConsentChange(true);
          }}
          onCancel={() => setConfirmKind(null)}
        />
      ) : null}

      {confirmKind === 'forget' ? (
        <ConfirmDialog
          title={t(lang, '重置学习者画像', 'Reset Learner Profile')}
          message={t(
            lang,
            '将清空学习目标、长期学习偏好、后台备题授权及待练定制题；历史练习记录与题库完整保留。确认重置吗？',
            'This clears your learning goal, study preferences, auto-prep consent, and pending prepared cards. Your decks and practice history stay intact. Reset profile?',
          )}
          confirmLabel={t(lang, '确认重置', 'Reset Profile')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && confirmKind === 'forget' && !busy}
          onConfirm={() => {
            setConfirmKind(null);
            void handleForgetProfile();
          }}
          onCancel={() => setConfirmKind(null)}
        />
      ) : null}
    </>
  );
});

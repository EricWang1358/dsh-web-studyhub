import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';

export interface TranslationGlossaryModalProps {
  host: HostClient;
  documentId?: string;
  sourceId?: string;
  revision?: string;
  title?: string;
  isActive: boolean;
  onClose: () => void;
}

export interface GlossaryEntry {
  term: string;
  to: string;
}

export interface SavedTranslationItem {
  key: string;
  kind?: 'paragraph' | 'selection' | string;
  sourceId: string;
  start: number;
  end: number;
  ordinal?: number;
  hash: string;
  quote: string;
  target: 'zh' | 'en' | string;
  text: string;
  version?: number;
  outdated?: boolean;
  at?: string;
  updatedAt?: string;
}

interface StaleRevisionGroup {
  revision: string;
  count: number;
  savedAt?: string;
}

interface GlossaryGetResponse {
  documentId?: string;
  target?: 'zh' | 'en';
  targetSource?: string;
  glossary?: GlossaryEntry[];
}

interface GlossarySetResponse {
  documentId?: string;
  target?: 'zh' | 'en';
  targetSource?: string;
  glossary?: GlossaryEntry[];
  affected?: {
    count?: number;
    passages?: Array<Record<string, unknown>>;
  };
}

interface TranslationListResponse {
  documentId?: string;
  revision?: string;
  target?: 'zh' | 'en';
  targetSource?: string;
  glossary?: GlossaryEntry[];
  items?: SavedTranslationItem[];
  stale?: StaleRevisionGroup[];
  otherTarget?: number;
  modelAvailable?: boolean;
}

interface TranslationDeleteResponse {
  deleted?: number;
  documentId?: string;
  revision?: string;
}

type ModalTab = 'glossary' | 'saved';
type AddStep = 'none' | 'term' | 'to';
type ConfirmAction =
  | { kind: 'delete-saved'; item: SavedTranslationItem }
  | { kind: 'clear-saved'; count: number };

function targetLabel(target: 'zh' | 'en', lang: UiLanguage): string {
  if (target === 'en') {
    return t(lang, '英文 (en)', 'English (en)');
  }
  return t(lang, '中文 (zh)', 'Chinese (zh)');
}

function compactOneLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export const TranslationGlossaryModal = memo(function TranslationGlossaryModal({
  host,
  documentId,
  sourceId,
  revision,
  title,
  isActive,
  onClose,
}: TranslationGlossaryModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useStableWindowSize();

  const [tab, setTab] = useState<ModalTab>('glossary');
  const [target, setTarget] = useState<'zh' | 'en'>(lang === 'en' ? 'en' : 'zh');
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [savedItems, setSavedItems] = useState<SavedTranslationItem[]>([]);
  const [staleGroups, setStaleGroups] = useState<StaleRevisionGroup[]>([]);
  const [otherTargetCount, setOtherTargetCount] = useState(0);

  const [glossaryIndex, setGlossaryIndex] = useState(0);
  const [savedIndex, setSavedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addStep, setAddStep] = useState<AddStep>('none');
  const [draftTerm, setDraftTerm] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
    };
  }, []);

  const identityPayload = useMemo(
    () => ({
      ...(documentId ? { documentId } : {}),
      ...(sourceId && !documentId ? { sourceId } : sourceId ? { sourceId } : {}),
      ...(revision ? { revision } : {}),
    }),
    [documentId, revision, sourceId],
  );

  const loadData = useCallback(
    async (explicitTarget?: 'zh' | 'en') => {
      if (!documentId && !sourceId) {
        setLoading(false);
        setLoadError(t(lang, '缺少文档标识，无法加载术语表与译文', 'Missing document identifier'));
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const [glossaryRes, listRes] = await Promise.all([
          tryAction<GlossaryGetResponse>(host, 'materials.translation.glossary.get', identityPayload),
          tryAction<TranslationListResponse>(host, 'materials.translation.list', {
            ...identityPayload,
            ...(explicitTarget ? { target: explicitTarget } : {}),
          }),
        ]);
        if (!mountedRef.current) return;

        if (!glossaryRes.ok && !listRes.ok) {
          setLoadError(
            glossaryRes.error?.message ||
              listRes.error?.message ||
              t(lang, '无法加载术语表与译文', 'Failed to load glossary and saved translations'),
          );
          return;
        }

        const nextTarget: 'zh' | 'en' =
          explicitTarget ??
          (glossaryRes.value?.target === 'en' || glossaryRes.value?.target === 'zh'
            ? glossaryRes.value.target
            : listRes.value?.target === 'en' || listRes.value?.target === 'zh'
              ? listRes.value.target
              : lang === 'en'
                ? 'en'
                : 'zh');

        const nextGlossary = Array.isArray(glossaryRes.value?.glossary)
          ? glossaryRes.value.glossary
          : Array.isArray(listRes.value?.glossary)
            ? listRes.value.glossary
            : [];
        const nextSaved = Array.isArray(listRes.value?.items) ? listRes.value.items : [];
        const nextStale = Array.isArray(listRes.value?.stale) ? listRes.value.stale : [];
        const nextOther = Number(listRes.value?.otherTarget ?? 0) || 0;

        setTarget(nextTarget);
        setGlossary(nextGlossary);
        setSavedItems(nextSaved);
        setStaleGroups(nextStale);
        setOtherTargetCount(nextOther);
      } catch (err) {
        if (mountedRef.current) {
          setLoadError(errorMessage(err));
        }
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [documentId, host, identityPayload, lang, sourceId],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    setGlossaryIndex((prev) => (glossary.length === 0 ? 0 : Math.max(0, Math.min(prev, glossary.length - 1))));
  }, [glossary.length]);

  useEffect(() => {
    setSavedIndex((prev) => (savedItems.length === 0 ? 0 : Math.max(0, Math.min(prev, savedItems.length - 1))));
  }, [savedItems.length]);

  const refreshSavedList = useCallback(
    async (forTarget?: 'zh' | 'en') => {
      const listRes = await tryAction<TranslationListResponse>(host, 'materials.translation.list', {
        ...identityPayload,
        ...(forTarget ? { target: forTarget } : {}),
      });
      if (!mountedRef.current || !listRes.ok || !listRes.value) return;
      setSavedItems(Array.isArray(listRes.value.items) ? listRes.value.items : []);
      setStaleGroups(Array.isArray(listRes.value.stale) ? listRes.value.stale : []);
      setOtherTargetCount(Number(listRes.value.otherTarget ?? 0) || 0);
    },
    [host, identityPayload],
  );

  const persistGlossary = useCallback(
    async (nextGlossary: GlossaryEntry[], actionVerb: 'save' | 'delete', changedTerm: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction<GlossarySetResponse>(host, 'materials.translation.glossary.set', {
          ...identityPayload,
          glossary: nextGlossary,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '保存术语表失败', 'Failed to update glossary'), 'error');
          return;
        }
        const updatedGlossary = Array.isArray(res.value.glossary) ? res.value.glossary : nextGlossary;
        setGlossary(updatedGlossary);
        setAddStep('none');
        setDraftTerm('');
        setDraftTo('');
        await refreshSavedList(target);
        if (!mountedRef.current) return;

        const affectedCount = Number(res.value.affected?.count ?? 0) || 0;
        if (actionVerb === 'delete') {
          notify(
            affectedCount > 0
              ? t(
                  lang,
                  `已删除术语 "${changedTerm}" (${affectedCount} 条已存译文待更新)`,
                  `Deleted term "${changedTerm}" (${affectedCount} saved translation(s) affected)`,
                )
              : t(lang, `已删除术语 "${changedTerm}"`, `Deleted term "${changedTerm}"`),
            'success',
          );
        } else {
          notify(
            affectedCount > 0
              ? t(
                  lang,
                  `已保存术语 "${changedTerm}" (${affectedCount} 条已存译文待更新)`,
                  `Saved term "${changedTerm}" (${affectedCount} saved translation(s) affected)`,
                )
              : t(lang, `已保存术语 "${changedTerm}"`, `Saved term "${changedTerm}"`),
            'success',
          );
        }
      } catch (err) {
        if (mountedRef.current) notify(errorMessage(err), 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [host, identityPayload, lang, notify, refreshSavedList, target],
  );

  const handleToggleTarget = useCallback(async () => {
    if (busyRef.current) return;
    const nextTarget: 'zh' | 'en' = target === 'zh' ? 'en' : 'zh';
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<GlossarySetResponse>(host, 'materials.translation.glossary.set', {
        ...identityPayload,
        target: nextTarget,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '切换目标语言失败', 'Failed to switch target language'), 'error');
        return;
      }
      const resolved = res.value.target === 'en' || res.value.target === 'zh' ? res.value.target : nextTarget;
      setTarget(resolved);
      if (Array.isArray(res.value.glossary)) setGlossary(res.value.glossary);
      await refreshSavedList(resolved);
      if (!mountedRef.current) return;
      notify(
        t(
          lang,
          `目标语言已切换为 ${targetLabel(resolved, lang)}`,
          `Target language switched to ${targetLabel(resolved, lang)}`,
        ),
        'success',
      );
    } catch (err) {
      if (mountedRef.current) notify(errorMessage(err), 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [host, identityPayload, lang, notify, refreshSavedList, target]);

  const handleConfirmSavedDelete = useCallback(
    async (action: ConfirmAction) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const payload =
          action.kind === 'clear-saved'
            ? { ...identityPayload, target, all: true }
            : { ...identityPayload, target, keys: [action.item.key] };
        const res = await tryAction<TranslationDeleteResponse>(host, 'materials.translation.delete', payload);
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '删除已存译文失败', 'Failed to delete saved translation'), 'error');
          return;
        }
        const deleted = Number(res.value.deleted ?? 0) || 0;
        setConfirmAction(null);
        await refreshSavedList(target);
        if (!mountedRef.current) return;
        notify(
          action.kind === 'clear-saved'
            ? t(lang, `已清空 ${deleted} 条已存译文`, `Cleared ${deleted} saved translation(s)`)
            : t(lang, `已删除 ${deleted} 条已存译文`, `Deleted ${deleted} saved translation(s)`),
          'success',
        );
      } catch (err) {
        if (mountedRef.current) notify(errorMessage(err), 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [host, identityPayload, lang, notify, refreshSavedList, target],
  );

  const handleSubmitTermStep = useCallback(
    (rawVal: string) => {
      const cleaned = rawVal.replace(/\s+/g, ' ').trim();
      if (!cleaned) {
        notify(t(lang, '术语原文不能为空', 'Source term cannot be empty'), 'warning');
        return;
      }
      setDraftTerm(cleaned);
      setDraftTo('');
      setAddStep('to');
    },
    [lang, notify],
  );

  const handleSubmitToStep = useCallback(
    (rawVal: string) => {
      const cleanedTo = rawVal.replace(/\s+/g, ' ').trim();
      const term = draftTerm.trim();
      if (!term) {
        setAddStep('none');
        return;
      }
      const existingIdx = glossary.findIndex((g) => g.term.toLowerCase() === term.toLowerCase());
      const nextGlossary =
        existingIdx >= 0
          ? glossary.map((g, idx) => (idx === existingIdx ? { term, to: cleanedTo } : g))
          : [...glossary, { term, to: cleanedTo }];
      void persistGlossary(nextGlossary, 'save', term);
    },
    [draftTerm, glossary, persistGlossary],
  );

  const modalNavActive = isActive && addStep === 'none' && confirmAction === null;
  const claimKeys = useMemo(() => ['1', '2', 'a', 'd', 'l', 'C', 'j', 'k', 'r'], []);
  useClaimKeys(claimKeys, modalNavActive);

  useInput(
    (input, key) => {
      if (!modalNavActive || busyRef.current || busy) return;
      if (key.ctrl || key.meta) return;
      if (key.tab) {
        setTab((prev) => (prev === 'glossary' ? 'saved' : 'glossary'));
        return;
      }
      if (input === '1') {
        setTab('glossary');
        return;
      }
      if (input === '2') {
        setTab('saved');
        return;
      }
      if (input === 'r') {
        void loadData(target);
        return;
      }

      if (tab === 'glossary') {
        if (input === 'a') {
          setDraftTerm('');
          setDraftTo('');
          setAddStep('term');
          return;
        }
        if (input === 'l') {
          void handleToggleTarget();
          return;
        }
        if (input === 'd') {
          const entry = glossary[glossaryIndex];
          if (!entry) return;
          const nextGlossary = glossary.filter((_, idx) => idx !== glossaryIndex);
          void persistGlossary(nextGlossary, 'delete', entry.term);
        }
        return;
      }

      if (tab === 'saved') {
        if (input === 'd') {
          const item = savedItems[savedIndex];
          if (!item) return;
          setConfirmAction({ kind: 'delete-saved', item });
          return;
        }
        if (input === 'C') {
          if (savedItems.length === 0) return;
          setConfirmAction({ kind: 'clear-saved', count: savedItems.length });
        }
      }
    },
    { isActive: modalNavActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (addStep !== 'none') {
      return [
        { key: 'Enter', label: addStep === 'term' ? t(lang, '下一步', 'Next') : t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    if (tab === 'glossary') {
      return [
        { key: 'Tab/1-2', label: t(lang, '切页', 'Tabs') },
        { key: 'a', label: t(lang, '添加', 'Add') },
        ...(glossary.length > 0 ? [{ key: 'd', label: t(lang, '删除', 'Del') }] : []),
        { key: 'l', label: t(lang, '语言', 'Lang') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'Tab/1-2', label: t(lang, '切页', 'Tabs') },
      ...(savedItems.length > 0
        ? [
            { key: 'd', label: t(lang, '删除', 'Del') },
            { key: 'C', label: t(lang, '清空', 'Clear') },
          ]
        : []),
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [addStep, glossary.length, lang, savedItems.length, tab]);

  const frameWidth = Math.max(48, Math.min(92, columns - 4));
  const frameHeight = Math.max(14, Math.min(28, termRows - 2));
  const innerWidth = modalContentWidth(frameWidth);
  const innerHeight = Math.max(6, frameHeight - 5);

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' - ' : ' · ';
  const arrow = asciiMode ? ' -> ' : ' → ';
  const icon = asciiMode ? 'G' : '译';

  const staleCount = useMemo(
    () => staleGroups.reduce((acc, g) => acc + (Number(g.count) || 0), 0),
    [staleGroups],
  );

  const selectedGlossary = glossary[glossaryIndex];
  const selectedSaved = savedItems[savedIndex];

  const addRows = tab === 'glossary' && addStep !== 'none' ? 3 : 0;
  const showPreview =
    addRows === 0 &&
    innerHeight >= 11 &&
    ((tab === 'glossary' && Boolean(selectedGlossary)) || (tab === 'saved' && Boolean(selectedSaved)));
  const previewRows = showPreview ? 3 : 0;
  const statusRows = busy ? 1 : 0;
  const listHeight = Math.max(3, innerHeight - 2 - addRows - previewRows - statusRows);

  const subtitle = title ? truncateDisplay(title, Math.max(12, Math.floor(innerWidth * 0.38)), ell) : undefined;

  const termPrompt = t(lang, '术语原文: ', 'Source term: ');
  const toPrompt = t(lang, '译法(空=原样): ', 'Target(empty=keep): ');
  const activePrompt = addStep === 'term' ? termPrompt : toPrompt;
  const boundedInputW = Math.max(12, innerWidth - displayWidth(activePrompt));

  return (
    <>
      <Modal
        title={t(lang, '翻译术语表与已存译文', 'Translation Glossary & Saved')}
        subtitle={subtitle}
        icon={icon}
        tone="info"
        width={frameWidth}
        height={frameHeight}
        isActive={modalNavActive}
        onClose={onClose}
        hints={hints}
      >
        <Box flexDirection="column" height={innerHeight} width={innerWidth}>
          {/* Tab header */}
          <Box height={1} width={innerWidth} flexDirection="row" alignItems="center" overflow="hidden">
            <Badge
              label={`1:${t(lang, '术语表', 'Glossary')} (${glossary.length})`}
              tone={tab === 'glossary' ? 'primary' : 'muted'}
              variant={tab === 'glossary' ? 'solid' : 'outline'}
            />
            <Text> </Text>
            <Badge
              label={`2:${t(lang, '已存译文', 'Saved')} (${savedItems.length})`}
              tone={tab === 'saved' ? 'primary' : 'muted'}
              variant={tab === 'saved' ? 'solid' : 'outline'}
            />
            <Box flexGrow={1} />
            <Badge label={target.toUpperCase()} tone="accent" variant="soft" />
          </Box>

          {/* Status summary line */}
          <Box height={1} width={innerWidth} flexDirection="row" alignItems="center">
            <Text color={theme.dim} wrap="truncate-end">
              {truncateDisplay(
                tab === 'glossary'
                  ? t(
                      lang,
                      `目标语言: ${targetLabel(target, lang)} ([l] 切换)  共 ${glossary.length} 条术语`,
                      `Target: ${targetLabel(target, lang)} ([l] toggle)  ${glossary.length} term(s)`,
                    )
                  : t(
                      lang,
                      `当前版本 ${savedItems.length} 条 (${target})${staleCount > 0 ? `${sep}旧版本过期 ${staleCount} 条` : ''}${otherTargetCount > 0 ? `${sep}另一语言 ${otherTargetCount} 条` : ''}`,
                      `${savedItems.length} saved (${target})${staleCount > 0 ? `${sep}${staleCount} stale` : ''}${otherTargetCount > 0 ? `${sep}${otherTargetCount} other lang` : ''}`,
                    ),
                innerWidth,
                ell,
              )}
            </Text>
          </Box>

          {loading ? (
            <Box paddingY={1}>
              <Spinner
                label={
                  asciiMode
                    ? t(lang, '正在加载术语表与译文...', 'Loading glossary & translations...')
                    : t(lang, '正在加载术语表与译文…', 'Loading glossary & translations…')
                }
                active={isActive}
              />
            </Box>
          ) : loadError ? (
            <EmptyState
              title={t(lang, '加载失败', 'Load Failed')}
              hint={loadError}
              width={innerWidth}
              height={Math.max(3, innerHeight - 2)}
            />
          ) : tab === 'glossary' ? (
            <>
              {glossary.length === 0 ? (
                <Box height={listHeight} width={innerWidth}>
                  <EmptyState
                    title={t(lang, '术语表为空', 'No glossary terms yet')}
                    hint={t(
                      lang,
                      '按 [a] 添加术语映射，或按 [l] 切换目标语言 (zh/en)。',
                      'Press [a] to add a term, or [l] to toggle target language (zh/en).',
                    )}
                    width={innerWidth}
                    height={listHeight}
                  />
                </Box>
              ) : (
                <VirtualList
                  items={glossary}
                  height={listHeight}
                  width={innerWidth}
                  selectedIndex={glossaryIndex}
                  onChange={(idx) => setGlossaryIndex(idx)}
                  isActive={modalNavActive && !busy}
                  ascii={asciiMode}
                  keyExtractor={(item, idx) => `g-${idx}-${item.term.toLowerCase()}`}
                  renderItem={(item, ctx) => {
                    const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                    const numTag = `${String(ctx.index + 1).padStart(2, ' ')}. `;
                    const prefixW = displayWidth(cursor) + displayWidth(numTag);
                    const targetText = item.to || t(lang, '(保持原文)', '(keep as written)');
                    const line = truncateDisplay(`${item.term}${arrow}${targetText}`, Math.max(8, ctx.width - prefixW), ell);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                        <Text color={theme.dim}>{numTag}</Text>
                        <Text color={theme.text} bold={ctx.selected}>
                          {line}
                        </Text>
                      </Box>
                    );
                  }}
                />
              )}

              {addStep !== 'none' ? (
                <Box flexDirection="column" height={3} width={innerWidth} overflow="hidden">
                  <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerWidth)}</Text>
                  <Text color={theme.accent} bold wrap="truncate-end">
                    {truncateDisplay(
                      addStep === 'term'
                        ? t(lang, '添加术语 (1/2): 输入原文 (Enter 下一步, Esc 取消)', 'Add term (1/2): Enter source term (Enter next, Esc cancel)')
                        : t(
                            lang,
                            `添加术语 (2/2): "${draftTerm}" -> 译法 (留空保持原文)`,
                            `Add term (2/2): "${draftTerm}" -> translation (empty=keep)`,
                          ),
                      innerWidth,
                      ell,
                    )}
                  </Text>
                  <Box height={1} width={innerWidth} flexDirection="row" alignItems="center">
                    <Box flexShrink={0}>
                      <Text color={theme.primary} bold>
                        {activePrompt}
                      </Text>
                    </Box>
                    <TextInput
                      value={addStep === 'term' ? draftTerm : draftTo}
                      onChange={addStep === 'term' ? setDraftTerm : setDraftTo}
                      onSubmit={addStep === 'term' ? handleSubmitTermStep : handleSubmitToStep}
                      onCancel={() => {
                        setAddStep('none');
                        setDraftTerm('');
                        setDraftTo('');
                      }}
                      placeholder={
                        addStep === 'term'
                          ? t(lang, '例如: FSRS', 'e.g. FSRS')
                          : t(lang, '例如: 间隔重复算法', 'e.g. Spaced Repetition')
                      }
                      maxLength={addStep === 'term' ? 80 : 160}
                      width={boundedInputW}
                      isActive={isActive && !confirmAction && !busy}
                    />
                  </Box>
                </Box>
              ) : showPreview && selectedGlossary ? (
                <Box flexDirection="column" height={3} width={innerWidth} overflow="hidden">
                  <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerWidth)}</Text>
                  <Text color={theme.muted} wrap="truncate-end">
                    {truncateDisplay(
                      `${t(lang, '术语原文', 'Term')}: ${selectedGlossary.term}`,
                      innerWidth,
                      ell,
                    )}
                  </Text>
                  <Text color={theme.text} wrap="truncate-end">
                    {truncateDisplay(
                      `${t(lang, '固定译法', 'Translation')}: ${selectedGlossary.to || t(lang, '(保持原文)', '(keep as written)')}`,
                      innerWidth,
                      ell,
                    )}
                  </Text>
                </Box>
              ) : null}
            </>
          ) : (
            <>
              {savedItems.length === 0 ? (
                <Box height={listHeight} width={innerWidth}>
                  <EmptyState
                    title={t(lang, '当前版本暂无已存译文', 'No saved translations for this revision')}
                    hint={
                      staleCount > 0
                        ? t(
                            lang,
                            `旧版本另有 ${staleCount} 条过期译文；在阅读器按 [t] 可重新翻译当前页。`,
                            `${staleCount} stale translation(s) in older revisions; press [t] in reader to translate.`,
                          )
                        : t(
                            lang,
                            '在阅读器按 [t] 翻译当前页后，保存的译文会显示在这里。',
                            'Press [t] in DocumentReader to translate a page.',
                          )
                    }
                    width={innerWidth}
                    height={listHeight}
                  />
                </Box>
              ) : (
                <VirtualList
                  items={savedItems}
                  height={listHeight}
                  width={innerWidth}
                  selectedIndex={savedIndex}
                  onChange={(idx) => setSavedIndex(idx)}
                  isActive={modalNavActive && !busy}
                  ascii={asciiMode}
                  keyExtractor={(item) => item.key}
                  renderItem={(item, ctx) => {
                    const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                    const staleTag = item.outdated ? `[${t(lang, '待更新', 'stale')}] ` : '';
                    const prefixW = displayWidth(cursor) + displayWidth(staleTag);
                    const qText = compactOneLine(item.quote);
                    const dText = compactOneLine(item.text);
                    const line = truncateDisplay(`${qText}${arrow}${dText}`, Math.max(8, ctx.width - prefixW), ell);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                        {staleTag ? <Text color={theme.warning}>{staleTag}</Text> : null}
                        <Text color={theme.text} bold={ctx.selected}>
                          {line}
                        </Text>
                      </Box>
                    );
                  }}
                />
              )}

              {showPreview && selectedSaved ? (
                <Box flexDirection="column" height={3} width={innerWidth} overflow="hidden">
                  <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerWidth)}</Text>
                  <Text color={theme.muted} wrap="truncate-end">
                    {truncateDisplay(
                      `${t(lang, '原文', 'Source')}: ${compactOneLine(selectedSaved.quote)}`,
                      innerWidth,
                      ell,
                    )}
                  </Text>
                  <Text color={theme.text} wrap="truncate-end">
                    {truncateDisplay(
                      `${t(lang, '译文', 'Trans')}: ${compactOneLine(selectedSaved.text)}`,
                      innerWidth,
                      ell,
                    )}
                  </Text>
                </Box>
              ) : null}
            </>
          )}

          {busy ? (
            <Box height={1} width={innerWidth}>
              <Spinner
                label={
                  asciiMode
                    ? t(lang, '正在保存更改...', 'Saving changes...')
                    : t(lang, '正在保存更改…', 'Saving changes…')
                }
                active={isActive}
              />
            </Box>
          ) : null}
        </Box>
      </Modal>

      {confirmAction ? (
        <ConfirmDialog
          title={
            confirmAction.kind === 'clear-saved'
              ? t(lang, '清空当前版本译文', 'Clear Saved Translations')
              : t(lang, '删除已存译文', 'Delete Saved Translation')
          }
          message={
            confirmAction.kind === 'clear-saved'
              ? t(
                  lang,
                  `确定清空当前版本在 ${target} 下的全部 ${confirmAction.count} 条已存译文吗？`,
                  `Clear all ${confirmAction.count} saved translations (${target}) for this revision?`,
                )
              : t(
                  lang,
                  `确定删除这条已存译文吗？\n"${truncateDisplay(compactOneLine(confirmAction.item.quote), 44, ell)}"`,
                  `Delete this saved translation?\n"${truncateDisplay(compactOneLine(confirmAction.item.quote), 44, ell)}"`,
                )
          }
          danger
          isActive={isActive && !busy}
          onConfirm={() => void handleConfirmSavedDelete(confirmAction)}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
    </>
  );
});

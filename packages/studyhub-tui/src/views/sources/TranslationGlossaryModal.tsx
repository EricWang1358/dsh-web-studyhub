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
  /** Current document page text used as context for AI glossary term suggestions (#1419). */
  pageText?: string;
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
  | { kind: 'clear-saved'; count: number }
  | { kind: 'ai-suggest'; term: string };

interface SuggestNote {
  text: string;
  tone: 'info' | 'warning' | 'success';
}

function targetLabel(target: 'zh' | 'en', lang: UiLanguage): string {
  if (target === 'en') {
    return t(lang, '英文 (en)', 'English (en)');
  }
  return t(lang, '中文 (zh)', 'Chinese (zh)');
}

function compactOneLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function buildGlossarySuggestSystemPrompt(target: 'zh' | 'en'): string {
  if (target === 'en') {
    return (
      'You are a domain-accurate terminology translator for study materials. ' +
      'Given a source term and document context, reply with ONLY the single most standard English translation of that term ' +
      '(or keep the original term if conventionally untranslated). No quotes, no numbering, no explanation.'
    );
  }
  return (
    '你是学习资料的专业术语翻译助手。根据文档标题、上下文与已有术语表，为给定术语给出最准确、常用的中文译法' +
    '（若学科惯例保留原文则直接返回原文）。只输出这一个译法本身，不要加引号、编号或任何解释。'
  );
}

export function buildGlossarySuggestPrompt(params: {
  term: string;
  target: 'zh' | 'en';
  title?: string;
  pageText?: string;
  glossary?: readonly GlossaryEntry[];
}): string {
  const { term, target, title, pageText, glossary } = params;
  const parts: string[] = [];
  parts.push(`目标语言: ${target === 'en' ? 'English (en)' : '简体中文 (zh)'}`);
  if (title?.trim()) parts.push(`资料标题: ${title.trim()}`);
  if (glossary && glossary.length > 0) {
    const sample = glossary
      .slice(0, 15)
      .map((g) => `${g.term} -> ${g.to || '(keep)'}`)
      .join('; ');
    parts.push(`已有术语表: ${sample}`);
  }
  const rawPage = String(pageText ?? '').trim();
  if (rawPage) {
    const lowerPage = rawPage.toLowerCase();
    const lowerTerm = term.trim().toLowerCase();
    const hit = lowerTerm ? lowerPage.indexOf(lowerTerm) : -1;
    let snippet: string;
    if (hit >= 0) {
      const start = Math.max(0, hit - 400);
      const end = Math.min(rawPage.length, hit + lowerTerm.length + 800);
      snippet = rawPage.slice(start, end).trim();
    } else {
      snippet = rawPage.slice(0, 1200).trim();
    }
    if (snippet) parts.push(`资料上下文:\n${snippet}`);
  }
  parts.push(`需要给出固定译法的术语原文: ${term.trim()}`);
  return parts.join('\n\n');
}

export function parseGlossarySuggestion(raw: string): string {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'));
  if (lines.length === 0) return '';
  let candidate = lines[0];
  // Strip leading labels such as "译法：", "建议译法:", "Translation:", "->"
  candidate = candidate.replace(/^(?:(?:建议)?译法|翻译|Translation|Suggested(?:\s+translation)?)\s*[:：\-—→>]\s*/i, '');
  // Strip simple markdown emphasis/code wrappers
  candidate = candidate.replace(/^`+([^`]+)`+$/, '$1').replace(/^\*\*([^*]+)\*\*$/, '$1').replace(/^__([^_]+)__$/, '$1').trim();
  // Strip balanced surrounding quotes/brackets
  const pairs: ReadonlyArray<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['《', '》'],
  ];
  for (const [open, close] of pairs) {
    if (candidate.startsWith(open) && candidate.endsWith(close) && candidate.length > open.length + close.length) {
      candidate = candidate.slice(open.length, candidate.length - close.length).trim();
    }
  }
  return candidate.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export const TranslationGlossaryModal = memo(function TranslationGlossaryModal({
  host,
  documentId,
  sourceId,
  revision,
  title,
  pageText,
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
  const [modelAvailable, setModelAvailable] = useState<boolean>(() =>
    Boolean(host.getConfig()?.effective?.ready || useTuiStore.getState().snapshot?.modelReady),
  );
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<SuggestNote | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const userEditedToRef = useRef(false);

  const cancelAiSuggest = useCallback(() => {
    suggestAbortRef.current?.abort();
    suggestAbortRef.current = null;
    if (mountedRef.current) setSuggesting(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
      suggestAbortRef.current?.abort();
      suggestAbortRef.current = null;
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
        const nextModelAvailable =
          typeof listRes.value?.modelAvailable === 'boolean'
            ? listRes.value.modelAvailable
            : Boolean(host.getConfig()?.effective?.ready || useTuiStore.getState().snapshot?.modelReady);

        setTarget(nextTarget);
        setGlossary(nextGlossary);
        setSavedItems(nextSaved);
        setStaleGroups(nextStale);
        setOtherTargetCount(nextOther);
        setModelAvailable(nextModelAvailable);
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
        cancelAiSuggest();
        setGlossary(updatedGlossary);
        setAddStep('none');
        setDraftTerm('');
        setDraftTo('');
        setSuggestNote(null);
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
    [host, identityPayload, lang, notify, refreshSavedList, target, cancelAiSuggest],
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
      if (action.kind === 'ai-suggest') return;
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

  const canSuggestWithAi = Boolean(modelAvailable && typeof host.streamComplete === 'function');

  const requestAiSuggestion = useCallback(
    async (term: string) => {
      if (typeof host.streamComplete !== 'function') return;
      cancelAiSuggest();
      const ctrl = new AbortController();
      suggestAbortRef.current = ctrl;
      setSuggesting(true);
      setSuggestNote(null);
      try {
        const raw = await host.streamComplete({
          system: buildGlossarySuggestSystemPrompt(target),
          prompt: buildGlossarySuggestPrompt({ term, target, title, pageText, glossary }),
          signal: ctrl.signal,
        });
        if (!mountedRef.current || ctrl.signal.aborted) return;
        const suggestion = parseGlossarySuggestion(raw);
        if (userEditedToRef.current) return;
        if (suggestion) {
          setDraftTo(suggestion);
          setSuggestNote({
            tone: 'success',
            text: t(
              lang,
              'AI 建议已填入：直接 Enter 保存，或编辑/Ctrl+U 改写',
              'AI suggestion pre-filled: Enter to save, or edit / Ctrl+U to replace',
            ),
          });
        } else {
          setSuggestNote({
            tone: 'warning',
            text: t(
              lang,
              'AI 未返回有效译法，请手动输入（留空保持原文）',
              'AI returned no suggestion; enter manually (empty=keep)',
            ),
          });
        }
      } catch (err) {
        if (!mountedRef.current || ctrl.signal.aborted) return;
        if (!userEditedToRef.current) {
          setSuggestNote({
            tone: 'warning',
            text: t(
              lang,
              `AI 建议失败（${errorMessage(err)}），请手动输入译法`,
              `AI suggestion failed (${errorMessage(err)}); enter manually`,
            ),
          });
        }
      } finally {
        if (suggestAbortRef.current === ctrl) {
          suggestAbortRef.current = null;
          if (mountedRef.current) setSuggesting(false);
        }
      }
    },
    [cancelAiSuggest, glossary, host, lang, pageText, target, title],
  );

  const handleSubmitTermStep = useCallback(
    (rawVal: string) => {
      const cleaned = rawVal.replace(/\s+/g, ' ').trim();
      if (!cleaned) {
        notify(t(lang, '术语原文不能为空', 'Source term cannot be empty'), 'warning');
        return;
      }
      cancelAiSuggest();
      userEditedToRef.current = false;
      setDraftTerm(cleaned);
      setDraftTo('');
      if (canSuggestWithAi) {
        setSuggestNote(null);
        setConfirmAction({ kind: 'ai-suggest', term: cleaned });
        return;
      }
      setSuggestNote({
        tone: 'warning',
        text: t(
          lang,
          '未配置可用模型，已切回手动输入（在设置配好模型后可自动建议译法）',
          'No AI model configured; fell back to manual input (configure a model in Settings)',
        ),
      });
      setAddStep('to');
    },
    [canSuggestWithAi, cancelAiSuggest, lang, notify],
  );

  const handleChangeToStep = useCallback(
    (nextVal: string) => {
      userEditedToRef.current = true;
      if (suggestAbortRef.current) cancelAiSuggest();
      setDraftTo(nextVal);
    },
    [cancelAiSuggest],
  );

  const handleSubmitToStep = useCallback(
    (rawVal: string) => {
      cancelAiSuggest();
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
    [cancelAiSuggest, draftTerm, glossary, persistGlossary],
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
          cancelAiSuggest();
          userEditedToRef.current = false;
          setDraftTerm('');
          setDraftTo('');
          setSuggestNote(null);
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

  const hasStep2Status = tab === 'glossary' && addStep === 'to' && (suggesting || Boolean(suggestNote));
  const addRows = tab === 'glossary' && addStep !== 'none' ? (hasStep2Status ? 4 : 3) : 0;
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
                <Box flexDirection="column" height={addRows} width={innerWidth} overflow="hidden">
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
                  {hasStep2Status ? (
                    <Box height={1} width={innerWidth} flexDirection="row" alignItems="center">
                      {suggesting ? (
                        <Spinner
                          label={
                            asciiMode
                              ? t(lang, 'AI 正在按资料上下文建议译法...', 'AI suggesting translation from context...')
                              : t(lang, 'AI 正在按资料上下文建议译法…', 'AI suggesting translation from context…')
                          }
                          active={isActive}
                        />
                      ) : suggestNote ? (
                        <Text
                          color={
                            suggestNote.tone === 'success'
                              ? theme.success
                              : suggestNote.tone === 'warning'
                                ? theme.warning
                                : theme.dim
                          }
                          wrap="truncate-end"
                        >
                          {truncateDisplay(suggestNote.text, innerWidth, ell)}
                        </Text>
                      ) : null}
                    </Box>
                  ) : null}
                  <Box height={1} width={innerWidth} flexDirection="row" alignItems="center">
                    <Box flexShrink={0}>
                      <Text color={theme.primary} bold>
                        {activePrompt}
                      </Text>
                    </Box>
                    <TextInput
                      value={addStep === 'term' ? draftTerm : draftTo}
                      onChange={addStep === 'term' ? setDraftTerm : handleChangeToStep}
                      onSubmit={addStep === 'term' ? handleSubmitTermStep : handleSubmitToStep}
                      onCancel={() => {
                        cancelAiSuggest();
                        userEditedToRef.current = false;
                        setAddStep('none');
                        setDraftTerm('');
                        setDraftTo('');
                        setSuggestNote(null);
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
            confirmAction.kind === 'ai-suggest'
              ? t(lang, 'AI 建议译法', 'AI Suggest Translation')
              : confirmAction.kind === 'clear-saved'
                ? t(lang, '清空当前版本译文', 'Clear Saved Translations')
                : t(lang, '删除已存译文', 'Delete Saved Translation')
          }
          message={
            confirmAction.kind === 'ai-suggest'
              ? t(
                  lang,
                  `将调用模型为术语 "${confirmAction.term}" 建议 ${targetLabel(target, lang)} 译法（预计调用: 1 次轻量模型调用）。\n确认后自动填入输入框，可直接回车保存或修改；取消则直接手动输入。`,
                  `Call AI to suggest a ${targetLabel(target, lang)} translation for "${confirmAction.term}" (est. 1 lightweight model call).\nConfirm to pre-fill the input (editable), or cancel to type manually.`,
                )
              : confirmAction.kind === 'clear-saved'
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
          confirmLabel={
            confirmAction.kind === 'ai-suggest' ? t(lang, 'AI 建议', 'Suggest with AI') : undefined
          }
          cancelLabel={
            confirmAction.kind === 'ai-suggest' ? t(lang, '手动输入', 'Manual input') : undefined
          }
          danger={confirmAction.kind !== 'ai-suggest'}
          isActive={isActive && !busy}
          onConfirm={() => {
            if (confirmAction.kind === 'ai-suggest') {
              const term = confirmAction.term;
              setConfirmAction(null);
              setAddStep('to');
              void requestAiSuggestion(term);
              return;
            }
            void handleConfirmSavedDelete(confirmAction);
          }}
          onCancel={() => {
            if (confirmAction.kind === 'ai-suggest') {
              setConfirmAction(null);
              setSuggestNote({
                tone: 'info',
                text: t(
                  lang,
                  '已跳过 AI 建议，可手动输入译法（留空保持原文）',
                  'Skipped AI suggestion; enter manually (empty=keep)',
                ),
              });
              setAddStep('to');
              return;
            }
            setConfirmAction(null);
          }}
        />
      ) : null}
    </>
  );
});

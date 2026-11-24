import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import { useTheme } from '../../theme/tokens.js';
import { Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { truncateDisplay } from '../../render/cjk.js';
import { t, useTuiStore } from '../../state/store.js';
import { runIdempotentTwoStep } from '../../host/tx-write.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import type { CardSearchOption, NoteItem } from './notes-types.js';

export interface NoteEditorModalProps {
  mode: 'create' | 'edit';
  host: HostClient;
  lang: UiLanguage;
  note?: NoteItem | null;
  focusCourse?: string | null;
  availableDecks?: ReadonlyArray<{ id: string; title?: string; course?: string }>;
  terminalRows: number;
  terminalCols: number;
  onClose: () => void;
  onSaved: (note: NoteItem, created: boolean) => void;
}

type CreateField = 'title' | 'query' | 'cards' | 'markdown';
type EditField = 'title' | 'markdown';

export const NoteEditorModal = memo(function NoteEditorModal({
  mode,
  host,
  lang,
  note,
  focusCourse,
  availableDecks = [],
  terminalRows,
  terminalCols,
  onClose,
  onSaved,
}: NoteEditorModalProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const frameWidth = Math.max(54, Math.min(88, terminalCols - 6));
  const innerWidth = modalContentWidth(frameWidth);

  const initialTitle = mode === 'edit' ? note?.title || '' : '';
  const initialMarkdown = mode === 'edit' ? note?.markdown || '' : '';
  const [title, setTitle] = useState(() => initialTitle);
  const [markdown, setMarkdown] = useState(() => initialMarkdown);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<CardSearchOption[]>([]);
  const [selectedCards, setSelectedCards] = useState<Array<{ deckId: string; cardId: string }>>([]);
  const [cardCursor, setCardCursor] = useState(0);
  const [loadingCards, setLoadingCards] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState('');
  const [createField, setCreateField] = useState<CreateField>('title');
  const [editField, setEditField] = useState<EditField>('markdown');

  const dirty =
    mode === 'edit'
      ? title !== initialTitle || markdown !== initialMarkdown
      : title.trim().length > 0 || markdown.trim().length > 0;

  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load initial candidate cards from current course / first available decks in create mode
  useEffect(() => {
    if (mode !== 'create') return undefined;
    let cancelled = false;
    const loadInitialCards = async () => {
      setLoadingCards(true);
      try {
        const sortedDecks = [...availableDecks].sort((a, b) => {
          const aMatch = focusCourse && a.course === focusCourse ? 0 : 1;
          const bMatch = focusCourse && b.course === focusCourse ? 0 : 1;
          return aMatch - bMatch;
        });
        const collected: CardSearchOption[] = [];
        for (const d of sortedDecks.slice(0, 4)) {
          if (collected.length >= 25) break;
          const res = await host.call<{
            id?: string;
            title?: string;
            course?: string;
            cards?: Array<{ id?: string; prompt?: string; topic?: string }>;
          }>('deck.get', { id: d.id });
          if (cancelled || !mountedRef.current) return;
          if (!res.ok || !res.value?.cards) continue;
          for (const c of res.value.cards) {
            if (!c?.id) continue;
            collected.push({
              deckId: d.id,
              cardId: c.id,
              deckTitle: res.value.title || d.title || '',
              course: res.value.course || d.course || '',
              prompt: String(c.prompt || '').replace(/\s+/g, ' ').trim(),
              topic: c.topic,
            });
            if (collected.length >= 25) break;
          }
        }
        if (cancelled || !mountedRef.current) return;
        setCandidates(collected);
        setCardCursor(0);
        if (collected.length > 0) {
          setSelectedCards([{ deckId: collected[0].deckId, cardId: collected[0].cardId }]);
        }
      } catch {
        // ignore card preload failure
      } finally {
        if (!cancelled && mountedRef.current) setLoadingCards(false);
      }
    };
    void loadInitialCards();
    return () => {
      cancelled = true;
    };
  }, [mode, host, availableDecks, focusCourse]);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoadingCards(true);
    setError('');
    try {
      const res = await host.call<{ results?: CardSearchOption[] }>('card.search', {
        query: trimmed,
        limit: 25,
        ...(focusCourse ? { course: focusCourse } : {}),
      });
      if (!mountedRef.current) return;
      if (res.ok && Array.isArray(res.value?.results)) {
        setCandidates(res.value.results);
        setCardCursor(0);
      } else if (!res.ok) {
        setError(res.error?.message || t(lang, '搜索题目失败', 'Failed to search cards'));
      }
    } finally {
      if (mountedRef.current) setLoadingCards(false);
    }
  }, [query, host, focusCourse, lang]);

  const toggleCard = useCallback((opt: CardSearchOption) => {
    setSelectedCards((prev) => {
      const exists = prev.some((c) => c.cardId === opt.cardId);
      if (exists) return prev.filter((c) => c.cardId !== opt.cardId);
      if (prev.length >= 30) return prev;
      return [...prev, { deckId: opt.deckId, cardId: opt.cardId }];
    });
  }, []);

  const createdNoteRef = useRef<NoteItem | null>(null);

  const handleSave = useCallback(async () => {
    if (savingRef.current || saving) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError(t(lang, '请输入笔记标题', 'Please enter a note title'));
      return;
    }
    if (mode === 'create' && !createdNoteRef.current && selectedCards.length === 0) {
      setError(
        candidates.length === 0
          ? t(lang, '当前学习库暂无题目，请先导入或创建至少 1 道题目后再新建笔记', 'No cards in library yet; add at least 1 card before creating a note')
          : t(lang, '请至少选择 1 道关联题目（按空格选中）', 'Select at least 1 linked card (Space to toggle)'),
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (mode === 'create') {
        const customMd = markdown.trim();
        const tx = await runIdempotentTwoStep<NoteItem, NoteItem>({
          cachedStep1: createdNoteRef.current,
          setCachedStep1: (val) => {
            createdNoteRef.current = val;
          },
          step1: async () => {
            const createdRes = await host.call<NoteItem>('note.create', {
              title: trimmedTitle,
              cards: selectedCards,
              language: lang,
            });
            if (!createdRes.ok || !createdRes.value) {
              return { ok: false, error: createdRes.error?.message || t(lang, '创建笔记失败', 'Failed to create note') };
            }
            return { ok: true, value: createdRes.value };
          },
          step2: async (createdNote) => {
            if (!customMd) return { ok: true, value: createdNote };
            const fullMd = customMd.startsWith('# ') ? customMd : `# ${trimmedTitle}\n\n${customMd}\n`;
            const saveRes = await host.call<NoteItem>('note.save', {
              id: createdNote.id,
              title: trimmedTitle,
              markdown: fullMd,
              expectedRevision: createdNote.revision ?? 0,
            });
            if (!saveRes.ok || !saveRes.value) {
              return { ok: false, error: saveRes.error?.message || t(lang, '保存正文失败', 'Failed to write note body') };
            }
            return { ok: true, value: saveRes.value };
          },
        });
        if (!mountedRef.current) return;
        if (!tx.ok) {
          setError(
            tx.step1Succeeded
              ? t(
                  lang,
                  `笔记已创建但正文写入失败（${tx.error}），重试保存将直接写入正文而不会重复创建`,
                  `Note created but writing body failed (${tx.error}); retrying will update it without duplicating`,
                )
              : tx.error,
          );
          return;
        }
        onSaved(tx.step2Value, true);
      } else if (note) {
        const saveRes = await host.call<NoteItem>('note.save', {
          id: note.id,
          title: trimmedTitle,
          markdown,
          expectedRevision: note.revision ?? 0,
        });
        if (!mountedRef.current) return;
        if (!saveRes.ok || !saveRes.value) {
          setError(saveRes.error?.message || t(lang, '保存笔记失败', 'Failed to save note'));
          return;
        }
        onSaved(saveRes.value, false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [saving, title, mode, selectedCards, candidates.length, host, lang, markdown, note, onSaved]);

  const requestClose = useCallback(() => {
    if (savingRef.current || saving) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [saving, dirty, onClose]);

  const markdownFocused = mode === 'create' ? createField === 'markdown' : editField === 'markdown';

  useInput(
    (input, key) => {
      if (key.ctrl && input === 's') {
        // Multiline TextInput invokes onSubmit -> handleSave() on Ctrl+S; avoid duplicate firing in the same tick.
        if (!markdownFocused) {
          void handleSave();
        }
        return;
      }
      if (mode === 'create') {
        const order: CreateField[] = ['title', 'query', 'cards', 'markdown'];
        if (key.tab) {
          const idx = order.indexOf(createField);
          const next = order[(idx + (key.shift ? -1 : 1) + order.length) % order.length];
          setCreateField(next);
          return;
        }
        if (createField === 'cards') {
          if (key.downArrow || input === 'j') {
            setCardCursor((c) => Math.min(Math.max(0, candidates.length - 1), c + 1));
          } else if (key.upArrow || input === 'k') {
            setCardCursor((c) => Math.max(0, c - 1));
          } else if (input === ' ' || key.return) {
            const opt = candidates[cardCursor];
            if (opt) toggleCard(opt);
          }
        }
      } else {
        if (key.tab) {
          setEditField((f) => (f === 'title' ? 'markdown' : 'title'));
        }
      }
    },
    { isActive: !saving && !confirmDiscard },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Tab', label: t(lang, '切换栏位', 'Next field') },
      ...(mode === 'create' && createField === 'cards' ? [{ key: 'Space', label: t(lang, '选/取消题', 'Toggle card') }] : []),
      { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
      { key: 'Esc', label: dirty ? t(lang, '放弃/取消', 'Discard') : t(lang, '取消', 'Cancel') },
    ],
    [lang, mode, createField, dirty],
  );

  const editorHeight = Math.max(5, Math.min(mode === 'edit' ? 14 : 6, terminalRows - (mode === 'edit' ? 13 : 21)));
  const visibleCards = candidates.slice(Math.max(0, cardCursor - 2), Math.max(0, cardCursor - 2) + 5);
  const windowStart = Math.max(0, cardCursor - 2);

  return (
    <>
    <Modal
      title={mode === 'create' ? t(lang, '新建学习笔记', 'New Study Note') : t(lang, '编辑笔记', 'Edit Note')}
      subtitle={dirty ? t(lang, '未保存', 'unsaved') : undefined}
      icon={asciiMode ? '*' : '✎'}
      tone="primary"
      width={frameWidth}
      isActive={!confirmDiscard}
      onClose={saving || confirmDiscard ? undefined : requestClose}
      hints={hints}
    >
      <Box flexDirection="column" gap={0}>
        <Text color={createField === 'title' || (mode === 'edit' && editField === 'title') ? theme.primary : theme.muted} bold>
          {t(lang, '标题', 'Title')}
        </Text>
        <TextInput
          value={title}
          onChange={setTitle}
          onSubmit={() => {
            if (mode === 'create') setCreateField('query');
            else setEditField('markdown');
          }}
          onCancel={requestClose}
          isActive={!saving && !confirmDiscard && (mode === 'create' ? createField === 'title' : editField === 'title')}
          width={innerWidth - 2}
          prompt={asciiMode ? '> ' : '› '}
          placeholder={t(lang, '例如：特征值与特征向量易错整理', 'e.g. Eigenvalues & common pitfalls')}
          maxLength={200}
          captureInput={false}
        />

        {mode === 'create' ? (
          <Box flexDirection="column" marginTop={1}>
            <Box justifyContent="space-between">
              <Text color={createField === 'query' || createField === 'cards' ? theme.primary : theme.muted} bold>
                {t(lang, `关联题目（已选 ${selectedCards.length}/30）`, `Linked Cards (${selectedCards.length}/30)`)}
              </Text>
              {loadingCards ? <Spinner label={t(lang, `搜索中${ell}`, `Searching${ell}`)} /> : null}
            </Box>
            <TextInput
              value={query}
              onChange={setQuery}
              onSubmit={() => {
                if (query.trim()) void runSearch();
                else setCreateField('cards');
              }}
              onCancel={requestClose}
              isActive={!saving && !confirmDiscard && createField === 'query'}
              width={innerWidth - 2}
              prompt={asciiMode ? '? ' : '⌕ '}
              placeholder={t(lang, '输入关键词按 Enter 搜索题目，或 Tab 选下方列表', 'Type keywords + Enter to search, or Tab to pick below')}
              captureInput={false}
            />
            <Box flexDirection="column" marginTop={0} borderStyle={asciiMode ? 'classic' : 'single'} borderColor={createField === 'cards' ? theme.borderActive : theme.border} paddingX={1}>
              {candidates.length === 0 ? (
                <Text color={theme.muted}>
                  {t(lang, '暂无可选题目（需至少 1 道题目才能创建笔记）', 'No cards available (at least 1 card required)')}
                </Text>
              ) : (
                visibleCards.map((opt, idx) => {
                  const realIdx = windowStart + idx;
                  const active = createField === 'cards' && realIdx === cardCursor;
                  const picked = selectedCards.some((c) => c.cardId === opt.cardId);
                  const line = truncateDisplay(opt.prompt || opt.topic || opt.cardId, Math.max(12, innerWidth - 10), asciiMode ? '...' : '…');
                  return (
                    <Text
                      key={`${opt.deckId}:${opt.cardId}`}
                      backgroundColor={active ? theme.selectionBg : undefined}
                      color={active ? theme.selectionFg : picked ? theme.success : theme.text}
                    >
                      {`${active ? (asciiMode ? '>' : '❯') : ' '} [${picked ? (asciiMode ? 'x' : '✓') : ' '}] ${line}`}
                    </Text>
                  );
                })
              )}
            </Box>
          </Box>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          <Text color={(mode === 'create' && createField === 'markdown') || (mode === 'edit' && editField === 'markdown') ? theme.primary : theme.muted} bold>
            {mode === 'create'
              ? t(lang, '正文 Markdown（可选，留空自动生成笔记模板）', 'Markdown Body (optional; leave blank for template)')
              : t(lang, '正文 Markdown', 'Markdown Body')}
          </Text>
          <Box borderStyle={asciiMode ? 'classic' : 'single'} borderColor={(mode === 'create' ? createField === 'markdown' : editField === 'markdown') ? theme.borderActive : theme.border} paddingX={1}>
            <TextInput
              value={markdown}
              onChange={setMarkdown}
              onSubmit={() => void handleSave()}
              onCancel={requestClose}
              multiline
              height={editorHeight}
              width={innerWidth - 4}
              isActive={!saving && !confirmDiscard && (mode === 'create' ? createField === 'markdown' : editField === 'markdown')}
              placeholder={t(lang, `输入 Markdown 内容，按 Ctrl+S 保存${ell}`, `Write Markdown, press Ctrl+S to save${ell}`)}
              captureInput={false}
            />
          </Box>
        </Box>

        {error ? (
          <Box marginTop={1}>
            <Text color={theme.error} wrap="wrap">{`${asciiMode ? '!' : '✕'} ${error}`}</Text>
          </Box>
        ) : null}

        <Box marginTop={1} justifyContent="space-between">
          <Text color={theme.muted}>
            {saving ? t(lang, `正在保存${ell}`, `Saving${ell}`) : t(lang, '按 Ctrl+S 保存，Esc 取消', 'Ctrl+S to save, Esc to cancel')}
          </Text>
          <Text backgroundColor={theme.primary} color={theme.dark ? theme.bg : '#ffffff'} bold>
            {` ${t(lang, '保存 Ctrl+S', 'Save Ctrl+S')} `}
          </Text>
        </Box>
      </Box>
    </Modal>

    {confirmDiscard ? (
      <ConfirmDialog
        title={t(lang, '放弃未保存的笔记修改？', 'Discard unsaved note changes?')}
        message={t(
          lang,
          '当前笔记仍有未保存的编辑内容。放弃后将丢失这些修改。',
          'You have unsaved edits in this note. Closing now will discard them.',
        )}
        confirmLabel={t(lang, '放弃修改', 'Discard')}
        cancelLabel={t(lang, '继续编辑', 'Keep Editing')}
        danger
        isActive={confirmDiscard}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    ) : null}
    </>
  );
});

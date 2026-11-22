import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Modal, modalContentWidth, TextInput, useTheme, Spinner } from '../../components/index.js';
import { truncateDisplay } from '../../render/cjk.js';
import { t, useTuiStore } from '../../state/store.js';
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

  const [title, setTitle] = useState(() => (mode === 'edit' ? note?.title || '' : ''));
  const [markdown, setMarkdown] = useState(() => (mode === 'edit' ? note?.markdown || '' : ''));
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<CardSearchOption[]>([]);
  const [selectedCards, setSelectedCards] = useState<Array<{ deckId: string; cardId: string }>>([]);
  const [cardCursor, setCardCursor] = useState(0);
  const [loadingCards, setLoadingCards] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [createField, setCreateField] = useState<CreateField>('title');
  const [editField, setEditField] = useState<EditField>('markdown');

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

  const handleSave = useCallback(async () => {
    if (savingRef.current || saving) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError(t(lang, '请输入笔记标题', 'Please enter a note title'));
      return;
    }
    if (mode === 'create' && selectedCards.length === 0) {
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
        const createdRes = await host.call<NoteItem>('note.create', {
          title: trimmedTitle,
          cards: selectedCards,
          language: lang,
        });
        if (!mountedRef.current) return;
        if (!createdRes.ok || !createdRes.value) {
          setError(createdRes.error?.message || t(lang, '创建笔记失败', 'Failed to create note'));
          return;
        }
        let finalNote = createdRes.value;
        const customMd = markdown.trim();
        if (customMd) {
          const fullMd = customMd.startsWith('# ') ? customMd : `# ${trimmedTitle}\n\n${customMd}\n`;
          const saveRes = await host.call<NoteItem>('note.save', {
            id: finalNote.id,
            title: trimmedTitle,
            markdown: fullMd,
            expectedRevision: finalNote.revision ?? 0,
          });
          if (!mountedRef.current) return;
          if (saveRes.ok && saveRes.value) finalNote = saveRes.value;
        }
        onSaved(finalNote, true);
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
    { isActive: !saving },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Tab', label: t(lang, '切换栏位', 'Next field') },
      ...(mode === 'create' && createField === 'cards' ? [{ key: 'Space', label: t(lang, '选/取消题', 'Toggle card') }] : []),
      { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ],
    [lang, mode, createField],
  );

  const editorHeight = Math.max(5, Math.min(mode === 'edit' ? 14 : 6, terminalRows - (mode === 'edit' ? 13 : 21)));
  const visibleCards = candidates.slice(Math.max(0, cardCursor - 2), Math.max(0, cardCursor - 2) + 5);
  const windowStart = Math.max(0, cardCursor - 2);

  return (
    <Modal
      title={mode === 'create' ? t(lang, '新建学习笔记', 'New Study Note') : t(lang, '编辑笔记', 'Edit Note')}
      icon={asciiMode ? '*' : '✎'}
      tone="primary"
      width={frameWidth}
      onClose={saving ? undefined : onClose}
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
          onCancel={onClose}
          isActive={!saving && (mode === 'create' ? createField === 'title' : editField === 'title')}
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
              onCancel={onClose}
              isActive={!saving && createField === 'query'}
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
              onCancel={onClose}
              multiline
              height={editorHeight}
              width={innerWidth - 4}
              isActive={!saving && (mode === 'create' ? createField === 'markdown' : editField === 'markdown')}
              placeholder={t(lang, `输入 Markdown 内容，按 Ctrl+S 保存${ell}`, `Write Markdown, press Ctrl+S to save${ell}`)}
              captureInput={false}
            />
          </Box>
        </Box>

        {error ? (
          <Box marginTop={1}>
            <Text color={theme.error}>{`${asciiMode ? '!' : '✕'} ${truncateDisplay(error, innerWidth, asciiMode ? '...' : '…')}`}</Text>
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
  );
});

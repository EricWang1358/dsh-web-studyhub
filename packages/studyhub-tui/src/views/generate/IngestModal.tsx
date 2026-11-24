import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';

export interface IngestModalProps {
  host: HostClient;
  defaultCourse?: string | null;
  defaultDeckId?: string | null;
  isActive: boolean;
  onClose: () => void;
  onDone?: () => Promise<void> | void;
}

type IngestTab = 'capture' | 'ingest';
type CaptureKind = 'flashcard' | 'open' | 'quiz';
type IngestKind = 'auto' | 'flashcard' | 'quiz' | 'multi' | 'open';
type MistakesMode = 'auto' | 'all' | 'none';
type CaptureField = 'question' | 'answer' | 'kind' | 'deck' | 'notes';
type IngestField = 'text' | 'kind' | 'mistakes' | 'deck' | 'title';

interface CaptureResult {
  status?: string;
  deckId?: string;
  deckTitle?: string;
  course?: string;
  topic?: string;
  cardId?: string;
  prompt?: string;
  kind?: string;
  newDeck?: boolean;
}

interface IngestAddedItem {
  cardId?: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  mistake?: boolean;
  answerInferred?: boolean;
}

interface IngestSkippedItem {
  prompt?: string;
  reason?: string;
}

interface IngestDuplicateItem {
  prompt?: string;
  deckTitle?: string;
  topic?: string;
}

interface IngestResult {
  deckId?: string | null;
  deckTitle?: string;
  course?: string;
  newDeck?: boolean;
  added?: IngestAddedItem[];
  duplicates?: IngestDuplicateItem[];
  skipped?: IngestSkippedItem[];
  ignored?: string[];
}

interface DeckChoice {
  id: string;
  title: string;
  course: string;
}

const CAPTURE_KINDS: ReadonlyArray<{ id: CaptureKind; zh: string; en: string }> = [
  { id: 'flashcard', zh: '闪卡', en: 'Flashcard' },
  { id: 'open', zh: '简答', en: 'Open' },
  { id: 'quiz', zh: '单选', en: 'Quiz' },
];

const INGEST_KINDS: ReadonlyArray<{ id: IngestKind; zh: string; en: string }> = [
  { id: 'auto', zh: '自动', en: 'Auto' },
  { id: 'flashcard', zh: '闪卡', en: 'Card' },
  { id: 'quiz', zh: '单选', en: 'Quiz' },
  { id: 'multi', zh: '多选', en: 'Multi' },
  { id: 'open', zh: '简答', en: 'Open' },
];

const MISTAKE_MODES: ReadonlyArray<{ id: MistakesMode; zh: string; en: string }> = [
  { id: 'auto', zh: '自动识别', en: 'Auto' },
  { id: 'all', zh: '全部错题', en: 'All' },
  { id: 'none', zh: '不标错题', en: 'None' },
];

const CAPTURE_FIELDS: readonly CaptureField[] = ['question', 'answer', 'kind', 'deck', 'notes'];
const INGEST_FIELDS: readonly IngestField[] = ['text', 'kind', 'mistakes', 'deck', 'title'];
const MAX_INGEST_CHARS = 60_000;

export const IngestModal = memo(function IngestModal({
  host,
  defaultCourse,
  defaultDeckId,
  isActive,
  onClose,
  onDone,
}: IngestModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows } = useWindowSize();

  const ell = asciiMode ? '...' : '…';
  const okMark = asciiMode ? '[OK]' : '✓';
  const warnMark = asciiMode ? '[!]' : '⚠';
  const errMark = asciiMode ? '[X]' : '✕';
  const arrowHint = asciiMode ? '<-/->' : '←/→';
  const promptGlyph = asciiMode ? '>' : '›';

  const ordinaryDecks = useMemo<DeckChoice[]>(() => {
    const raw = snapshot?.decks ?? [];
    const filtered = raw
      .filter((d) => !d.archived && !(d as Record<string, unknown>).systemKind)
      .map((d) => ({
        id: d.id,
        title: String(d.title || d.name || d.id),
        course: String(d.course || ''),
      }));
    if (defaultCourse) {
      filtered.sort((a, b) => {
        const am = a.course === defaultCourse ? 0 : 1;
        const bm = b.course === defaultCourse ? 0 : 1;
        return am - bm;
      });
    }
    return filtered;
  }, [snapshot?.decks, defaultCourse]);

  const initialDeckId = useMemo(() => {
    if (defaultDeckId && ordinaryDecks.some((d) => d.id === defaultDeckId)) {
      return defaultDeckId;
    }
    return '';
  }, [defaultDeckId, ordinaryDecks]);

  const deckOptions = useMemo<DeckChoice[]>(() => {
    const autoLabel = defaultCourse
      ? t(lang, `自动归类 (${defaultCourse})`, `Auto (${defaultCourse})`)
      : t(lang, '自动归类 / 新建题组', 'Auto / New Deck');
    return [{ id: '', title: autoLabel, course: defaultCourse || '' }, ...ordinaryDecks];
  }, [defaultCourse, lang, ordinaryDecks]);

  const [tab, setTab] = useState<IngestTab>('capture');

  // Tab 1: Quick Capture state
  const [captureField, setCaptureField] = useState<CaptureField>('question');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [notes, setNotes] = useState('');
  const [captureKind, setCaptureKind] = useState<CaptureKind>('flashcard');
  const [captureDeckId, setCaptureDeckId] = useState(initialDeckId);
  const [captureFeedback, setCaptureFeedback] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  // Tab 2: Bulk Ingest state
  const [ingestField, setIngestField] = useState<IngestField>('text');
  const [bulkText, setBulkText] = useState('');
  const [ingestKind, setIngestKind] = useState<IngestKind>('auto');
  const [ingestMistakes, setIngestMistakes] = useState<MistakesMode>('auto');
  const [ingestDeckId, setIngestDeckId] = useState(initialDeckId);
  const [ingestTitle, setIngestTitle] = useState('');
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isTypingField = useMemo(() => {
    if (tab === 'capture') {
      return captureField === 'question' || captureField === 'answer' || captureField === 'notes';
    }
    if (ingestResult) return false;
    return ingestField === 'text' || ingestField === 'title';
  }, [tab, captureField, ingestField, ingestResult]);

  const submitCapture = useCallback(async () => {
    if (savingRef.current) return;
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length < 2 || trimmedQuestion.length > 2000) {
      setError(t(lang, '题干长度需在 2 到 2000 个字符之间', 'Question must be 2–2000 characters'));
      return;
    }

    savingRef.current = true;
    setSubmitting(true);
    setError(null);
    setCaptureFeedback(null);

    try {
      const payload: Record<string, unknown> = {
        question: trimmedQuestion,
        kind: captureKind,
      };
      const trimmedAnswer = answer.trim();
      const trimmedNotes = notes.trim();
      if (trimmedAnswer) payload.answer = trimmedAnswer;
      if (trimmedNotes) payload.notes = trimmedNotes;
      if (captureDeckId) {
        payload.deckId = captureDeckId;
      } else if (defaultCourse) {
        payload.course = defaultCourse;
      }

      const res = await tryAction<CaptureResult>(host, 'capture', payload);
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '快速录题失败', 'Quick capture failed'));
        return;
      }

      const val = res.value;
      const deckName = val.deckTitle || t(lang, '默认题组', 'Deck');
      const topicLabel = val.topic ? ` · ${val.topic}` : '';
      const kindLabel = val.kind || captureKind;

      if (val.status === 'duplicate') {
        const msg = t(
          lang,
          `已存在相同题目：${deckName}${topicLabel}`,
          `Duplicate already in "${deckName}"${topicLabel}`,
        );
        setCaptureFeedback({ tone: 'warning', text: msg });
        notify(msg, 'warning');
        return;
      }

      const newTag = val.newDeck ? t(lang, '（新建题组）', ' (new deck)') : '';
      const msg = t(
        lang,
        `已录入「${deckName}」${newTag}${topicLabel} [${kindLabel}]`,
        `Added to "${deckName}"${newTag}${topicLabel} [${kindLabel}]`,
      );
      setCaptureFeedback({ tone: 'success', text: msg });
      notify(msg, 'success');
      setQuestion('');
      setAnswer('');
      setNotes('');
      setCaptureField('question');
      await onDone?.();
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [question, answer, notes, captureKind, captureDeckId, defaultCourse, host, lang, notify, onDone]);

  const submitIngest = useCallback(async () => {
    if (savingRef.current) return;
    const trimmedText = bulkText.trim();
    if (trimmedText.length < 8) {
      setError(t(lang, '请至少粘贴 8 个字符的题目文本', 'Paste at least 8 characters of question text'));
      return;
    }
    if (trimmedText.length > MAX_INGEST_CHARS) {
      setError(
        t(
          lang,
          `粘贴内容共 ${trimmedText.length} 字符，单次上限 ${MAX_INGEST_CHARS} 字符`,
          `Pasted text is ${trimmedText.length} chars; max ${MAX_INGEST_CHARS} per batch`,
        ),
      );
      return;
    }

    savingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = {
        text: trimmedText,
        kind: ingestKind,
        mistakes: ingestMistakes,
      };
      if (ingestDeckId) {
        payload.deckId = ingestDeckId;
      } else if (defaultCourse) {
        payload.course = defaultCourse;
      }
      const trimmedTitle = ingestTitle.trim();
      if (trimmedTitle) {
        payload.title = trimmedTitle;
        if (!ingestDeckId) payload.deckTitle = trimmedTitle;
      }

      const res = await tryAction<IngestResult>(host, 'ingest', payload);
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '批量录入失败', 'Bulk ingest failed'));
        return;
      }

      const result = res.value;
      setIngestResult(result);
      const addedCount = result.added?.length ?? 0;
      const dupCount = result.duplicates?.length ?? 0;
      const skipCount = result.skipped?.length ?? 0;
      const inferredCount = (result.added ?? []).filter((item) => item.answerInferred).length;

      if (addedCount > 0) {
        setBulkText('');
        await onDone?.();
      }

      const summaryMsg = t(
        lang,
        `整理完成：新增 ${addedCount} 题，重复 ${dupCount}，跳过 ${skipCount}${inferredCount > 0 ? `（${inferredCount} 题答案待核对）` : ''}`,
        `Ingest done: ${addedCount} added, ${dupCount} duplicate, ${skipCount} skipped${inferredCount > 0 ? ` (${inferredCount} inferred)` : ''}`,
      );
      notify(summaryMsg, addedCount > 0 ? 'success' : 'warning');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [bulkText, ingestKind, ingestMistakes, ingestDeckId, defaultCourse, ingestTitle, host, lang, notify, onDone]);

  const cycleDeck = useCallback(
    (currentId: string, dir: 1 | -1) => {
      const idx = Math.max(0, deckOptions.findIndex((d) => d.id === currentId));
      const next = deckOptions[(idx + dir + deckOptions.length) % deckOptions.length];
      return next?.id ?? '';
    },
    [deckOptions],
  );

  useInput(
    (input, key) => {
      if (submitting) return;

      // Switch tabs via Ctrl+Tab, Ctrl+T, or 1/2 when not typing in a TextInput
      if ((key.ctrl && key.tab) || (key.ctrl && input === 't')) {
        setTab((cur) => (cur === 'capture' ? 'ingest' : 'capture'));
        setError(null);
        return;
      }
      if (!isTypingField && input === '1') {
        setTab('capture');
        setError(null);
        return;
      }
      if (!isTypingField && input === '2') {
        setTab('ingest');
        setError(null);
        return;
      }

      if (tab === 'ingest' && ingestResult) {
        if (key.return || input === 'r' || input === 'R') {
          setIngestResult(null);
          setIngestField('text');
          setError(null);
        }
        return;
      }

      if (key.ctrl && input === 's') {
        if (tab === 'capture') {
          void submitCapture();
        } else if (ingestField !== 'text') {
          // Multiline TextInput invokes onSubmit -> submitIngest() on Ctrl+S
          void submitIngest();
        }
        return;
      }

      if (tab === 'capture') {
        const idx = CAPTURE_FIELDS.indexOf(captureField);
        if (key.tab) {
          const dir = key.shift ? -1 : 1;
          setCaptureField(CAPTURE_FIELDS[(idx + dir + CAPTURE_FIELDS.length) % CAPTURE_FIELDS.length]);
          return;
        }
        if (key.downArrow) {
          setCaptureField(CAPTURE_FIELDS[(idx + 1) % CAPTURE_FIELDS.length]);
          return;
        }
        if (key.upArrow) {
          setCaptureField(CAPTURE_FIELDS[(idx - 1 + CAPTURE_FIELDS.length) % CAPTURE_FIELDS.length]);
          return;
        }
        if (captureField === 'kind') {
          if (key.leftArrow || key.rightArrow || input === ' ' || input === 'h' || input === 'l') {
            const kIdx = CAPTURE_KINDS.findIndex((k) => k.id === captureKind);
            const dir = key.leftArrow || input === 'h' ? -1 : 1;
            setCaptureKind(CAPTURE_KINDS[(kIdx + dir + CAPTURE_KINDS.length) % CAPTURE_KINDS.length].id);
          } else if (key.return) {
            setCaptureField('deck');
          }
          return;
        }
        if (captureField === 'deck') {
          if (key.leftArrow || key.rightArrow || input === ' ' || input === 'h' || input === 'l') {
            const dir = key.leftArrow || input === 'h' ? -1 : 1;
            setCaptureDeckId((cur) => cycleDeck(cur, dir));
          } else if (key.return) {
            setCaptureField('notes');
          }
        }
        return;
      }

      // Tab 2: Bulk Ingest
      const idx = INGEST_FIELDS.indexOf(ingestField);
      if (key.tab) {
        const dir = key.shift ? -1 : 1;
        setIngestField(INGEST_FIELDS[(idx + dir + INGEST_FIELDS.length) % INGEST_FIELDS.length]);
        return;
      }
      if (ingestField !== 'text' && key.downArrow) {
        setIngestField(INGEST_FIELDS[(idx + 1) % INGEST_FIELDS.length]);
        return;
      }
      if (ingestField !== 'text' && key.upArrow) {
        setIngestField(INGEST_FIELDS[(idx - 1 + INGEST_FIELDS.length) % INGEST_FIELDS.length]);
        return;
      }
      if (ingestField === 'kind') {
        if (key.leftArrow || key.rightArrow || input === ' ' || input === 'h' || input === 'l') {
          const kIdx = INGEST_KINDS.findIndex((k) => k.id === ingestKind);
          const dir = key.leftArrow || input === 'h' ? -1 : 1;
          setIngestKind(INGEST_KINDS[(kIdx + dir + INGEST_KINDS.length) % INGEST_KINDS.length].id);
        } else if (key.return) {
          setIngestField('mistakes');
        }
        return;
      }
      if (ingestField === 'mistakes') {
        if (key.leftArrow || key.rightArrow || input === ' ' || input === 'h' || input === 'l') {
          const mIdx = MISTAKE_MODES.findIndex((m) => m.id === ingestMistakes);
          const dir = key.leftArrow || input === 'h' ? -1 : 1;
          setIngestMistakes(MISTAKE_MODES[(mIdx + dir + MISTAKE_MODES.length) % MISTAKE_MODES.length].id);
        } else if (key.return) {
          setIngestField('deck');
        }
        return;
      }
      if (ingestField === 'deck') {
        if (key.leftArrow || key.rightArrow || input === ' ' || input === 'h' || input === 'l') {
          const dir = key.leftArrow || input === 'h' ? -1 : 1;
          setIngestDeckId((cur) => cycleDeck(cur, dir));
        } else if (key.return) {
          setIngestField('title');
        }
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (tab === 'ingest' && ingestResult) {
      return [
        { key: 'Enter/r', label: t(lang, '继续录入', 'More') },
        { key: '1/2', label: t(lang, '切换页签', 'Tabs') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'Tab', label: t(lang, '下一栏位', 'Next') },
      { key: 'Ctrl+T', label: t(lang, '切页签', 'Tab') },
      { key: 'Ctrl+S', label: t(lang, '提交', 'Submit') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [lang, tab, ingestResult]);

  const frameWidth = Math.max(48, Math.min(76, columns - 4));
  const innerWidth = modalContentWidth(frameWidth);
  const inputWidth = modalContentWidth(frameWidth) - 4;
  const bulkHeight = Math.max(3, Math.min(8, rows - 21));

  const selectedCaptureDeck = deckOptions.find((d) => d.id === captureDeckId) ?? deckOptions[0];
  const selectedIngestDeck = deckOptions.find((d) => d.id === ingestDeckId) ?? deckOptions[0];

  const addedItems = ingestResult?.added ?? [];
  const dupItems = ingestResult?.duplicates ?? [];
  const skipItems = ingestResult?.skipped ?? [];
  const ignoredItems = ingestResult?.ignored ?? [];
  const inferredCount = addedItems.filter((item) => item.answerInferred).length;
  const mistakeCount = addedItems.filter((item) => item.mistake).length;
  const maxDetailLines = Math.max(2, Math.min(6, rows - 18));

  return (
    <Modal
      title={t(lang, '快速录题与批量整理', 'Quick Capture & Bulk Ingest')}
      icon={asciiMode ? '+' : '✦'}
      tone="primary"
      width={frameWidth}
      isActive={isActive}
      onClose={submitting ? undefined : onClose}
      hints={hints}
    >
      {/* 2-Tab Bar */}
      <Box flexDirection="row" alignItems="center">
        <Badge
          label={`[1] ${t(lang, '快速录入单题', 'Quick Capture')}`}
          tone={tab === 'capture' ? 'primary' : 'muted'}
          variant={tab === 'capture' ? 'solid' : 'outline'}
        />
        <Text> </Text>
        <Badge
          label={`[2] ${t(lang, '粘贴既有题', 'Bulk Ingest')}`}
          tone={tab === 'ingest' ? 'primary' : 'muted'}
          variant={tab === 'ingest' ? 'solid' : 'outline'}
        />
        <Box flexGrow={1} />
        {defaultCourse ? <Text color={theme.dim}>{truncateDisplay(defaultCourse, 18, ell)}</Text> : null}
      </Box>

      {tab === 'capture' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={captureField === 'question' ? theme.primary : theme.muted} bold={captureField === 'question'}>
            {t(lang, '题干 * (Question)', 'Question *')}
          </Text>
          <TextInput
            value={question}
            onChange={setQuestion}
            onSubmit={() => setCaptureField('answer')}
            onCancel={onClose}
            placeholder={t(lang, '输入一道题干或知识点提问…', 'Enter a question stem or concept prompt…')}
            width={inputWidth}
            isActive={isActive && !submitting && captureField === 'question'}
            prompt={promptGlyph}
            maxLength={2000}
            captureInput={false}
          />

          <Text color={captureField === 'answer' ? theme.primary : theme.muted} bold={captureField === 'answer'}>
            {t(lang, '参考答案 (可选)', 'Answer (optional)')}
          </Text>
          <TextInput
            value={answer}
            onChange={setAnswer}
            onSubmit={() => setCaptureField('kind')}
            onCancel={onClose}
            placeholder={t(lang, '留空将由模型结合课程资料自动补全答案', 'Leave blank to let the model derive answer')}
            width={inputWidth}
            isActive={isActive && !submitting && captureField === 'answer'}
            prompt={promptGlyph}
            maxLength={8000}
            captureInput={false}
          />

          <Box flexDirection="row" alignItems="center" marginTop={1}>
            <Text color={captureField === 'kind' ? theme.primary : theme.muted} bold={captureField === 'kind'}>
              {`${captureField === 'kind' ? promptGlyph : ' '} ${t(lang, '题型', 'Kind')} (${arrowHint}): `}
            </Text>
            {CAPTURE_KINDS.map((k) => (
              <Box key={k.id} marginRight={1}>
                <Badge
                  label={lang === 'en' ? k.en : k.zh}
                  tone={captureKind === k.id ? 'primary' : 'muted'}
                  variant={captureKind === k.id ? 'solid' : 'outline'}
                />
              </Box>
            ))}
          </Box>

          <Box flexDirection="row" alignItems="center">
            <Text color={captureField === 'deck' ? theme.primary : theme.muted} bold={captureField === 'deck'}>
              {`${captureField === 'deck' ? promptGlyph : ' '} ${t(lang, '目标题组', 'Deck')} (${arrowHint}): `}
            </Text>
            <Text color={captureField === 'deck' ? theme.text : theme.muted} bold={captureField === 'deck'}>
              {truncateDisplay(selectedCaptureDeck?.title || '', Math.max(14, innerWidth - 28), ell)}
            </Text>
          </Box>

          <Text color={captureField === 'notes' ? theme.primary : theme.muted} bold={captureField === 'notes'}>
            {t(lang, '备注 / 出处 (可选)', 'Notes / Context (optional)')}
          </Text>
          <TextInput
            value={notes}
            onChange={setNotes}
            onSubmit={() => void submitCapture()}
            onCancel={onClose}
            placeholder={t(lang, '可选：补充错因、章节或课堂提示', 'Optional context, chapter or hint')}
            width={inputWidth}
            isActive={isActive && !submitting && captureField === 'notes'}
            prompt={promptGlyph}
            maxLength={4000}
            captureInput={false}
          />

          {captureFeedback ? (
            <Box marginTop={1}>
              <Text color={captureFeedback.tone === 'success' ? theme.success : theme.warning}>
                {`${captureFeedback.tone === 'success' ? okMark : warnMark} ${truncateDisplay(captureFeedback.text, innerWidth, ell)}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : ingestResult ? (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" alignItems="center">
            <Text color={addedItems.length > 0 ? theme.success : theme.warning} bold>
              {`${addedItems.length > 0 ? okMark : warnMark} ${t(lang, '批量整理结果', 'Bulk Ingest Summary')}`}
            </Text>
            <Text> </Text>
            {ingestResult.deckTitle ? (
              <Badge
                label={`${truncateDisplay(ingestResult.deckTitle, 26, ell)}${ingestResult.newDeck ? (lang === 'en' ? ' (new)' : ' (新建)') : ''}`}
                tone="accent"
                variant="soft"
              />
            ) : null}
          </Box>

          <Box flexDirection="row" marginTop={1}>
            <Badge label={`${t(lang, '新增', 'Added')} ${addedItems.length}`} tone={addedItems.length > 0 ? 'success' : 'muted'} variant="soft" />
            <Text> </Text>
            <Badge label={`${t(lang, '重复', 'Dup')} ${dupItems.length}`} tone={dupItems.length > 0 ? 'warning' : 'muted'} variant="soft" />
            <Text> </Text>
            <Badge label={`${t(lang, '跳过', 'Skip')} ${skipItems.length}`} tone={skipItems.length > 0 ? 'error' : 'muted'} variant="soft" />
            {mistakeCount > 0 ? (
              <>
                <Text> </Text>
                <Badge label={`${t(lang, '错题', 'Mistake')} ${mistakeCount}`} tone="warning" variant="soft" />
              </>
            ) : null}
            {ignoredItems.length > 0 ? (
              <>
                <Text> </Text>
                <Badge label={`${t(lang, '忽略', 'Ignored')} ${ignoredItems.length}`} tone="muted" variant="soft" />
              </>
            ) : null}
          </Box>

          {inferredCount > 0 ? (
            <Box marginTop={1}>
              <Text color={theme.warning}>
                {`${warnMark} ${t(lang, `${inferredCount} 道题未含原答案，已由模型推断并标记待核对`, `${inferredCount} card(s) had no answer key; inferred & flagged for review`)}`}
              </Text>
            </Box>
          ) : null}

          {skipItems.length > 0 || addedItems.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {skipItems.slice(0, maxDetailLines).map((item, i) => (
                <Text key={`skip-${i}`} color={theme.error}>
                  {truncateDisplay(`${errMark} ${item.prompt || t(lang, '无效题目', 'Invalid')}: ${item.reason || ''}`, innerWidth, ell)}
                </Text>
              ))}
              {skipItems.length < maxDetailLines
                ? addedItems.slice(0, maxDetailLines - skipItems.length).map((item, i) => (
                    <Text key={`add-${i}`} color={theme.text}>
                      {truncateDisplay(
                        `${okMark} [${item.kind || 'card'}] ${item.prompt || item.topic || ''}${item.answerInferred ? ` (${t(lang, '推断答案', 'inferred')})` : ''}`,
                        innerWidth,
                        ell,
                      )}
                    </Text>
                  ))
                : null}
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text color={theme.muted}>
              {t(lang, '按 [Enter] 或 [r] 继续粘贴下一批，按 [Esc] 关闭', 'Press [Enter] or [r] to ingest another batch, [Esc] to close')}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={ingestField === 'text' ? theme.primary : theme.muted} bold={ingestField === 'text'}>
            {t(lang, '粘贴既有题目或试卷错题 * (支持多行粘贴)', 'Paste Existing Questions or Mistakes * (multiline paste)')}
          </Text>
          <Box
            borderStyle={asciiMode ? 'classic' : 'round'}
            borderColor={ingestField === 'text' ? theme.borderActive : theme.border}
            paddingX={1}
          >
            <TextInput
              value={bulkText}
              onChange={setBulkText}
              onSubmit={() => void submitIngest()}
              onCancel={onClose}
              placeholder={t(lang, '粘贴选择题、问答题或错题本记录，Ctrl+S 提交…', 'Paste questions or past-paper mistakes, Ctrl+S to ingest…')}
              multiline
              height={bulkHeight}
              width={inputWidth}
              isActive={isActive && !submitting && ingestField === 'text'}
              maxLength={MAX_INGEST_CHARS}
              captureInput={false}
            />
          </Box>

          <Box flexDirection="row" alignItems="center">
            <Text color={ingestField === 'kind' ? theme.primary : theme.muted} bold={ingestField === 'kind'}>
              {`${ingestField === 'kind' ? promptGlyph : ' '} ${t(lang, '题型', 'Kind')}: `}
            </Text>
            {INGEST_KINDS.map((k) => (
              <Box key={k.id} marginRight={1}>
                <Badge
                  label={lang === 'en' ? k.en : k.zh}
                  tone={ingestKind === k.id ? 'primary' : 'muted'}
                  variant={ingestKind === k.id ? 'solid' : 'outline'}
                />
              </Box>
            ))}
          </Box>

          <Box flexDirection="row" alignItems="center">
            <Text color={ingestField === 'mistakes' ? theme.primary : theme.muted} bold={ingestField === 'mistakes'}>
              {`${ingestField === 'mistakes' ? promptGlyph : ' '} ${t(lang, '错题', 'Mistakes')}: `}
            </Text>
            {MISTAKE_MODES.map((m) => (
              <Box key={m.id} marginRight={1}>
                <Badge
                  label={lang === 'en' ? m.en : m.zh}
                  tone={ingestMistakes === m.id ? 'accent' : 'muted'}
                  variant={ingestMistakes === m.id ? 'solid' : 'outline'}
                />
              </Box>
            ))}
          </Box>

          <Box flexDirection="row" alignItems="center">
            <Text color={ingestField === 'deck' ? theme.primary : theme.muted} bold={ingestField === 'deck'}>
              {`${ingestField === 'deck' ? promptGlyph : ' '} ${t(lang, '目标题组', 'Deck')} (${arrowHint}): `}
            </Text>
            <Text color={ingestField === 'deck' ? theme.text : theme.muted} bold={ingestField === 'deck'}>
              {truncateDisplay(selectedIngestDeck?.title || '', Math.max(14, innerWidth - 28), ell)}
            </Text>
          </Box>

          <Text color={ingestField === 'title' ? theme.primary : theme.muted} bold={ingestField === 'title'}>
            {t(lang, '目标题组 / 批次标题 (可选)', 'Target Deck / Batch Title (optional)')}
          </Text>
          <TextInput
            value={ingestTitle}
            onChange={setIngestTitle}
            onSubmit={() => void submitIngest()}
            onCancel={onClose}
            placeholder={t(lang, '留空自动命名，如：期中错题整理', 'Optional title, e.g. Midterm Mistakes')}
            width={inputWidth}
            isActive={isActive && !submitting && ingestField === 'title'}
            prompt={promptGlyph}
            maxLength={120}
            captureInput={false}
          />
        </Box>
      )}

      {error ? (
        <Box marginTop={1}>
          <Text color={theme.error} wrap="wrap">{`${errMark} ${error}`}</Text>
        </Box>
      ) : null}

      {!(tab === 'ingest' && ingestResult) ? (
        <Box marginTop={1} justifyContent="space-between" alignItems="center">
          {submitting ? (
            <Spinner
              label={
                tab === 'capture'
                  ? t(lang, '正在识别并归档题目…', 'Capturing and filing question…')
                  : t(lang, '正在解析并批量整理题目…', 'Parsing and ingesting questions…')
              }
            />
          ) : (
            <Text color={theme.muted}>
              {t(lang, 'Ctrl+S 提交 · Tab 切换栏位 · Esc 关闭', 'Ctrl+S submit · Tab next field · Esc close')}
            </Text>
          )}
          <Badge
            label={t(lang, '提交 Ctrl+S', 'Submit Ctrl+S')}
            tone={submitting ? 'muted' : 'primary'}
            variant="solid"
          />
        </Box>
      ) : null}
    </Modal>
  );
});

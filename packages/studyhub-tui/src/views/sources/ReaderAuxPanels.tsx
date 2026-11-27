import React from 'react';
import { Box, Text } from 'ink';
import type { UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { LAYOUT_BP, Prose, ScrollArea, computeProseLayout } from '../../layout/index.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { formatLongformProse, formatReadingTimeLabel } from '../../render/longform.js';
import {
  formatEstimateRange,
  resolveEstimateTokensText,
  type PageProjection,
  type PendingTranslateConfirm,
  type ReaderSubMode,
  type ReadingChapter,
  type TranslateMeta,
} from './reader-model.js';

export interface ReaderHeaderProps {
  width: number;
  lang: UiLanguage;
  asciiMode: boolean;
  mathUnicode: boolean;
  format: string;
  title: string;
  pageLabel: string;
  chaptersCount: number;
  readCount: number;
  currentChapter: ReadingChapter | null;
  currentChapterRead: boolean;
}

export function ReaderHeader({
  width,
  lang,
  asciiMode,
  mathUnicode,
  format,
  title,
  pageLabel,
  chaptersCount,
  readCount,
  currentChapter,
  currentChapterRead,
}: ReaderHeaderProps): React.ReactElement {
  const theme = useTheme();
  const progressPrefix = `${asciiMode ? 'OK' : '✓'} ${readCount}/${chaptersCount}`;
  const chapterStateTag = currentChapter
    ? currentChapterRead
      ? t(lang, '已读', 'Read')
      : t(lang, '未读', 'Unread')
    : '';
  const progressBadgeLabel =
    chapterStateTag && width >= LAYOUT_BP.NARROW ? `${progressPrefix} (${chapterStateTag})` : progressPrefix;

  return (
    <Box height={1} width={width} paddingX={1}>
      <Badge label={format.toUpperCase()} tone="primary" />
      <Text> </Text>
      <Text bold color={theme.text} wrap="truncate-end">
        {title || t(lang, '资料阅读器', 'Document Reader')}
      </Text>
      <Box flexGrow={1} />
      {chaptersCount > 0 ? (
        <>
          <Badge
            label={progressBadgeLabel}
            tone={currentChapterRead ? 'success' : readCount === chaptersCount ? 'success' : 'muted'}
            variant="outline"
          />
          <Text> </Text>
        </>
      ) : null}
      <Badge
        label={mathUnicode ? (asciiMode ? 'Unicode' : '∑ Unicode') : 'TeX'}
        tone={mathUnicode ? 'success' : 'muted'}
        variant="outline"
      />
      <Text> </Text>
      <Badge label={pageLabel.trim()} tone="accent" variant="soft" />
    </Box>
  );
}

export interface ReaderMiniInputBarProps {
  subMode: ReaderSubMode;
  width: number;
  lang: UiLanguage;
  isActive: boolean;
  jumpInput: string;
  onChangeJump: (val: string) => void;
  onSubmitJump: (val: string) => void;
  searchInput: string;
  onChangeSearch: (val: string) => void;
  onSubmitSearch: (val: string) => void;
  askQuestion: string;
  onChangeAsk: (val: string) => void;
  onSubmitAsk: (val: string) => void;
  onCancel: () => void;
}

export function ReaderMiniInputBar({
  subMode,
  width,
  lang,
  isActive,
  jumpInput,
  onChangeJump,
  onSubmitJump,
  searchInput,
  onChangeSearch,
  onSubmitSearch,
  askQuestion,
  onChangeAsk,
  onSubmitAsk,
  onCancel,
}: ReaderMiniInputBarProps): React.ReactElement | null {
  const theme = useTheme();

  if (subMode === 'jump') {
    return (
      <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
        <Text color={theme.primary} bold>
          {t(lang, '跳转到页码: ', 'Go to page: ')}
        </Text>
        <TextInput
          value={jumpInput}
          onChange={onChangeJump}
          onSubmit={onSubmitJump}
          onCancel={onCancel}
          width={16}
          isActive={isActive}
        />
      </Box>
    );
  }

  if (subMode === 'search') {
    return (
      <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
        <Box flexShrink={0}>
          <Text color={theme.primary} bold>
            {t(lang, '文档内搜索: ', 'Search document: ')}
          </Text>
        </Box>
        <TextInput
          value={searchInput}
          onChange={onChangeSearch}
          onSubmit={onSubmitSearch}
          onCancel={onCancel}
          width={Math.max(16, width - 24)}
          isActive={isActive}
        />
      </Box>
    );
  }

  if (subMode === 'ask-input') {
    return (
      <Box height={2} width={width} paddingX={1} flexDirection="row" alignItems="center">
        <Box flexShrink={0}>
          <Text color={theme.ai} bold>
            {t(lang, '向 AI 提问本页: ', 'Ask AI about this page: ')}
          </Text>
        </Box>
        <TextInput
          value={askQuestion}
          onChange={onChangeAsk}
          onSubmit={onSubmitAsk}
          onCancel={onCancel}
          placeholder={t(lang, '例如：用通俗例子解释这一页的核心定理', 'e.g. Explain the main theorem on this page')}
          width={Math.max(20, width - 26)}
          isActive={isActive}
        />
      </Box>
    );
  }

  return null;
}

export interface ReaderPagePanelProps {
  pageLabel: string;
  activeSearch: string;
  searchHitsCount: number;
  pageData: PageProjection | null;
  loading: boolean;
  loadError: string | null;
  width: number;
  height: number;
  focused: boolean;
  isActive: boolean;
  lang: UiLanguage;
  asciiMode: boolean;
  mathUnicode: boolean;
  pageScrollTop: number;
  onScroll: (top: number) => void;
}

export function ReaderPagePanel({
  pageLabel,
  activeSearch,
  searchHitsCount,
  pageData,
  loading,
  loadError,
  width,
  height,
  focused,
  isActive,
  lang,
  asciiMode,
  mathUnicode,
  pageScrollTop,
  onScroll,
}: ReaderPagePanelProps): React.ReactElement {
  const compactMode = useTuiStore((s) => Boolean(s.preferences.compactMode));
  const availW = Math.max(12, width - 4);
  const innerH = Math.max(2, height - 2);
  const { proseWidth, marginLeft } = computeProseLayout(availW);
  const rawText = pageData?.text || t(lang, '（本页暂无可提取文字）', '(No extracted text on this page)');

  return (
    <Panel
      title={pageLabel.trim()}
      subtitle={
        activeSearch
          ? `${asciiMode ? '?' : '🔍'} ${activeSearch} (${searchHitsCount})`
          : pageData?.text
            ? formatReadingTimeLabel(pageData.text, lang)
            : undefined
      }
      width={width}
      height={height}
      focused={focused}
    >
      {loading ? (
        <Box padding={1}>
          <Spinner
            label={
              asciiMode
                ? t(lang, '正在读取页面内容...', 'Loading page...')
                : t(lang, '正在读取页面内容…', 'Loading page…')
            }
          />
        </Box>
      ) : loadError ? (
        <Box padding={1}>
          <Prose tone="error" ascii={asciiMode}>
            {loadError}
          </Prose>
        </Box>
      ) : pageData?.format === 'md' || pageData?.format === 'tex' ? (
        <Box width={availW} height={innerH} paddingLeft={marginLeft} overflow="hidden">
          <MarkdownView
            markdown={rawText}
            width={proseWidth}
            height={innerH}
            isActive={isActive}
            mathUnicode={mathUnicode}
            highlight={activeSearch || undefined}
            scrollTop={pageScrollTop}
            onScroll={onScroll}
          />
        </Box>
      ) : (
        <ScrollArea
          prose
          lines={formatLongformProse(rawText, Math.max(12, proseWidth - 1), {
            relaxed: !compactMode,
          })}
          width={availW}
          height={innerH}
          isActive={isActive}
          highlight={activeSearch || undefined}
          scrollTop={pageScrollTop}
          onScroll={onScroll}
        />
      )}
    </Panel>
  );
}

export interface ReaderAskPanelProps {
  width: number;
  height: number;
  lang: UiLanguage;
  asciiMode: boolean;
  mathUnicode: boolean;
  aiBusy: boolean;
  savingNote: boolean;
  savingCard: boolean;
  savedCard: boolean;
  askQuestion: string;
  aiAnswer: string;
  isActive: boolean;
}

export function ReaderAskPanel({
  width,
  height,
  lang,
  asciiMode,
  mathUnicode,
  aiBusy,
  savingNote,
  savingCard,
  savedCard,
  askQuestion,
  aiAnswer,
  isActive,
}: ReaderAskPanelProps): React.ReactElement {
  const theme = useTheme();
  const showActionsBar = !aiBusy && Boolean(aiAnswer.trim()) && Boolean(askQuestion.trim());
  const innerW = Math.max(12, width - 4);

  return (
    <Panel
      title={t(lang, 'AI 讲解', 'AI Answer')}
      icon={asciiMode ? '*' : '✦'}
      tone="ai"
      subtitle={
        aiBusy
          ? asciiMode
            ? t(lang, '生成中... Esc 中止', 'Streaming... Esc abort')
            : t(lang, '生成中… Esc 中止', 'Streaming… Esc abort')
          : savingNote || savingCard
            ? asciiMode
              ? t(lang, '保存中...', 'Saving...')
              : t(lang, '保存中…', 'Saving…')
            : 's/f/Esc'
      }
      width={width}
      height={height}
      focused
    >
      {showActionsBar ? (
        <Box height={1} width={innerW} flexShrink={0} overflow="hidden">
          <Text color={savedCard ? theme.success : theme.muted} wrap="truncate-end">
            {asciiMode
              ? `[s] ${t(lang, '存笔记', 'Save Note')}  [f] ${
                  savedCard ? t(lang, '已存闪卡', 'Card saved') : t(lang, '存为闪卡', 'Save card')
                }`
              : `[s] ${t(lang, '存笔记', 'Save Note')} · [f] ${
                  savedCard ? t(lang, '已存闪卡', 'Card saved') : t(lang, '存为闪卡', 'Save card')
                }`}
          </Text>
        </Box>
      ) : null}
      <MarkdownView
        markdown={
          aiAnswer ||
          (aiBusy ? (asciiMode ? t(lang, '_正在思考..._', '_Thinking..._') : t(lang, '_正在思考…_', '_Thinking…_')) : '')
        }
        width={innerW}
        height={Math.max(2, height - (showActionsBar ? 3 : 2))}
        isActive={isActive}
        mathUnicode={mathUnicode}
        follow={aiBusy}
      />
    </Panel>
  );
}

export interface ReaderTranslatePanelProps {
  width: number;
  height: number;
  lang: UiLanguage;
  asciiMode: boolean;
  mathUnicode: boolean;
  translateBusy: boolean;
  translateMeta: TranslateMeta | null;
  translationText: string;
  isActive: boolean;
}

export function ReaderTranslatePanel({
  width,
  height,
  lang,
  asciiMode,
  mathUnicode,
  translateBusy,
  translateMeta,
  translationText,
  isActive,
}: ReaderTranslatePanelProps): React.ReactElement {
  const innerW = Math.max(12, width - 4);
  const translatedTotal = translateMeta
    ? translateMeta.freshCount + translateMeta.cachedCount + translateMeta.reusedCount
    : 0;

  return (
    <Panel
      title={t(lang, '双语对照翻译', 'Bilingual Translation')}
      icon={lang === 'en' ? undefined : '译'}
      tone="info"
      subtitle={
        translateBusy
          ? asciiMode
            ? t(lang, '翻译中... Esc 中止', 'Translating... Esc abort')
            : t(lang, '翻译中… Esc 中止', 'Translating… Esc abort')
          : 'L/R/Esc'
      }
      width={width}
      height={height}
      focused
    >
      {!translateBusy && translateMeta ? (
        <Box height={1} width={innerW} flexShrink={0}>
          <Badge label={translateMeta.target === 'en' ? 'EN' : 'ZH'} tone="info" variant="outline" />
          <Text> </Text>
          {translateMeta.source === 'cache' && translateMeta.cachedCount > 0 ? (
            <Badge
              label={t(
                lang,
                `已缓存 ${translateMeta.cachedCount} 段`,
                `Cached ${translateMeta.cachedCount} passages`,
              )}
              tone="success"
              variant="soft"
            />
          ) : translatedTotal > 0 ? (
            <Badge
              label={t(lang, `已译 ${translatedTotal} 段`, `Translated ${translatedTotal} passages`)}
              tone="success"
              variant="soft"
            />
          ) : null}
          {translateMeta.outdatedCount > 0 ? (
            <>
              <Text> </Text>
              <Badge
                label={t(lang, `待更新 ${translateMeta.outdatedCount}`, `Outdated ${translateMeta.outdatedCount}`)}
                tone="warning"
                variant="outline"
              />
            </>
          ) : null}
        </Box>
      ) : null}
      {translateBusy ? (
        <Box padding={1}>
          <Spinner
            label={
              asciiMode
                ? t(lang, '正在翻译当前页...', 'Translating current page...')
                : t(lang, '正在翻译当前页…', 'Translating current page…')
            }
          />
        </Box>
      ) : (
        <MarkdownView
          markdown={translationText}
          width={innerW}
          height={Math.max(2, height - (translateMeta ? 3 : 2))}
          isActive={isActive}
          mathUnicode={mathUnicode}
        />
      )}
    </Panel>
  );
}

export function renderTranslateConfirmMessage(
  confirm: PendingTranslateConfirm,
  lang: 'zh' | 'en',
  theme: ReturnType<typeof useTheme>,
): React.ReactElement {
  const targetNameLabel =
    confirm.target === 'en'
      ? t(lang, '英文 (en)', 'English (en)')
      : t(lang, '中文 (zh)', 'Chinese (zh)');
  const { toTranslate, cached, reused } = confirm.counts;
  const estCalls = formatEstimateRange(confirm.estimate?.calls) || '1';
  const estTokens = resolveEstimateTokensText(confirm.estimate) || '-';
  const reusedParts: string[] = [];
  if (cached > 0) reusedParts.push(t(lang, `已缓存 ${cached}`, `cached ${cached}`));
  if (reused > 0) reusedParts.push(t(lang, `可复用 ${reused}`, `reused ${reused}`));
  const extraNote = reusedParts.length > 0 ? ` (${reusedParts.join(', ')})` : '';
  return (
    <Box flexDirection="column">
      <Text color={theme.text} wrap="wrap">
        {t(
          lang,
          `目标语言: ${targetNameLabel} | 待翻译 ${toTranslate} 段${extraNote}`,
          `Target: ${targetNameLabel} | ${toTranslate} passage(s) to translate${extraNote}`,
        )}
      </Text>
      <Text color={theme.muted} wrap="wrap">
        {t(
          lang,
          `预计调用: ~${estCalls} 次 | 预计用量: ~${estTokens} tokens`,
          `Est. calls: ~${estCalls} | Est. tokens: ~${estTokens}`,
        )}
      </Text>
      {!confirm.modelAvailable ? (
        <Text color={theme.warning} wrap="wrap">
          {t(
            lang,
            '提示: 当前未配置可用模型，执行可能失败。',
            'Note: No model configured; execution may fail.',
          )}
        </Text>
      ) : null}
      <Text color={theme.dim} wrap="wrap">
        {t(
          lang,
          '译文将自动保存至资料库，翻译中按 Esc 可中止。',
          'Translations auto-save to library; Esc aborts in-flight.',
        )}
      </Text>
    </Box>
  );
}

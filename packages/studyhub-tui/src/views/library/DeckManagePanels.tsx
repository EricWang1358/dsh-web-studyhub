import React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../state/store.js';
import { Badge, Divider, Spinner } from '../../components/Badge.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { formatLabel, type DocumentGroup } from '../sources/source-helpers.js';
import {
  kindLabel,
  supplementKindLabel,
  type ConvertDraft,
  type ConvertTargetKind,
  type DeckCardItem,
  type FullDeckDetail,
  type ModalMode,
  type SuppJobResult,
} from './deck-manage-model.js';

export interface DeckManageInputBarProps {
  mode: ModalMode;
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  theme: ThemeTokens;
  isActive: boolean;
  busy: boolean;
  innerW: number;
  searchQuery: string;
  onSearchChange: (val: string) => void;
  renameValue: string;
  onRenameChange: (val: string) => void;
  onRenameSubmit: (val: string) => void;
  folderValue: string;
  onFolderChange: (val: string) => void;
  onFolderSubmit: (val: string) => void;
  courseDraft: string;
  onCourseChange: (val: string) => void;
  onCourseSubmit: (val: string) => void;
  onCourseCancel: () => void;
  courseHints: string[];
  topicValue: string;
  onTopicChange: (val: string) => void;
  onTopicSubmit: (val: string) => void;
  selectedCount: number;
  onBackToBrowse: () => void;
}

export function DeckManageInputBar({
  mode,
  lang,
  asciiMode,
  ell,
  theme,
  isActive,
  busy,
  innerW,
  searchQuery,
  onSearchChange,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  folderValue,
  onFolderChange,
  onFolderSubmit,
  courseDraft,
  onCourseChange,
  onCourseSubmit,
  onCourseCancel,
  courseHints,
  topicValue,
  onTopicChange,
  onTopicSubmit,
  selectedCount,
  onBackToBrowse,
}: DeckManageInputBarProps) {
  const inputWidth = Math.max(12, innerW - 6);
  const borderStyle = asciiMode ? 'classic' : 'round';

  if (mode === 'search') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color={theme.accent}>{t(lang, '搜索题目 (题干 / 知识点 / 题型):', 'Filter cards:')}</Text>
        <Box borderStyle={borderStyle} borderColor={theme.borderActive} paddingX={1}>
          <TextInput
            value={searchQuery}
            onChange={onSearchChange}
            onSubmit={onBackToBrowse}
            onCancel={onBackToBrowse}
            isActive={isActive}
            width={inputWidth}
            placeholder={t(lang, `输入关键字${ell}`, `Type keyword${ell}`)}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'rename') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color={theme.accent}>{t(lang, '输入新题组标题（Enter 保存）:', 'New deck title (Enter to save):')}</Text>
        <Box borderStyle={borderStyle} borderColor={theme.borderActive} paddingX={1}>
          <TextInput
            value={renameValue}
            onChange={onRenameChange}
            onSubmit={onRenameSubmit}
            onCancel={onBackToBrowse}
            isActive={isActive && !busy}
            width={inputWidth}
            placeholder={t(lang, `输入题组名称${ell}`, `Deck title${ell}`)}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'folder') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color={theme.accent}>
          {t(lang, '设置题组目录 (留空清除目录，支持 A / B 层级):', 'Deck folder (leave empty to clear, supports A / B):')}
        </Text>
        <Box borderStyle={borderStyle} borderColor={theme.borderActive} paddingX={1}>
          <TextInput
            value={folderValue}
            onChange={onFolderChange}
            onSubmit={onFolderSubmit}
            onCancel={onBackToBrowse}
            isActive={isActive && !busy}
            width={inputWidth}
            placeholder={t(lang, `输入目录名称，如 高数 / 微积分${ell}`, `Folder name, e.g. CS / Algorithms${ell}`)}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'course') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color={theme.accent}>
          {truncateDisplay(
            t(lang, '修改题组所属课程 (输入目标课程名):', 'Reassign deck course (enter target course):'),
            innerW,
            ell,
          )}
        </Text>
        <Box borderStyle={borderStyle} borderColor={theme.borderActive} paddingX={1}>
          <TextInput
            value={courseDraft}
            onChange={onCourseChange}
            onSubmit={onCourseSubmit}
            onCancel={onCourseCancel}
            isActive={isActive && !busy}
            width={inputWidth}
            placeholder={t(lang, `输入课程名称，如 线性代数${ell}`, `Course name, e.g. Linear Algebra${ell}`)}
          />
        </Box>
        {courseHints.length > 0 ? (
          <Box height={1} overflow="hidden">
            <Text color={theme.dim}>
              {truncateDisplay(
                `${t(lang, '已有课程: ', 'Existing: ')}${courseHints.join(asciiMode ? ' | ' : ' · ')}`,
                innerW,
                ell,
              )}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (mode === 'topic') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color={theme.accent}>
          {t(lang, `批量修改主题标签 (${selectedCount} 题):`, `Batch retag topic (${selectedCount} selected):`)}
        </Text>
        <Box borderStyle={borderStyle} borderColor={theme.borderActive} paddingX={1}>
          <TextInput
            value={topicValue}
            onChange={onTopicChange}
            onSubmit={onTopicSubmit}
            onCancel={onBackToBrowse}
            isActive={isActive && !busy}
            width={inputWidth}
            placeholder={t(lang, `输入新主题标签${ell}`, `Enter new topic tag${ell}`)}
          />
        </Box>
      </Box>
    );
  }

  return null;
}

export interface DeckManageBrowseMetaStripProps {
  lang: 'zh' | 'en';
  ell: string;
  theme: ThemeTokens;
  innerW: number;
  selectedCount: number;
  isSlainDeck: boolean;
  hasSlainCard: boolean;
  deck: FullDeckDetail | null;
  selectedCard: DeckCardItem | null;
  searchQuery: string;
}

export function DeckManageBrowseMetaStrip({
  lang,
  ell,
  theme,
  innerW,
  selectedCount,
  isSlainDeck,
  hasSlainCard,
  deck,
  selectedCard,
  searchQuery,
}: DeckManageBrowseMetaStripProps) {
  return (
    <Box height={1} flexDirection="row" gap={1} flexShrink={0} overflow="hidden">
      {selectedCount > 0 ? (
        <>
          <Badge label={t(lang, `已选 ${selectedCount}`, `${selectedCount} sel`)} tone="primary" variant="soft" />
          <Text color={theme.dim}>
            {truncateDisplay(
              isSlainDeck
                ? t(lang, '[F]重点  [x]清空', '[F]Focus  [x]Clear')
                : deck?.systemKind
                  ? t(lang, '[F]重点  [S]暂停/恢复  [x]清空', '[F]Focus  [S]Suspend  [x]Clear')
                  : t(
                      lang,
                      '[F]重点  [S]暂停/恢复  [T]改主题  [L]前置  [X]斩题  [x]清空',
                      '[F]Focus  [S]Suspend  [T]Topic  [L]Link  [X]Slay  [x]Clear',
                    ),
              Math.max(10, innerW - 14),
              ell,
            )}
          </Text>
        </>
      ) : null}
      {selectedCount === 0 && (isSlainDeck || hasSlainCard) ? (
        selectedCard?.slain ? (
          <>
            <Badge
              label={`${t(lang, '斩题来源', 'Origin')}: ${truncateDisplay(
                selectedCard.slain.deckTitle || selectedCard.slain.deckId || t(lang, '原题组', 'Original'),
                Math.max(10, Math.floor(innerW * 0.45)),
                ell,
              )}`}
              tone="warning"
              variant="soft"
            />
            <Text color={theme.dim}>
              {truncateDisplay(t(lang, '[u] 恢复原题组', '[u] Restore to deck'), Math.max(10, innerW - 24), ell)}
            </Text>
          </>
        ) : (
          <Badge
            label={t(lang, '斩题组: 按 [u] 恢复到原题组', 'Slain Deck: Press [u] to restore')}
            tone="warning"
            variant="soft"
          />
        )
      ) : null}
      {selectedCount === 0 && !isSlainDeck && !hasSlainCard && deck?.folder ? (
        <Badge
          label={`${t(lang, '目录', 'Folder')}: ${truncateDisplay(deck.folder, Math.max(10, innerW - 16), ell)}`}
          tone="accent"
          variant="soft"
        />
      ) : null}
      {searchQuery ? (
        <>
          <Badge label={`${t(lang, '筛选', 'Filter')}: ${searchQuery}`} tone="info" variant="soft" />
          <Text color={theme.dim}>{t(lang, '([c] 清除)', '([c] clear)')}</Text>
        </>
      ) : null}
    </Box>
  );
}

export interface DeckManageSupplementPanelProps {
  deck: FullDeckDetail | null;
  deckId: string;
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  theme: ThemeTokens;
  bodyH: number;
  innerW: number;
  isActive: boolean;
  busy: boolean;
  suppJobResult: SuppJobResult | null;
  suppCount: number;
  suppKind: string;
  suppError: string;
  availableDocs: DocumentGroup[];
  suppSourceCursor: number;
  suppSelectedIds: Set<string>;
  onCursorChange: (idx: number) => void;
  onSubmit: () => void;
}

export function DeckManageSupplementPanel({
  deck,
  deckId,
  lang,
  asciiMode,
  ell,
  theme,
  bodyH,
  innerW,
  isActive,
  busy,
  suppJobResult,
  suppCount,
  suppKind,
  suppError,
  availableDocs,
  suppSourceCursor,
  suppSelectedIds,
  onCursorChange,
  onSubmit,
}: DeckManageSupplementPanelProps) {
  return (
    <Box flexDirection="column" height={bodyH} width={innerW} overflow="hidden">
      {suppJobResult ? (
        <Box flexDirection="column" paddingY={1} gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Badge label={asciiMode ? '+ QUEUED' : t(lang, '✓ 已入队', '✓ QUEUED')} tone="success" variant="solid" />
            <Text color={theme.text} bold>
              {`Job ID: ${suppJobResult.jobId}`}
            </Text>
          </Box>
          <Text color={theme.accent}>
            {t(
              lang,
              `目标题组：${deck?.title || deckId}${asciiMode ? '  |  ' : '  ·  '}题数：${suppJobResult.count}${asciiMode ? '  |  ' : '  ·  '}题型：${supplementKindLabel(suppJobResult.kind, lang)}`,
              `Target: ${deck?.title || deckId}${asciiMode ? '  |  ' : '  ·  '}Count: ${suppJobResult.count}${asciiMode ? '  |  ' : '  ·  '}Kind: ${supplementKindLabel(suppJobResult.kind, lang)}`,
            )}
          </Text>
          <Text color={theme.muted}>
            {t(
              lang,
              '后台补题任务已提交。按 [t] 或 [Enter] 前往「后台任务」监控进度，或按 [Esc] 返回题组列表。',
              'Supplement job queued. Press [t] or [Enter] to monitor in TasksView, or [Esc] to return.',
            )}
          </Text>
        </Box>
      ) : (
        <>
          <Box flexDirection="row" height={1} alignItems="center" gap={1}>
            <Text color={theme.accent} bold>{t(lang, '补题参数:', 'Options:')}</Text>
            <Badge label={`${t(lang, '题数', 'Count')}: ${suppCount}`} tone="primary" variant="soft" />
            <Badge
              label={`${t(lang, '题型', 'Kind')}: ${supplementKindLabel(suppKind, lang)}`}
              tone="accent"
              variant="soft"
            />
            <Box flexGrow={1} />
            {busy ? (
              <Spinner label={t(lang, `提交中${ell}`, `Queuing${ell}`)} active={isActive} />
            ) : (
              <Text color={theme.dim}>{t(lang, '[a] 全选  [Enter] 提交', '[a] All  [Enter] Submit')}</Text>
            )}
          </Box>
          <Box height={1}>
            <Text color={theme.dim}>
              {truncateDisplay(
                t(
                  lang,
                  '按 [Space] 勾选资料（同课程优先显示），[+/-] 调题数，[Tab/t] 切题型',
                  'Press [Space] to select sources (course-matched first), [+/-] count, [Tab/t] kind',
                ),
                innerW,
                ell,
              )}
            </Text>
          </Box>
          {suppError ? (
            <Box>
              <Text color={theme.error} wrap="wrap">{suppError}</Text>
            </Box>
          ) : null}
          <Divider width={innerW} />
          <VirtualList
            items={availableDocs}
            height={Math.max(3, bodyH - 3 - (suppError ? 1 : 0))}
            width={innerW}
            selectedIndex={suppSourceCursor}
            onChange={onCursorChange}
            onSelect={onSubmit}
            isActive={isActive && !suppJobResult && !busy}
            keyExtractor={(doc) => doc.key}
            emptyText={t(lang, '暂无可用资料', 'No active sources available')}
            emptyHint={t(lang, '请先在「资料」页导入或取消归档资料', 'Import or unarchive sources in Sources view')}
            renderItem={(doc, ctx) => {
              const pickedCount = doc.sourceIds.filter((id) => suppSelectedIds.has(id)).length;
              const mark =
                pickedCount === doc.sourceIds.length && doc.sourceIds.length > 0
                  ? asciiMode
                    ? '[x]'
                    : '[✓]'
                  : pickedCount > 0
                    ? '[~]'
                    : '[ ]';
              const matched = Boolean(deck?.course && doc.courses.includes(deck.course));
              const matchTag = matched ? (asciiMode ? ' *' : ' ★') : '';
              const fmt = `[${formatLabel(doc.format)}]`;
              const pages = `${doc.pageCount}p`;
              const titleBudget = Math.max(8, ctx.width - mark.length - fmt.length - pages.length - matchTag.length - 4);
              return (
                <Box flexDirection="row" width={ctx.width}>
                  <Text color={pickedCount > 0 ? theme.success : theme.muted}>{`${mark} `}</Text>
                  <Text color={theme.accent}>{`${fmt} `}</Text>
                  <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                    {truncateDisplay(doc.title, titleBudget, ell)}
                  </Text>
                  {matched ? <Text color={theme.warning}>{matchTag}</Text> : null}
                  <Box flexGrow={1} />
                  <Text color={theme.dim}>{pages}</Text>
                </Box>
              );
            }}
          />
        </>
      )}
    </Box>
  );
}

export interface DeckManageConvertPanelProps {
  selectedCard: DeckCardItem;
  availableConvertTargets: ConvertTargetKind[];
  convertKindIdx: number;
  convertTargetKind: ConvertTargetKind;
  convertDraft: ConvertDraft;
  convertEditActive: boolean;
  convertError: string;
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  theme: ThemeTokens;
  bodyH: number;
  innerW: number;
  isActive: boolean;
  busy: boolean;
  onPrimaryTextChange: (val: string) => void;
  onCloseEdit: () => void;
}

export function DeckManageConvertPanel({
  selectedCard,
  availableConvertTargets,
  convertKindIdx,
  convertTargetKind,
  convertDraft,
  convertEditActive,
  convertError,
  lang,
  asciiMode,
  ell,
  theme,
  bodyH,
  innerW,
  isActive,
  busy,
  onPrimaryTextChange,
  onCloseEdit,
}: DeckManageConvertPanelProps) {
  return (
    <Box flexDirection="column" height={bodyH} width={innerW} overflow="hidden">
      <Box flexDirection="row" height={1} alignItems="center" gap={1}>
        <Text color={theme.muted}>{t(lang, '原题型:', 'From:')}</Text>
        <Badge label={kindLabel(selectedCard.kind, lang)} tone="muted" variant="outline" />
        <Text color={theme.muted}>{asciiMode ? '->' : '→'}</Text>
        <Text color={theme.muted}>{t(lang, '目标:', 'To:')}</Text>
        {availableConvertTargets.map((k, idx) => (
          <Badge
            key={k}
            label={kindLabel(k, lang)}
            tone={idx === convertKindIdx ? 'primary' : 'muted'}
            variant={idx === convertKindIdx ? 'solid' : 'outline'}
          />
        ))}
      </Box>
      <Box height={1}>
        <Text color={theme.dim}>
          {truncateDisplay(
            `${t(lang, '题干:', 'Prompt:')} ${String(selectedCard.prompt || selectedCard.cloze?.text || '').replace(/\s+/g, ' ')}`,
            innerW,
            ell,
          )}
        </Text>
      </Box>
      <Divider width={innerW} />
      {convertTargetKind === 'truefalse' ? (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color={theme.accent} bold>{t(lang, '正确答案 ([Space] 切换):', 'Correct Answer ([Space] toggle):')}</Text>
            <Badge
              label={convertDraft.tfIsTrue ? t(lang, '对 (True)', 'True') : t(lang, '错 (False)', 'False')}
              tone={convertDraft.tfIsTrue ? 'success' : 'warning'}
              variant="solid"
            />
          </Box>
          <Text color={theme.muted}>
            {t(
              lang,
              '将自动生成标准 true/false 双选项并保留原题解析与复习记录引用。',
              'Generates standard true/false options automatically while preserving explanation and links.',
            )}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={0}>
          <Text color={convertEditActive ? theme.primary : theme.accent} bold>
            {convertTargetKind === 'open'
              ? t(lang, '评分标准 patch.rubric ([e] 编辑):', 'Scoring Rubric patch.rubric ([e] edit):')
              : convertTargetKind === 'flashcard'
                ? t(lang, '参考答案 patch.answer ([e] 编辑):', 'Flashcard Answer patch.answer ([e] edit):')
                : convertTargetKind === 'quiz'
                  ? t(lang, '正确选项文本 (自动补齐干扰项, [e] 编辑):', 'Correct Option Text (auto-fills distractors, [e] edit):')
                  : t(lang, '填空题干 patch.cloze.text (含 {{b1}} 标记, [e] 编辑):', 'Cloze Text patch.cloze.text (with {{b1}}, [e] edit):')}
          </Text>
          <Box
            borderStyle={asciiMode ? 'classic' : 'round'}
            borderColor={convertEditActive ? theme.borderActive : theme.border}
            paddingX={1}
          >
            <TextInput
              value={convertDraft.primaryText}
              onChange={onPrimaryTextChange}
              onSubmit={onCloseEdit}
              onCancel={onCloseEdit}
              isActive={isActive && convertEditActive && !busy}
              width={Math.max(12, innerW - 6)}
            />
          </Box>
          {convertTargetKind === 'cloze' ? (
            <Text color={theme.dim}>
              {truncateDisplay(
                `${t(lang, '填空答案 b1:', 'Blank b1 answer:')} ${convertDraft.secondaryText}`,
                innerW,
                ell,
              )}
            </Text>
          ) : null}
        </Box>
      )}
      {convertError ? (
        <Box marginTop={1}>
          <Text color={theme.error} wrap="wrap">{convertError}</Text>
        </Box>
      ) : null}
      {busy ? (
        <Box marginTop={1}>
          <Spinner label={t(lang, `正在转换题型${ell}`, `Converting card kind${ell}`)} active={isActive} />
        </Box>
      ) : null}
    </Box>
  );
}

export interface DeckManageLinkPanelProps {
  selectedCount: number;
  linkCandidates: DeckCardItem[];
  linkPrereqCursor: number;
  linkError: string;
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  theme: ThemeTokens;
  bodyH: number;
  innerW: number;
  isActive: boolean;
  busy: boolean;
  onCursorChange: (idx: number) => void;
  onSelectPrereq: (card: DeckCardItem) => void;
}

export function DeckManageLinkPanel({
  selectedCount,
  linkCandidates,
  linkPrereqCursor,
  linkError,
  lang,
  asciiMode,
  ell,
  theme,
  bodyH,
  innerW,
  isActive,
  busy,
  onCursorChange,
  onSelectPrereq,
}: DeckManageLinkPanelProps) {
  return (
    <Box flexDirection="column" height={bodyH} width={innerW} overflow="hidden">
      <Box flexDirection="row" height={1} alignItems="center" gap={1}>
        <Badge label={t(lang, `已选 ${selectedCount} 题`, `${selectedCount} selected`)} tone="primary" variant="soft" />
        <Text color={theme.accent} bold>
          {truncateDisplay(
            t(lang, '选择前置题目 (所选题将依赖它)', 'Pick prerequisite card (selected cards will require it)'),
            Math.max(10, innerW - (busy ? 28 : 16)),
            ell,
          )}
        </Text>
        <Box flexGrow={1} />
        {busy ? <Spinner label={t(lang, `关联中${ell}`, `Linking${ell}`)} active={isActive} /> : null}
      </Box>
      <Box height={1}>
        <Text color={theme.dim}>
          {truncateDisplay(
            t(lang, '使用 [j/k] 选择前置题，按 [Enter] 确认关联，[Esc] 取消', 'Use [j/k] to choose prerequisite, [Enter] to link, [Esc] to cancel'),
            innerW,
            ell,
          )}
        </Text>
      </Box>
      {linkError ? (
        <Box>
          <Text color={theme.error} wrap="wrap">{linkError}</Text>
        </Box>
      ) : null}
      <Divider width={innerW} />
      <VirtualList
        items={linkCandidates}
        height={Math.max(3, bodyH - 3 - (linkError ? 1 : 0))}
        width={innerW}
        selectedIndex={linkPrereqCursor}
        onChange={onCursorChange}
        onSelect={onSelectPrereq}
        isActive={isActive && !busy}
        keyExtractor={(c) => c.id}
        emptyText={t(lang, '没有可选的前置题目', 'No candidate prerequisite cards')}
        emptyHint={t(lang, '按 [Esc] 返回并保留至少 1 道未选题目作为前置', 'Press [Esc] to return and leave at least 1 unselected card as prerequisite')}
        renderItem={(card, ctx) => {
          const num = `${String(ctx.index + 1).padStart(2, ' ')}.`;
          const kind = `[${kindLabel(card.kind, lang)}]`;
          const foc = card.focus ? (asciiMode ? ' *' : ' ★') : '';
          const topic = card.topic ? `${truncateDisplay(card.topic, 14, ell)}${asciiMode ? ' - ' : ' · '}` : '';
          const prefix = `${num} ${kind} `;
          const avail = Math.max(6, ctx.width - displayWidth(prefix) - displayWidth(foc));
          const stem = `${topic}${String(card.prompt || card.cloze?.text || '').replace(/\s+/g, ' ')}`;
          const line = padDisplay(truncateDisplay(stem, avail, ell), avail);
          const fg = ctx.selected ? theme.selectionFg : theme.text;
          return (
            <Box flexDirection="row" width={ctx.width}>
              <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{num} </Text>
              <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{kind} </Text>
              <Text color={fg} bold={ctx.selected}>{line}</Text>
              {foc ? <Text color={ctx.selected ? theme.selectionFg : theme.primary}>{foc}</Text> : null}
            </Box>
          );
        }}
      />
    </Box>
  );
}

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pathToFileURL } from 'node:url';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  MarkdownView,
  Modal,
  Panel,
  Spinner,
  SplitPane,
  TextInput,
  VirtualList,
  modalContentWidth,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { cleanPathInput, errorMessage, tryAction } from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from './path-complete.js';

export interface CompanionsModalProps {
  host: HostClient;
  defaultCourse?: string | null;
  isActive: boolean;
  onChanged?: () => Promise<void> | void;
  onClose: () => void;
}

interface CompanionSummary {
  id: string;
  title: string;
  course: string;
  courseId?: string;
  mode?: string;
  lessonMode?: string;
  slideCount?: number;
  linkedPath?: string;
  workspacePath?: string;
  progress?: {
    slide?: number;
    slideTotal?: number;
    completed?: boolean;
    checksPassed?: number;
    checksTotal?: number;
  };
  updatedAt?: string;
}

interface CompanionDetail {
  companion: CompanionSummary & Record<string, unknown>;
  file?: string;
  changedOnDisk?: boolean;
  lesson?: {
    id?: string;
    title?: string;
    lead?: string;
    language?: string;
    template?: string;
    mode?: string;
    slideCount?: number;
    slides?: Array<{ title?: string; beat?: string }>;
    needs?: string[];
    after?: string[];
    terms?: Record<string, unknown>;
  } | null;
  relatedCards?: Array<{
    deckId?: string;
    deckTitle?: string;
    cardId?: string;
    kind?: string;
    topic?: string;
    prompt?: string;
    linkedToCompanion?: boolean;
    slide?: number;
    level?: string;
  }>;
}

type CompanionSubMode = 'browse' | 'attach' | 'ask' | 'ask-view';
type AttachField = 'path' | 'course';

function buildCompanionMarkdown(detail: CompanionDetail, lang: UiLanguage): string {
  const comp = detail.companion;
  const lesson = detail.lesson;
  const title = lesson?.title || comp.title || comp.id;
  const archetype = lesson?.template || 'interactive';
  const lessonMode = comp.lessonMode || lesson?.mode;
  const slides = Array.isArray(lesson?.slides) ? lesson.slides : [];
  const slideCount = lesson?.slideCount ?? comp.slideCount ?? slides.length;
  const related = Array.isArray(detail.relatedCards) ? detail.relatedCards : [];
  const linkedCards = related.filter((c) => c.linkedToCompanion);
  const shownCards = (linkedCards.length > 0 ? linkedCards : related).slice(0, 12);

  const lines: string[] = [`# ${title}`, ''];
  lines.push(`- **${t(lang, '所属课程', 'Course')}**: ${comp.course || '-'}`);
  lines.push(
    `- **${t(lang, '交互母版', 'Archetype')}**: \`${archetype}\`${lessonMode ? ` (${lessonMode})` : ''} · **${t(lang, '存储模式', 'Mode')}**: ${comp.mode || 'managed'}`,
  );
  lines.push(`- **${t(lang, '交互页数', 'Slides')}**: ${slideCount}`);

  if (comp.progress && typeof comp.progress.slide === 'number') {
    const prog = comp.progress;
    const checkStr =
      typeof prog.checksTotal === 'number' && prog.checksTotal > 0
        ? ` · ${t(lang, '检查点', 'Checks')}: ${prog.checksPassed ?? 0}/${prog.checksTotal}`
        : '';
    lines.push(
      `- **${t(lang, '学习进度', 'Progress')}**: ${prog.slide}/${prog.slideTotal ?? slideCount}${prog.completed ? ` ✓ ${t(lang, '已完成', 'Completed')}` : ''}${checkStr}`,
    );
  }

  const filePath = detail.file || comp.linkedPath || comp.workspacePath || '';
  if (filePath) {
    lines.push(`- **${t(lang, 'HTML 路径', 'HTML Path')}**: \`${filePath}\``);
  }
  if (detail.changedOnDisk) {
    lines.push(`- **${t(lang, '磁盘状态', 'Disk')}**: ${t(lang, '磁盘文件有更新', 'Updated on disk')}`);
  }

  if (lesson?.lead) {
    lines.push('', `## ${t(lang, '课程导读', 'Overview')}`, '', lesson.lead);
  }

  if (slides.length > 0) {
    lines.push('', `## ${t(lang, '页面与章节目录', 'Slides & Sections')}`, '');
    slides.forEach((sl, idx) => {
      const beat = sl.beat ? `[${sl.beat}] ` : '';
      lines.push(`${idx + 1}. ${beat}${sl.title || `Slide ${idx + 1}`}`);
    });
  }

  const needs = Array.isArray(lesson?.needs) ? lesson.needs.filter(Boolean) : [];
  if (needs.length > 0) {
    lines.push('', `## ${t(lang, '前置基础', 'Prerequisites')}`, '');
    for (const item of needs) lines.push(`- ${item}`);
  }

  const termKeys = lesson?.terms && typeof lesson.terms === 'object' ? Object.keys(lesson.terms) : [];
  if (termKeys.length > 0) {
    lines.push('', `## ${t(lang, '核心术语', 'Key Terms')}`, '', termKeys.slice(0, 20).map((k) => `\`${k}\``).join(' · '));
  }

  lines.push(
    '',
    `## ${t(lang, '关联题卡', 'Linked Cards')} (${linkedCards.length} ${t(lang, '直连', 'linked')} / ${related.length} ${t(lang, '课程相关', 'course')})`,
    '',
  );
  if (shownCards.length === 0) {
    lines.push(t(lang, '（暂无关联题卡）', '(No linked cards yet)'));
  } else {
    for (const card of shownCards) {
      const slideTag = card.slide ? `[Slide ${card.slide}] ` : '';
      const topicTag = card.topic ? `**${card.topic}** — ` : '';
      const lvl = card.level ? ` (${card.level})` : '';
      lines.push(`- ${slideTag}${topicTag}${String(card.prompt || '').replace(/\s+/g, ' ').slice(0, 100)}${lvl}`);
    }
  }

  return lines.join('\n');
}

export const CompanionsModal = memo(function CompanionsModal({
  host,
  defaultCourse,
  isActive,
  onChanged,
  onClose,
}: CompanionsModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useWindowSize();

  const [subMode, setSubMode] = useState<CompanionSubMode>('browse');
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [courseFilterOn, setCourseFilterOn] = useState(Boolean(defaultCourse));

  const [companions, setCompanions] = useState<CompanionSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Cache ONLY the currently inspected companion detail (cleared on unmount)
  const [detail, setDetail] = useState<CompanionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [pathNotice, setPathNotice] = useState<string | null>(null);

  // Ask AI state
  const [askInput, setAskInput] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Attach state
  const [attachField, setAttachField] = useState<AttachField>('path');
  const [attachPath, setAttachPath] = useState('');
  const [attachCourse, setAttachCourse] = useState(defaultCourse || '');
  const [attachMatches, setAttachMatches] = useState<string[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const cachedCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      abortInFlight();
      setDetail(null);
      setAskAnswer('');
    };
  }, [abortInFlight]);

  const loadList = useCallback(
    async (preferId?: string) => {
      setListLoading(true);
      setListErr(null);
      const targetCourse = courseFilterOn && defaultCourse ? defaultCourse : '*';
      const res = await tryAction<{ companions?: CompanionSummary[] }>(host, 'companion.list', {
        course: targetCourse,
      });
      setListLoading(false);
      if (!res.ok || !res.value) {
        setListErr(res.error?.message || t(lang, '读取伴学列表失败', 'Failed to list companions'));
        setCompanions([]);
        return;
      }
      const list = Array.isArray(res.value.companions) ? res.value.companions : [];
      setCompanions(list);
      if (preferId) {
        const idx = list.findIndex((c) => c.id === preferId);
        if (idx >= 0) setSelectedIndex(idx);
      }
    },
    [courseFilterOn, defaultCourse, host, lang],
  );

  useEffect(() => {
    if (!isActive) return;
    void loadList();
  }, [isActive, loadList]);

  useEffect(() => {
    if (selectedIndex >= companions.length) {
      setSelectedIndex(Math.max(0, companions.length - 1));
    }
  }, [companions.length, selectedIndex]);

  const selectedCompanion = companions[selectedIndex];

  useEffect(() => {
    setPathNotice(null);
    if (!isActive || !selectedCompanion) {
      setDetail(null);
      setDetailErr(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailErr(null);
    void tryAction<CompanionDetail>(host, 'companion.get', {
      id: selectedCompanion.id,
      ...(selectedCompanion.course ? { course: selectedCompanion.course } : {}),
    }).then((res) => {
      if (cancelled) return;
      setDetailLoading(false);
      if (res.ok && res.value) {
        setDetail(res.value);
      } else {
        setDetail(null);
        setDetailErr(res.error?.message || t(lang, '无法读取伴学页详情', 'Failed to load companion details'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [host, isActive, lang, selectedCompanion]);

  // Pre-fetch path completions for [i] Attach modal
  useEffect(() => {
    if (!isActive || subMode !== 'attach' || attachField !== 'path') return;
    let cancelled = false;
    const cleaned = cleanPathInput(attachPath);
    void completeFsPath(cleaned, { extensions: ['.html', '.htm', '.json'] }).then((res) => {
      if (cancelled) return;
      cachedCompletionRef.current = { input: attachPath, completed: res.completed };
      setAttachMatches(res.matches.slice(0, 6));
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, subMode, attachField, attachPath]);

  const handleAttachTabComplete = useCallback((val: string) => {
    const cached = cachedCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    const cleaned = cleanPathInput(val);
    void completeFsPath(cleaned, { extensions: ['.html', '.htm', '.json'] }).then((res) => {
      cachedCompletionRef.current = { input: res.completed, completed: res.completed };
      setAttachMatches(res.matches.slice(0, 6));
      if (res.completed && res.completed !== val) setAttachPath(res.completed);
    });
    return undefined;
  }, []);

  const submitAttach = useCallback(async () => {
    if (attachBusy) return;
    const expanded = expandHomePath(cleanPathInput(attachPath));
    if (!expanded) {
      setAttachErr(t(lang, '请输入 HTML 文件或伴学目录路径', 'Please enter a local HTML file or pack directory path'));
      return;
    }
    setAttachBusy(true);
    setAttachErr(null);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'companion.attach', {
        path: expanded,
        ...(attachCourse.trim() ? { course: attachCourse.trim() } : {}),
      });
      if (!res.ok || !res.value) {
        setAttachErr(res.error?.message || t(lang, '挂载伴学页失败', 'Failed to attach companion'));
        return;
      }
      const val = res.value;
      let createdId: string | undefined;
      if (val.kind === 'directory') {
        notify(
          t(
            lang,
            `已挂载目录：新增 ${Number(val.attached ?? 0)} 页，更新 ${Number(val.updated ?? 0)} 页`,
            `Attached pack: ${Number(val.attached ?? 0)} added, ${Number(val.updated ?? 0)} updated`,
          ),
          'success',
        );
      } else {
        const comp = val.companion as { id?: string; title?: string } | undefined;
        createdId = comp?.id;
        notify(
          t(lang, `已挂载伴学页：${comp?.title || expanded}`, `Attached companion: ${comp?.title || expanded}`),
          'success',
        );
      }
      await loadList(createdId);
      await onChanged?.();
      setAttachPath('');
      setSubMode('browse');
    } catch (error) {
      setAttachErr(errorMessage(error));
    } finally {
      setAttachBusy(false);
    }
  }, [attachBusy, attachCourse, attachPath, host, lang, loadList, notify, onChanged]);

  const runAsk = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !selectedCompanion) return;
      abortInFlight();
      const ac = new AbortController();
      abortRef.current = ac;
      setSubMode('ask-view');
      setAskBusy(true);
      setAskAnswer('');

      const compTitle = detail?.lesson?.title || selectedCompanion.title;
      const firstSlide = detail?.lesson?.slides?.[0];
      const summaryContext = detail ? buildCompanionMarkdown(detail, lang).slice(0, 8000) : compTitle;

      try {
        const res = await tryAction<{
          answerMarkdown?: string;
          suggestedCard?: { prompt?: string; answer?: string; misconception?: string } | null;
        }>(host, 'companion.ask', {
          id: selectedCompanion.id,
          ...(selectedCompanion.course ? { course: selectedCompanion.course } : {}),
          language: lang,
          question: q,
          context: {
            lessonTitle: compTitle,
            slide: 1,
            slideTitle: firstSlide?.title || compTitle,
            beat: firstSlide?.beat || '',
            codeSlice: summaryContext.slice(0, 1200),
          },
        });

        if (ac.signal.aborted) return;

        if (res.ok && res.value?.answerMarkdown) {
          let md = res.value.answerMarkdown;
          const card = res.value.suggestedCard;
          if (card && (card.prompt || card.answer)) {
            md += `\n\n---\n\n### ${t(lang, '建议防混闪卡', 'Suggested Anti-Misconception Card')}\n\n- **Q**: ${card.prompt || q}\n- **A**: ${card.answer || ''}${card.misconception ? `\n- **${t(lang, '易混点', 'Misconception')}**: ${card.misconception}` : ''}`;
          }
          setAskAnswer(md);
        } else if (typeof host.streamComplete === 'function') {
          let buf = '';
          const system = t(
            lang,
            '你是 StudyHub 交互伴学导师。请基于伴学课内容与结构简洁回答学习者的困惑，使用 Markdown 与 LaTeX 数学公式。',
            'You are the StudyHub Interactive Companion tutor. Answer the learner question concisely in Markdown using the companion context.',
          );
          const prompt = `Companion: ${compTitle}\n\n${summaryContext}\n\nLearner Question: ${q}`;
          const final = await host.streamComplete({
            system,
            prompt,
            signal: ac.signal,
            onChunk: (delta) => {
              if (ac.signal.aborted) return;
              buf += delta;
              setAskAnswer(buf);
            },
          });
          if (!ac.signal.aborted) setAskAnswer(final || buf);
        } else {
          setAskAnswer(`✕ ${res.error?.message || t(lang, 'AI 模型不可用，请先在设置中配置模型', 'AI model unavailable')}`);
        }
      } catch (error) {
        if (!ac.signal.aborted) {
          setAskAnswer(`✕ ${errorMessage(error)}`);
        }
      } finally {
        if (!ac.signal.aborted) setAskBusy(false);
      }
    },
    [abortInFlight, detail, host, lang, selectedCompanion],
  );

  const handleOpenExternal = useCallback(async () => {
    const rawPath = detail?.file || selectedCompanion?.linkedPath || selectedCompanion?.workspacePath || '';
    if (!rawPath) {
      notify(t(lang, '该伴学页暂无本地 HTML 路径', 'No HTML file path available for this companion'), 'warning');
      return;
    }
    let openTarget = rawPath;
    if (!/^https?:\/\//i.test(rawPath)) {
      try {
        openTarget = pathToFileURL(rawPath).href;
      } catch {
        openTarget = rawPath;
      }
    }
    const res = await tryAction(host, 'app.open', { url: openTarget, path: rawPath });
    if (res.ok) {
      notify(t(lang, `已请求外部打开: ${rawPath}`, `Opened externally: ${rawPath}`), 'success');
      setPathNotice(null);
    } else {
      setPathNotice(rawPath);
      notify(
        t(lang, `终端模式请用浏览器打开: ${rawPath}`, `Open HTML in browser: ${rawPath}`),
        'info',
      );
    }
  }, [detail?.file, host, lang, notify, selectedCompanion]);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (subMode === 'attach') {
        if (attachBusy) return;
        if (key.ctrl && input === 's') {
          void submitAttach();
          return;
        }
        if (key.downArrow || key.upArrow || (key.ctrl && (input === 'n' || input === 'p'))) {
          setAttachField((f) => (f === 'path' ? 'course' : 'path'));
        }
        return;
      }
      if (subMode !== 'browse') return;

      if (key.tab) {
        setActivePane((p) => (p === 'left' ? 'right' : 'left'));
      } else if (key.rightArrow && activePane === 'left') {
        setActivePane('right');
      } else if (key.leftArrow && activePane === 'right') {
        setActivePane('left');
      } else if (input === 'i') {
        setAttachErr(null);
        setSubMode('attach');
      } else if (input === 'f' && defaultCourse) {
        setCourseFilterOn((v) => !v);
      } else if (input === 'a' && selectedCompanion) {
        setAskInput('');
        setAskAnswer('');
        setSubMode('ask');
      } else if (input === 'o' && selectedCompanion) {
        void handleOpenExternal();
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (subMode === 'attach') {
      return [
        { key: 'Tab', label: t(lang, '补全路径', 'Complete') },
        { key: '↑/↓', label: t(lang, '切换字段', 'Field') },
        { key: 'Enter', label: t(lang, '挂载', 'Attach') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'ask') {
      return [
        { key: 'Enter', label: t(lang, '提问', 'Ask') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'ask-view') {
      return [
        { key: '↑/↓', label: t(lang, '滚动', 'Scroll') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    return [
      { key: 'Tab', label: t(lang, '切窗', 'Pane') },
      { key: 'a', label: t(lang, 'AI提问', 'Ask AI') },
      { key: 'i', label: t(lang, '挂载HTML', 'Attach') },
      { key: 'o', label: t(lang, '外部路径', 'Open') },
      ...(defaultCourse ? [{ key: 'f', label: t(lang, '课程范围', 'Course') }] : []),
    ];
  }, [defaultCourse, lang, subMode]);

  const frameWidth = Math.max(54, Math.min(104, columns - 4));
  const frameHeight = Math.max(16, Math.min(34, termRows - 2));
  const innerW = modalContentWidth(frameWidth);
  const innerH = Math.max(8, frameHeight - 4);
  const noticeH = pathNotice ? 2 : 0;
  const headerH = 1;
  const splitH = Math.max(6, innerH - headerH - noticeH);

  const detailMarkdown = useMemo(() => {
    if (!detail) return '';
    return buildCompanionMarkdown(detail, lang);
  }, [detail, lang]);

  return (
    <Modal
      title={t(lang, '交互伴学页 (Companions)', 'Interactive Companions')}
      subtitle={
        courseFilterOn && defaultCourse
          ? `${defaultCourse} (${companions.length})`
          : `${t(lang, '全部课程', 'All')} (${companions.length})`
      }
      icon="✦"
      width={frameWidth}
      height={frameHeight}
      isActive={isActive}
      onClose={
        subMode === 'browse'
          ? onClose
          : () => {
              abortInFlight();
              setAskBusy(false);
              setSubMode('browse');
            }
      }
      hints={hints}
    >
      {subMode === 'attach' ? (
        <Box flexDirection="column" height={innerH} width={innerW} paddingY={1}>
          <Text color={theme.primary} bold>
            {t(lang, '挂载本地伴学 HTML / 伴学目录 (companion.attach)', 'Attach Local Companion HTML / Pack')}
          </Text>
          <Box marginTop={1}>
            <Text color={attachField === 'path' ? theme.primary : theme.muted} bold={attachField === 'path'}>
              {t(lang, '文件或目录路径 (支持 ~, /, \\, C:\\... 及 Tab 补全):', 'HTML file or pack directory (supports ~, /, \\, C:\\...):')}
            </Text>
          </Box>
          <TextInput
            value={attachPath}
            onChange={setAttachPath}
            onTab={handleAttachTabComplete}
            onSubmit={() => void submitAttach()}
            onCancel={() => setSubMode('browse')}
            placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\lesson.html' : '~/companions/lesson.html'}
            width={Math.max(20, innerW - 4)}
            isActive={isActive && !attachBusy && subMode === 'attach' && attachField === 'path'}
            prompt="›"
          />
          {attachMatches.length > 0 && attachField === 'path' ? (
            <Box marginTop={0}>
              <Text color={theme.dim} wrap="truncate-end">
                {t(lang, 'Tab 候选:', 'Matches:')} {attachMatches.join('  ')}
              </Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text color={attachField === 'course' ? theme.primary : theme.muted} bold={attachField === 'course'}>
              {t(lang, '所属课程 (可选，留空自动识别):', 'Course (optional):')}
            </Text>
          </Box>
          <TextInput
            value={attachCourse}
            onChange={setAttachCourse}
            onSubmit={() => void submitAttach()}
            onCancel={() => setSubMode('browse')}
            placeholder={t(lang, '例如：操作系统', 'e.g. Operating Systems')}
            width={Math.max(20, innerW - 4)}
            isActive={isActive && !attachBusy && subMode === 'attach' && attachField === 'course'}
            prompt="›"
          />

          {attachBusy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, '正在挂载伴学页…', 'Attaching companion…')} />
            </Box>
          ) : null}
          {attachErr ? (
            <Box marginTop={1}>
              <Text color={theme.error}>{`✕ ${attachErr}`}</Text>
            </Box>
          ) : null}
        </Box>
      ) : subMode === 'ask' ? (
        <Box flexDirection="column" height={innerH} width={innerW} paddingY={1}>
          <Text color={theme.primary} bold>
            {t(lang, `向伴学导师提问：${selectedCompanion?.title || ''}`, `Ask about: ${selectedCompanion?.title || ''}`)}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={askInput}
              onChange={setAskInput}
              onSubmit={(val) => void runAsk(val)}
              onCancel={() => setSubMode('browse')}
              placeholder={t(lang, '输入你在该伴学页上卡壳的概念或公式…', 'Ask about any concept, slide or formula…')}
              width={Math.max(20, innerW - 4)}
              isActive={isActive && subMode === 'ask'}
              prompt="›"
            />
          </Box>
        </Box>
      ) : subMode === 'ask-view' ? (
        <Box flexDirection="column" height={innerH} width={innerW}>
          <Box height={1} flexDirection="row">
            <Badge label={t(lang, 'AI 伴学解答', 'Companion AI')} tone="ai" />
            <Text> </Text>
            <Text color={theme.muted} wrap="truncate-end">
              {truncateDisplay(askInput, Math.max(12, innerW - 18))}
            </Text>
            <Box flexGrow={1} />
            {askBusy ? <Spinner label={t(lang, '思考中', 'Thinking')} /> : null}
          </Box>
          <Box height={Math.max(4, innerH - 1)} width={innerW}>
            <MarkdownView
              markdown={askAnswer || (askBusy ? t(lang, '正在生成讲解…', 'Generating explanation…') : '')}
              width={innerW}
              height={Math.max(4, innerH - 1)}
              isActive={isActive && subMode === 'ask-view'}
              follow={askBusy}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" height={innerH} width={innerW}>
          <Box height={headerH} flexDirection="row" alignItems="center" width={innerW}>
            <Badge
              label={
                courseFilterOn && defaultCourse
                  ? truncateDisplay(defaultCourse, 22)
                  : t(lang, '全部课程', 'All Courses')
              }
              tone={courseFilterOn && defaultCourse ? 'accent' : 'muted'}
              variant="outline"
            />
            <Box flexGrow={1} />
            <Text color={theme.dim}>
              {activePane === 'left'
                ? t(lang, '列表焦点 · Tab切详情', 'List · Tab=Detail')
                : t(lang, '详情滚动 · Tab切列表', 'Detail · Tab=List')}
            </Text>
          </Box>

          {pathNotice ? (
            <Box height={noticeH} flexDirection="column" width={innerW}>
              <Text color={theme.warning} wrap="truncate-end">
                {t(lang, 'HTML 路径（请在浏览器中打开）:', 'HTML Path (open in browser):')}
              </Text>
              <Text color={theme.text} wrap="truncate-end">
                {pathNotice}
              </Text>
            </Box>
          ) : null}

          <Box height={splitH} width={innerW}>
            <SplitPane
              width={innerW}
              height={splitH}
              leftWidth={0.38}
              minLeft={20}
              minRight={28}
              activePane={activePane}
              leftLabel={t(lang, '伴学列表', 'Companions')}
              rightLabel={t(lang, '课程详情', 'Details')}
              left={({ width: lw, height: lh }) => (
                <Panel
                  title={t(lang, '伴学页', 'Companions')}
                  badge={companions.length}
                  width={lw}
                  height={lh}
                  focused={activePane === 'left'}
                >
                  {listLoading ? (
                    <Spinner label={t(lang, '加载中…', 'Loading…')} />
                  ) : listErr ? (
                    <Text color={theme.error}>{`✕ ${listErr}`}</Text>
                  ) : companions.length === 0 ? (
                    <EmptyState
                      title={t(lang, '暂无交互伴学页', 'No companions yet')}
                      hint={t(lang, '按 [i] 挂载本地 HTML / 伴学包', 'Press [i] to attach local HTML')}
                      width={Math.max(12, lw - 4)}
                      height={Math.max(4, lh - 2)}
                    />
                  ) : (
                    <VirtualList
                      items={companions}
                      height={Math.max(1, lh - 2)}
                      width={Math.max(12, lw - 4)}
                      selectedIndex={selectedIndex}
                      onChange={(idx) => setSelectedIndex(idx)}
                      onSelect={() => setActivePane('right')}
                      isActive={isActive && subMode === 'browse' && activePane === 'left'}
                      keyExtractor={(item) => item.id}
                      renderItem={(item, ctx) => {
                        const slidesTag = item.slideCount ? `${item.slideCount}p` : '';
                        const modeTag = item.lessonMode === 'rescue' ? '实验 ' : '';
                        const maxTitle = Math.max(8, ctx.width - slidesTag.length - modeTag.length - 5);
                        return (
                          <Box flexDirection="row" width={ctx.width}>
                            <Text color={ctx.selected ? theme.primary : theme.muted}>
                              {ctx.selected ? '▸ ' : '  '}
                            </Text>
                            {modeTag ? <Text color={theme.warning}>{modeTag}</Text> : null}
                            <Text color={theme.text} bold={ctx.selected}>
                              {truncateDisplay(item.title || item.id, maxTitle)}
                            </Text>
                            <Box flexGrow={1} />
                            {slidesTag ? <Text color={theme.dim}>{slidesTag}</Text> : null}
                          </Box>
                        );
                      }}
                    />
                  )}
                </Panel>
              )}
              right={({ width: rw, height: rh }) => (
                <Panel
                  title={selectedCompanion ? selectedCompanion.title : t(lang, '伴学详情', 'Details')}
                  subtitle={selectedCompanion?.course}
                  width={rw}
                  height={rh}
                  focused={activePane === 'right'}
                >
                  {!selectedCompanion ? (
                    <EmptyState
                      title={t(lang, '选择一份伴学页查看详情', 'Select a companion')}
                      width={Math.max(12, rw - 4)}
                      height={Math.max(4, rh - 2)}
                    />
                  ) : detailLoading ? (
                    <Spinner label={t(lang, '读取伴学结构…', 'Loading companion…')} />
                  ) : detailErr ? (
                    <Text color={theme.error}>{`✕ ${detailErr}`}</Text>
                  ) : (
                    <MarkdownView
                      markdown={detailMarkdown}
                      width={Math.max(12, rw - 4)}
                      height={Math.max(3, rh - 2)}
                      isActive={isActive && subMode === 'browse' && activePane === 'right'}
                    />
                  )}
                </Panel>
              )}
            />
          </Box>
        </Box>
      )}
    </Modal>
  );
});

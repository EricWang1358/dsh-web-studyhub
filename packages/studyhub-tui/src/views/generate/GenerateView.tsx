import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  Panel,
  Spinner,
  SplitPane,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useInputCapture,
  useTheme,
} from '../../components/index.js';
import { currentCourse, listCourses, modelInfo } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/sample-actions.js';
import { groupSourcesFromSnapshot, formatLabel } from '../sources/source-helpers.js';

const DraftEditor = lazy(() => import('./DraftEditor.js').then((m) => ({ default: m.DraftEditor })));
const IngestModal = lazy(() => import('./IngestModal.js').then((m) => ({ default: m.IngestModal })));

type SubTab = 'new' | 'drafts';
type GenOverlay = 'none' | 'scope' | 'focus' | 'ingest';

const QUESTION_KINDS: ReadonlyArray<{ id: string; zh: string; en: string }> = [
  { id: 'quiz', zh: '单选', en: 'Quiz' },
  { id: 'multi', zh: '多选', en: 'Multi' },
  { id: 'truefalse', zh: '判断', en: 'True/False' },
  { id: 'cloze', zh: '填空', en: 'Cloze' },
  { id: 'open', zh: '简答', en: 'Open' },
  { id: 'flashcard', zh: '闪卡', en: 'Flashcard' },
  { id: 'mixed', zh: '混合', en: 'Mixed' },
];

const TARGET_COUNTS = [5, 10, 15, 20] as const;

function parsePageScope(scopeText: string): Set<number> | null {
  const clean = scopeText.trim().toLowerCase();
  if (!clean || clean === 'all' || clean === '*') return null;
  const pages = new Set<number>();
  for (const part of clean.split(/[,，\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number.parseInt(range[1], 10);
      const b = Number.parseInt(range[2], 10);
      const lo = Math.min(a, b);
      const hi = Math.min(Math.max(a, b), lo + 500);
      for (let p = lo; p <= hi; p += 1) pages.add(p);
    } else if (/^\d+$/.test(part)) {
      pages.add(Number.parseInt(part, 10));
    }
  }
  return pages.size > 0 ? pages : null;
}

export const GenerateView: React.FC<ViewProps> = memo(function GenerateView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const snapshot = useTuiStore((s) => s.snapshot);
  const binding = useTuiStore((s) => s.binding);
  const desktopConfig = useTuiStore((s) => s.desktopConfig);
  const navContext = useTuiStore((s) => s.navContext);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const inputCaptured = useTuiStore((s) => s.inputCaptured);
  const { refresh } = useShellActions();

  const [tab, setTab] = useState<SubTab>(navContext.draftId ? 'drafts' : 'new');

  useEffect(() => {
    if (navContext.draftId) setTab('drafts');
  }, [navContext.draftId]);

  const model = useMemo(
    () => modelInfo(desktopConfig, binding, snapshot),
    [desktopConfig, binding, snapshot],
  );

  const courses = useMemo(() => listCourses(snapshot), [snapshot]);
  const allDocs = useMemo(() => groupSourcesFromSnapshot(snapshot), [snapshot]);

  const [courseName, setCourseName] = useState<string>(
    navContext.course || currentCourse(snapshot) || '',
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(
    () => new Set(navContext.sourceIds ?? []),
  );
  const [pageScope, setPageScope] = useState('all');
  const [kindIndex, setKindIndex] = useState(0);
  const [countIndex, setCountIndex] = useState(1); // default 10
  const [focusText, setFocusText] = useState('');
  const [sourceCursor, setSourceCursor] = useState(0);
  const [overlay, setOverlay] = useState<GenOverlay>('none');
  const [submitting, setSubmitting] = useState(false);

  // Sync incoming navContext.sourceIds / navContext.course
  useEffect(() => {
    if (navContext.sourceIds && navContext.sourceIds.length > 0) {
      setSelectedSourceIds(new Set(navContext.sourceIds));
      setTab('new');
    }
    if (navContext.course !== undefined && navContext.course !== null) {
      setCourseName(navContext.course);
    }
  }, [navContext.sourceIds, navContext.course]);

  const visibleDocs = useMemo(() => {
    if (!courseName) return allDocs;
    const filtered = allDocs.filter((d) => d.courses.includes(courseName));
    return filtered.length > 0 ? filtered : allDocs;
  }, [allDocs, courseName]);

  // Resolve final sourceIds with page scope applied
  const effectiveSourceIds = useMemo(() => {
    const scopeSet = parsePageScope(pageScope);
    if (!scopeSet) return [...selectedSourceIds];
    const out: string[] = [];
    for (const doc of allDocs) {
      const hasDocSelected = doc.sourceIds.some((id) => selectedSourceIds.has(id));
      if (!hasDocSelected) continue;
      for (const p of doc.pages) {
        if (selectedSourceIds.has(p.sourceId) && scopeSet.has(p.page)) {
          out.push(p.sourceId);
        }
      }
    }
    return out.length > 0 ? out : [...selectedSourceIds];
  }, [allDocs, pageScope, selectedSourceIds]);

  const selectedKind = QUESTION_KINDS[kindIndex] ?? QUESTION_KINDS[0];
  const targetCount = TARGET_COUNTS[countIndex] ?? 10;

  // Live cost/token estimate (debounced)
  const [estimate, setEstimate] = useState<{
    loading: boolean;
    tokensLow?: number;
    tokensHigh?: number;
    calls?: number;
    note?: string;
  }>({ loading: false });

  useEffect(() => {
    if (!isActive || tab !== 'new' || effectiveSourceIds.length === 0) {
      setEstimate({ loading: false });
      return;
    }
    let cancelled = false;
    setEstimate((prev) => ({ ...prev, loading: true }));
    const timer = setTimeout(() => {
      void (async () => {
        const req = {
          sourceIds: effectiveSourceIds,
          count: targetCount,
          kind: selectedKind.id,
          ...(courseName ? { course: courseName } : {}),
          ...(focusText.trim() ? { focus: focusText.trim() } : {}),
        };
        let res = await tryAction<Record<string, unknown>>(host, 'generate.preview', req);
        if (!res.ok) {
          res = await tryAction<Record<string, unknown>>(host, 'usage.estimate', {
            feature: 'generate',
            ...req,
          });
        }
        if (cancelled) return;
        if (res.ok && res.value) {
          const val = res.value;
          const totalTokens = (val.totalTokens || (val.estimate as Record<string, unknown>)?.totalTokens) as
            | { low?: number; high?: number }
            | undefined;
          const callsObj = (val.calls || (val.estimate as Record<string, unknown>)?.calls) as
            | { low?: number; high?: number }
            | number
            | undefined;
          const callsCount =
            typeof callsObj === 'number'
              ? callsObj
              : typeof callsObj === 'object' && callsObj
                ? callsObj.high ?? callsObj.low
                : undefined;
          setEstimate({
            loading: false,
            tokensLow: totalTokens?.low,
            tokensHigh: totalTokens?.high,
            calls: callsCount,
          });
        } else {
          setEstimate({ loading: false, note: res.error?.message });
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [host, isActive, tab, effectiveSourceIds, targetCount, selectedKind.id, courseName, focusText]);

  const handleSubmitGeneration = useCallback(async () => {
    if (submitting) return;
    if (!model.ready) {
      notify(t(lang, '模型未就绪，请先按 [S] 配置模型', 'Model not ready — press [S] to open Settings'), 'warning');
      return;
    }
    if (effectiveSourceIds.length === 0) {
      notify(t(lang, '请至少选择一份资料 (空格键勾选)', 'Select at least one material (Space)'), 'warning');
      return;
    }
    setSubmitting(true);
    const res = await tryAction<{ jobId?: string; id?: string }>(host, 'generate', {
      sourceIds: effectiveSourceIds,
      count: targetCount,
      kind: selectedKind.id,
      ...(courseName ? { course: courseName } : {}),
      ...(focusText.trim() ? { focus: focusText.trim() } : {}),
    });
    setSubmitting(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '提交出题任务失败', 'Failed to start generation'), 'error');
      return;
    }
    await refresh();
    const jobId = res.value?.jobId || res.value?.id;
    notify(t(lang, '后台出题任务已启动，正在跳转任务监控…', 'Generation job started — opening Tasks…'), 'success');
    navigate('tasks', jobId ? { jobId } : {});
  }, [
    submitting,
    model.ready,
    effectiveSourceIds,
    host,
    targetCount,
    selectedKind.id,
    courseName,
    focusText,
    refresh,
    notify,
    lang,
    navigate,
  ]);

  const wizardActive = isActive && tab === 'new' && overlay === 'none' && !inputCaptured;

  useClaimKeys(['c', 'k', 'n', 'p', 'f', 'S', 'a', 'g', 'i'], wizardActive);
  useInputCapture(isActive && tab === 'new' && (overlay === 'scope' || overlay === 'focus'));

  const wizardHints: KeyHint[] = useMemo(
    () => [
      { key: 'Tab', label: t(lang, '切到草稿箱', 'Drafts') },
      { key: 'Space', label: t(lang, '勾选资料', 'Toggle Src') },
      { key: 'i', label: t(lang, '录题', 'Capture') },
      { key: 'c', label: t(lang, '换课程', 'Course') },
      { key: 'k', label: t(lang, '题型', 'Kind') },
      { key: 'n', label: t(lang, '题数', 'Count') },
      { key: 'p', label: t(lang, '页码范围', 'Pages') },
      { key: 'f', label: t(lang, '出题要求', 'Focus') },
      { key: 'Ctrl+S', label: t(lang, '开始出题', 'Generate') },
    ],
    [lang],
  );
  useFooterHints(wizardHints, isActive && tab === 'new');

  useInput(
    (input, key) => {
      if (!isActive || overlay !== 'none' || inputCaptured) return;
      if (key.tab) {
        setTab((cur) => (cur === 'new' ? 'drafts' : 'new'));
        return;
      }
      if (tab !== 'new') return;

      if (input === 'i' && !key.ctrl && !key.meta) {
        setOverlay('ingest');
        return;
      }

      if (key.ctrl && input === 's') {
        void handleSubmitGeneration();
        return;
      }
      if (input === 'S' && !model.ready) {
        navigate('settings', { mode: 'model' });
        return;
      }
      if (input === 'c') {
        const names = ['', ...courses.map((c) => c.key)];
        const idx = names.indexOf(courseName);
        setCourseName(names[(idx + 1) % names.length]);
      } else if (input === 'k') {
        setKindIndex((i) => (i + 1) % QUESTION_KINDS.length);
      } else if (input === 'n') {
        setCountIndex((i) => (i + 1) % TARGET_COUNTS.length);
      } else if (input === 'p') {
        setOverlay('scope');
      } else if (input === 'f') {
        setOverlay('focus');
      } else if (input === 'a') {
        if (selectedSourceIds.size > 0) {
          setSelectedSourceIds(new Set());
        } else {
          setSelectedSourceIds(new Set(visibleDocs.flatMap((d) => d.sourceIds)));
        }
      } else if (input === ' ') {
        const doc = visibleDocs[sourceCursor];
        if (doc) {
          setSelectedSourceIds((prev) => {
            const next = new Set(prev);
            const allPicked = doc.sourceIds.every((id) => next.has(id));
            for (const id of doc.sourceIds) {
              if (allPicked) next.delete(id);
              else next.add(id);
            }
            return next;
          });
        }
      }
    },
    { isActive },
  );

  const tabBarH = 2;
  const bodyH = Math.max(4, height - tabBarH);
  const draftCount = snapshot?.drafts?.length ?? 0;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Sub-tab Header */}
      <Box height={tabBarH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center">
          <Badge
            label={`✦ ${t(lang, '新建出题任务', 'New Generation')}`}
            tone={tab === 'new' ? 'primary' : 'muted'}
            variant={tab === 'new' ? 'solid' : 'outline'}
          />
          <Text> </Text>
          <Badge
            label={`▤ ${t(lang, '草稿箱', 'Drafts')} (${draftCount})`}
            tone={tab === 'drafts' ? 'primary' : 'muted'}
            variant={tab === 'drafts' ? 'solid' : 'outline'}
          />
          <Text color={theme.dim}>  [Tab]</Text>
          <Box flexGrow={1} />
          <Badge
            label={`${model.icon} ${model.provider}${model.model ? ` · ${model.model}` : ''}`}
            tone={model.ready ? 'success' : 'warning'}
            variant="soft"
          />
          {!model.ready ? (
            <Text color={theme.warning}>{t(lang, ' [S] 去设置', ' [S] Settings')}</Text>
          ) : null}
        </Box>
        {!model.ready && tab === 'new' ? (
          <Text color={theme.warning}>
            {`⚠ ${t(lang, '模型尚未就绪', 'Model not ready')}${model.reason ? `: ${model.reason}` : ''} — ${t(lang, '按 [S] 打开模型设置', 'Press [S] to configure')}`}
          </Text>
        ) : (
          <Text color={theme.dim}>
            {truncateDisplay(
              tab === 'new'
                ? t(lang, '勾选资料后 [Enter]/[Ctrl+S] 出题 · [i] 录题', 'Select sources + [Enter]/[Ctrl+S] to generate · [i] Capture')
                : t(lang, '审核、修改或发布生成的题目草稿', 'Review, edit or publish generated drafts'),
              Math.max(12, width - 2),
            )}
          </Text>
        )}
      </Box>

      {/* Body */}
      <Box height={bodyH} width={width}>
        {tab === 'drafts' ? (
          <Suspense
            fallback={
              <Box paddingX={1} paddingY={1}>
                <Spinner label={t(lang, '正在载入草稿编辑器…', 'Loading draft editor…')} active={isActive} />
              </Box>
            }
          >
            <DraftEditor
              host={host}
              initialDraftId={navContext.draftId}
              width={width}
              height={bodyH}
              isActive={isActive && tab === 'drafts' && overlay === 'none'}
            />
          </Suspense>
        ) : (
          <SplitPane
            width={width}
            height={bodyH}
            leftWidth={0.5}
            leftLabel={t(lang, '选择资料', 'Sources')}
            rightLabel={t(lang, '出题参数 & 费用预估', 'Options & Estimate')}
            left={({ width: lw, height: lh }) => (
              <Panel
                title={t(lang, '1. 选择资料 (Space 勾选)', '1. Select Materials (Space)')}
                badge={`${effectiveSourceIds.length}p`}
                width={lw}
                height={lh}
                focused={wizardActive}
              >
                {visibleDocs.length === 0 ? (
                  <EmptyState
                    title={t(lang, '暂无可用资料', 'No materials')}
                    hint={t(lang, '请先前往「资料」页导入讲义或笔记', 'Import materials in Sources view first')}
                    width={Math.max(12, lw - 4)}
                    height={Math.max(4, lh - 2)}
                  />
                ) : (
                  <VirtualList
                    items={visibleDocs}
                    height={Math.max(1, lh - 2)}
                    width={Math.max(12, lw - 4)}
                    selectedIndex={sourceCursor}
                    onChange={(idx) => setSourceCursor(idx)}
                    onSelect={() => void handleSubmitGeneration()}
                    isActive={wizardActive}
                    keyExtractor={(d) => d.key}
                    renderItem={(doc, ctx) => {
                      const pickedCount = doc.sourceIds.filter((id) => selectedSourceIds.has(id)).length;
                      const check = pickedCount === doc.sourceIds.length ? '☑' : pickedCount > 0 ? '◐' : '☐';
                      const fmt = formatLabel(doc.format);
                      const meta = `${doc.pageCount}p`;
                      const titleMax = Math.max(8, ctx.width - fmt.length - meta.length - 8);
                      return (
                        <Box flexDirection="row" width={ctx.width}>
                          <Text color={pickedCount > 0 ? theme.success : theme.muted}>{`${check} `}</Text>
                          <Text color={theme.accent}>{`[${fmt}] `}</Text>
                          <Text color={theme.text} bold={ctx.selected}>
                            {truncateDisplay(doc.title, titleMax)}
                          </Text>
                          <Box flexGrow={1} />
                          <Text color={theme.dim}>{meta}</Text>
                        </Box>
                      );
                    }}
                  />
                )}
              </Panel>
            )}
            right={({ width: rw, height: rh }) => (
              <Panel
                title={t(lang, '2. 出题设置与预估', '2. Generation Settings')}
                width={rw}
                height={rh}
              >
                <Box flexDirection="column" width={Math.max(14, rw - 4)}>
                  <Text color={theme.muted}>
                    {t(lang, '[c] 课程归属: ', '[c] Course: ')}
                    <Text color={theme.text} bold>
                      {courseName || t(lang, '自动 / 全部', 'Auto / All')}
                    </Text>
                  </Text>

                  <Text color={theme.muted}>
                    {t(lang, '[p] 页码范围: ', '[p] Page Scope: ')}
                    <Text color={theme.text} bold>
                      {pageScope}
                    </Text>
                  </Text>

                  <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
                    <Text color={theme.muted}>{t(lang, '[k] 题型: ', '[k] Kind: ')}</Text>
                    <Badge
                      label={lang === 'en' ? selectedKind.en : selectedKind.zh}
                      tone="primary"
                    />
                  </Box>

                  <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
                    <Text color={theme.muted}>{t(lang, '[n] 目标题数: ', '[n] Count: ')}</Text>
                    {TARGET_COUNTS.map((cnt) => (
                      <Box key={cnt} marginRight={1}>
                        <Badge
                          label={cnt}
                          tone={cnt === targetCount ? 'accent' : 'muted'}
                          variant={cnt === targetCount ? 'solid' : 'outline'}
                        />
                      </Box>
                    ))}
                  </Box>

                  <Box marginTop={1} flexDirection="column">
                    <Text color={theme.muted}>{t(lang, '[f] 重点与额外指令:', '[f] Focus / Instructions:')}</Text>
                    <Text color={focusText ? theme.text : theme.dim}>
                      {focusText || t(lang, '（无，按材料自动规划重点）', '(None — auto plan from materials)')}
                    </Text>
                  </Box>

                  <Box marginTop={1} flexDirection="column">
                    <Text color={theme.primary} bold>
                      {t(lang, '用量与费用预估:', 'Token Estimate:')}
                    </Text>
                    {effectiveSourceIds.length === 0 ? (
                      <Text color={theme.dim}>{t(lang, '勾选左侧资料后自动估算', 'Select materials to estimate')}</Text>
                    ) : estimate.loading ? (
                      <Spinner label={t(lang, '正在计算预估用量…', 'Estimating…')} />
                    ) : estimate.tokensHigh ? (
                      <Text color={theme.info}>
                        {`≈ ${(estimate.tokensLow ?? 0).toLocaleString()}–${estimate.tokensHigh.toLocaleString()} tokens` +
                          (estimate.calls ? ` · ${estimate.calls} ${t(lang, '次调用', 'calls')}` : '')}
                      </Text>
                    ) : (
                      <Text color={theme.dim}>{estimate.note || t(lang, '约按所选文本长度动态规划', 'Planned dynamically by selected pages')}</Text>
                    )}
                  </Box>

                  <Box marginTop={1}>
                    {submitting ? (
                      <Spinner label={t(lang, '正在提交后台出题任务…', 'Submitting generation job…')} />
                    ) : (
                      <Badge
                        label={t(lang, '按 [Enter] 或 [Ctrl+S] 开始出题', 'Press [Enter] or [Ctrl+S] to Generate')}
                        tone={model.ready && effectiveSourceIds.length > 0 ? 'success' : 'muted'}
                      />
                    )}
                  </Box>
                </Box>
              </Panel>
            )}
          />
        )}
      </Box>

      {/* Modals for scope / focus */}
      {overlay === 'scope' ? (
        <Modal
          title={t(lang, '设置页码范围', 'Page Scope')}
          width={56}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Enter', label: t(lang, '确定', 'Apply') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>{t(lang, '输入 all 或页码范围（例如 1-5, 8）:', 'Enter "all" or page ranges (e.g. 1-5, 8):')}</Text>
          <Box marginTop={1}>
            <TextInput
              value={pageScope}
              onChange={setPageScope}
              onSubmit={() => setOverlay('none')}
              onCancel={() => setOverlay('none')}
              width={modalContentWidth(56) - 4}
              isActive={isActive}
              prompt="›"
            />
          </Box>
        </Modal>
      ) : null}

      {overlay === 'focus' ? (
        <Modal
          title={t(lang, '自定义出题重点 / 要求', 'Custom Focus / Instructions')}
          width={68}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <TextInput
            value={focusText}
            onChange={setFocusText}
            onSubmit={() => setOverlay('none')}
            onCancel={() => setOverlay('none')}
            placeholder={t(lang, '例如：侧重计算题与易错概念辨析，解析给出推导步骤', 'e.g. Focus on numerical derivations and common misconceptions')}
            multiline
            height={4}
            width={modalContentWidth(68) - 4}
            isActive={isActive}
          />
        </Modal>
      ) : null}

      <Suspense fallback={null}>
        {overlay === 'ingest' ? (
          <IngestModal
            host={host}
            defaultCourse={courseName || currentCourse(snapshot)}
            isActive={isActive && overlay === 'ingest'}
            onClose={() => setOverlay('none')}
            onDone={refresh}
          />
        ) : null}
      </Suspense>
    </Box>
  );
});

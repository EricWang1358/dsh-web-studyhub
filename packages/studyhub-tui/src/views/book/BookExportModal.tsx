import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { atomicWriteExportText, atomicWriteTextFile, defaultBackupFilePath } from '../../host/atomic-write.js';
import { cleanPathInput, tryAction } from '../../host/sample-actions.js';
import { expandHomePath } from '../sources/path-complete.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';

export type BookExportQuestionMode = 'linked' | 'all' | 'none';

export interface BookExportEstimate {
  pages: number;
  book: number;
  withAnswers: number;
  columns: number;
  rows: number;
}

export interface BookExportResponse {
  status: 'ok' | 'empty';
  course: string | null;
  reason?: string;
  form?: 'single' | 'folder';
  title?: string;
  language?: string;
  filename?: string;
  text?: string;
  questionMode?: BookExportQuestionMode;
  questions?: number;
  estimate?: BookExportEstimate;
  rebuildPending?: {
    outlineId?: string;
    note?: string;
  };
}

export interface BookExportModalProps {
  host: HostClient;
  course: string | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
}

const QUESTION_MODES: readonly BookExportQuestionMode[] = ['linked', 'all', 'none'];

export function sanitizeCourseFilename(course: string | null | undefined): string {
  const raw = String(course ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*#%&{}~]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  const safe = raw || 'course';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe) ? `${safe}-book` : safe;
}

export function defaultBookExportPath(rootPath: string, course: string | null | undefined): string {
  const slug = course && course.trim() ? sanitizeCourseFilename(course) : undefined;
  return defaultBackupFilePath(rootPath, 'studyhub-book', 'md', slug);
}

export function resolveBookExportPath(raw: string, baseDir: string): string {
  const cleaned = cleanPathInput(raw);
  if (!cleaned) return '';
  const expanded = expandHomePath(cleaned, homedir());
  const lower = expanded.toLowerCase();
  const withExt = lower.endsWith('.md') || lower.endsWith('.markdown') ? expanded : `${expanded}.md`;
  return isAbsolute(withExt) ? withExt : resolve(baseDir || process.cwd(), withExt);
}

export async function atomicWriteMarkdownFile(targetPath: string, text: string): Promise<number> {
  const { bytes } = await atomicWriteTextFile(targetPath, text);
  return bytes;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export const BookExportModal = memo(function BookExportModal({
  host,
  course,
  isActive,
  width,
  height: _height,
  onClose,
}: BookExportModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const notify = useTuiStore((s) => s.notify);

  const rootPath = bindingRoot || host.getLibraryRoot() || process.cwd();

  const [questions, setQuestions] = useState<BookExportQuestionMode>('linked');
  const [answerKey, setAnswerKey] = useState(false);
  const [focus, setFocus] = useState<'options' | 'path'>('options');
  const [outputPath, setOutputPath] = useState(() => defaultBookExportPath(rootPath, course));

  const [estimating, setEstimating] = useState(true);
  const [estimateData, setEstimateData] = useState<BookExportResponse | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const estSeqRef = useRef(0);
  const pathDirtyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const seq = ++estSeqRef.current;
    setEstimating(true);
    setEstimateError(null);
    void tryAction<BookExportResponse>(host, 'course.book.export', {
      ...(course ? { course } : {}),
      form: 'single',
      questions,
      answerKey,
      estimateOnly: true,
    }).then((res) => {
      if (!mountedRef.current || seq !== estSeqRef.current) return;
      setEstimating(false);
      if (res.ok && res.value) {
        setEstimateData(res.value);
        if (!pathDirtyRef.current && res.value.course) {
          setOutputPath(defaultBookExportPath(rootPath, res.value.course));
        }
      } else {
        setEstimateError(res.error?.message || t(lang, '无法计算导出页数预估', 'Failed to estimate export size'));
      }
    });
  }, [host, course, questions, answerKey, rootPath, lang]);

  const effectiveCourse = estimateData?.course ?? course ?? null;
  const isEmpty = !estimating && !estimateError && estimateData?.status === 'empty';
  const canExport = !saving && !isEmpty && estimateData?.status === 'ok';

  const handleExport = useCallback(
    async (pathOverride?: string) => {
      if (savingRef.current || estimateData?.status !== 'ok') return;
      const rawPath = pathOverride ?? outputPath;
      const targetPath = resolveBookExportPath(rawPath, rootPath);
      if (!targetPath) {
        setExportError(t(lang, '请输入有效的导出文件路径', 'Please enter a valid export file path'));
        return;
      }
      savingRef.current = true;
      setSaving(true);
      setExportError(null);
      try {
        const res = await tryAction<BookExportResponse>(host, 'course.book.export', {
          ...(effectiveCourse ? { course: effectiveCourse } : {}),
          form: 'single',
          questions,
          answerKey,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          setExportError(res.error?.message || t(lang, '导出复习全书失败', 'Failed to export review book'));
          return;
        }
        if (res.value.status !== 'ok' || typeof res.value.text !== 'string') {
          setExportError(t(lang, '当前课程暂无可导出的复习全书正文', 'No review book Markdown available to export'));
          return;
        }
        const written = await atomicWriteExportText(targetPath, res.value.text);
        if (!mountedRef.current) return;
        const pages = res.value.estimate?.pages ?? estimateData.estimate?.pages ?? 0;
        const arrow = asciiMode ? '->' : '→';
        notify(
          t(
            lang,
            `已导出复习全书 (~${pages} A4页, ${res.value.text.length.toLocaleString()} 字, ${formatBytes(written.bytes)}) ${arrow} ${written.path}`,
            `Exported review book (~${pages} A4 pages, ${res.value.text.length.toLocaleString()} chars, ${formatBytes(written.bytes)}) ${arrow} ${written.path}`,
          ),
          'success',
        );
        onClose();
      } catch (err) {
        if (!mountedRef.current) return;
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [answerKey, asciiMode, effectiveCourse, estimateData, host, lang, notify, onClose, outputPath, questions, rootPath],
  );

  useInput(
    (input, key) => {
      if (savingRef.current || saving) return;
      if (isEmpty) return;
      if (key.tab || key.upArrow || key.downArrow) {
        setFocus((f) => (f === 'options' ? 'path' : 'options'));
        return;
      }
      if (focus === 'options') {
        if (input === 'q') {
          setQuestions((cur) => QUESTION_MODES[(QUESTION_MODES.indexOf(cur) + 1) % QUESTION_MODES.length]);
          return;
        }
        if (input === 'k') {
          setAnswerKey((v) => !v);
          return;
        }
        if (key.return && canExport) {
          void handleExport();
        }
      }
    },
    { isActive: isActive && !saving },
  );

  const frameW = Math.max(44, Math.min(74, width - 2));
  const innerW = modalContentWidth(frameW);
  const inputW = Math.max(12, innerW - 4);
  const ell = asciiMode ? '...' : '…';

  const hints = useMemo<KeyHint[]>(() => {
    if (isEmpty) return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    if (focus === 'path') {
      return [
        { key: 'Tab', label: t(lang, '切回选项', 'Options') },
        { key: 'Enter', label: t(lang, '导出.md', 'Export .md') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    return [
      { key: 'q', label: t(lang, '题目范围', 'Questions') },
      { key: 'k', label: t(lang, '答案册', 'Answer key') },
      { key: 'Tab', label: t(lang, '改路径', 'Edit path') },
      { key: 'Enter', label: t(lang, '导出.md', 'Export .md') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }, [focus, isEmpty, lang]);

  const questionLabel = (mode: BookExportQuestionMode) => {
    if (mode === 'linked') return t(lang, '关联 linked', 'Linked');
    if (mode === 'all') return t(lang, '全部 all', 'All');
    return t(lang, '不含 none', 'None');
  };

  const est = estimateData?.estimate;
  const estCjkChars = est ? est.pages * est.columns * est.rows : 0;
  const estHead = est ? t(lang, `A4 预估: ~${est.pages} 页`, `Est. A4: ~${est.pages} pages`) : '';
  const mul = asciiMode ? 'x' : '×';

  return (
    <Modal
      title={t(lang, '导出可打印复习全书', 'Export Printable Review Book')}
      subtitle={effectiveCourse ? truncateDisplay(effectiveCourse, 22, ell) : undefined}
      icon={asciiMode ? '#' : '▣'}
      tone="primary"
      width={frameW}
      onClose={saving ? undefined : onClose}
      isActive={isActive}
      hints={hints}
    >
      {estimating && !estimateData ? (
        <Box paddingY={1} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在读取复习全书并估算页数${ell}`, `Loading book and estimating pages${ell}`)} active={isActive} />
        </Box>
      ) : isEmpty ? (
        <EmptyState
          icon={asciiMode ? '!' : '▣'}
          title={
            estimateData?.reason === 'no-course'
              ? t(lang, '请先选择一门课程', 'Select a course first')
              : t(lang, '该课程还没有复习全书', 'No review book for this course yet')
          }
          hint={
            estimateData?.reason === 'no-course'
              ? t(lang, '关闭弹窗后按 [c] 选择课程', 'Close and press [c] to pick a course')
              : t(lang, '请先在复习全书页面按 [g] 生成课程总纲与讲义', 'Press [g] in Book view to build the outline and review book')
          }
          width={innerW}
        />
      ) : (
        <Box flexDirection="column" width={innerW} overflow="hidden">
          {/* Option 1: Questions mode */}
          <Box flexDirection="row" alignItems="center" gap={1} height={1} overflow="hidden">
            <Text color={focus === 'options' ? theme.primary : theme.muted} bold>
              {t(lang, '[q] 练习题:', '[q] Questions:')}
            </Text>
            {QUESTION_MODES.map((m) => (
              <Badge
                key={m}
                label={questionLabel(m)}
                tone={questions === m ? 'primary' : 'neutral'}
                variant={questions === m ? 'solid' : 'outline'}
              />
            ))}
          </Box>

          {/* Option 2: Answer key toggle */}
          <Box flexDirection="row" alignItems="center" gap={1} height={1} overflow="hidden">
            <Text color={focus === 'options' ? theme.primary : theme.muted} bold>
              {t(lang, '[k] 答案册:', '[k] Answer key:')}
            </Text>
            <Badge
              label={answerKey ? 'ON' : 'OFF'}
              tone={answerKey ? 'success' : 'neutral'}
              variant={answerKey ? 'solid' : 'outline'}
            />
            <Text color={theme.dim}>
              {truncateDisplay(
                answerKey
                  ? t(lang, '(文末附带答案与解析)', '(append answers & explanations)')
                  : t(lang, '(仅正文与题目)', '(book & questions only)'),
                Math.max(8, innerW - 24),
                ell,
              )}
            </Text>
          </Box>

          <Divider width={innerW} />

          {/* Estimate summary */}
          <Box flexDirection="column" width={innerW} overflow="hidden">
            {estimating ? (
              <Spinner label={t(lang, `正在更新 A4 页数估算${ell}`, `Updating A4 estimate${ell}`)} active={isActive} />
            ) : estimateError ? (
              <Text color={theme.error} wrap="wrap">{estimateError}</Text>
            ) : est ? (
              <>
                <Box flexDirection="row" gap={1} height={1} overflow="hidden">
                  <Text color={theme.accent} bold>
                    {estHead}
                  </Text>
                  <Text color={theme.muted}>
                    {truncateDisplay(
                      t(
                        lang,
                        `(正文 ${est.book} 页 · 含答案 ${est.withAnswers} 页 · 约 ${estCjkChars.toLocaleString()} 字容)`,
                        `(book ${est.book}p · w/key ${est.withAnswers}p · ~${estCjkChars.toLocaleString()} CJK chars)`,
                      ),
                      Math.max(8, innerW - displayWidth(estHead) - 1),
                      ell,
                    )}
                  </Text>
                </Box>
                <Text color={theme.dim}>
                  {truncateDisplay(
                    t(
                      lang,
                      `版面规则: ${est.columns} 全角字 ${mul} ${est.rows} 行/页 (Pandoc 可直接排版 PDF)`,
                      `Page rule: ${est.columns} wide cols ${mul} ${est.rows} rows/page (Pandoc-ready)`,
                    ),
                    innerW,
                    ell,
                  )}
                </Text>
              </>
            ) : null}
            {estimateData?.rebuildPending ? (
              <Text color={theme.warning}>
                {truncateDisplay(
                  t(lang, '提示: 当前按待确认的新总纲布局预览导出', 'Note: exporting layout of pending rebuilt outline'),
                  innerW,
                  ell,
                )}
              </Text>
            ) : null}
          </Box>

          <Divider width={innerW} />

          {/* Output Path TextInput */}
          <Box flexDirection="column" width={innerW} overflow="hidden">
            <Text color={focus === 'path' ? theme.primary : theme.muted} bold={focus === 'path'}>
              {truncateDisplay(
                focus === 'path'
                  ? t(lang, '导出路径 (编辑中 · Tab 切回选项 · Enter 写入):', 'Output path (editing · Tab for options · Enter to export):')
                  : t(lang, '导出路径 (按 Tab 编辑 · 支持 ~ / Windows / 拖拽路径):', 'Output path (Tab to edit · supports ~ / Windows / dropped paths):'),
                innerW,
                ell,
              )}
            </Text>
            <TextInput
              value={outputPath}
              onChange={(val) => {
                pathDirtyRef.current = true;
                setOutputPath(val);
              }}
              onSubmit={(val) => {
                if (canExport) void handleExport(val);
              }}
              onCancel={saving ? undefined : onClose}
              width={inputW}
              isActive={isActive && focus === 'path' && !saving && !isEmpty}
              prompt={asciiMode ? '>' : '›'}
              placeholder={defaultBookExportPath(rootPath, effectiveCourse)}
            />
          </Box>

          {saving ? (
            <Box marginTop={0}>
              <Spinner label={t(lang, `正在生成并写入 Markdown${ell}`, `Generating and writing Markdown${ell}`)} active={isActive} />
            </Box>
          ) : null}
          {exportError ? (
            <Box marginTop={0}>
              <Text color={theme.error} wrap="wrap">
                {`${asciiMode ? '!' : '✕'} ${exportError}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});

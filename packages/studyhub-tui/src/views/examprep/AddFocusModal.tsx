import React, { useCallback, useEffect, useRef, useState } from 'react';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Box, Text } from 'ink';
import { atomicCopyFile } from '../../host/atomic-write.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { useInputCapture } from '../../components/focus.js';
import { truncateDisplay } from '../../render/cjk.js';
import { cleanPathInput, tryAction } from '../../host/sample-actions.js';
import { runIdempotentTwoStep } from '../../host/tx-write.js';
import {
  detectImageMimeFromBytes,
  mergeUniqueTopics,
  splitFocusTopicsInput,
  type CourseRecordView,
} from './types.js';

export interface AddFocusModalProps {
  host: HostClient;
  course: string;
  existingTopics: readonly string[];
  width: number;
  isActive: boolean;
  onSaved: (count: number) => void;
  onClose: () => void;
}

type IntakeMode = 'text' | 'image' | 'suggest';
type FieldId = 'course' | 'input' | 'notes' | 'role' | 'jd' | 'topics';

interface SuggestMatchState {
  role: string;
  jd: string;
  targetTopics: string[];
  method: 'ai' | 'rules';
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown']);

export const AddFocusModal: React.FC<AddFocusModalProps> = ({
  host,
  course: initialCourse,
  existingTopics,
  width,
  isActive,
  onSaved,
  onClose,
}) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);

  // Hold input capture for the modal lifetime even while ConfirmDialog mounts on top.
  useInputCapture(isActive);

  const [mode, setMode] = useState<IntakeMode>('text');
  const [field, setField] = useState<FieldId>('input');
  const [courseName, setCourseName] = useState(initialCourse);
  const [rawText, setRawText] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [imageNotes, setImageNotes] = useState('');
  const [roleInput, setRoleInput] = useState('');
  const [jdInput, setJdInput] = useState('');
  const [topicsInput, setTopicsInput] = useState('');
  const [saveAsMaterial, setSaveAsMaterial] = useState(true);

  const [stagedInfo, setStagedInfo] = useState<string | null>(null);
  const [suggestResult, setSuggestResult] = useState<SuggestMatchState | null>(null);
  const [confirmSuggestOpen, setConfirmSuggestOpen] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const modalW = Math.min(78, Math.max(44, width - 4));
  const contentW = modalContentWidth(modalW);
  const modalInputActive = isActive && !confirmSuggestOpen;

  const courseSourceIds = (snapshot?.sources ?? [])
    .filter((s) => !s.archived && (!courseName.trim() || s.course === courseName.trim() || s.courses?.includes(courseName.trim())))
    .map((s) => s.id)
    .slice(0, 12);

  const handleExtractFromText = useCallback(async () => {
    if (busyRef.current) return;
    const trimmed = rawText.trim();
    if (!trimmed && !courseSourceIds.length) {
      setErrorMsg(t(lang, '请先粘贴考试大纲或划重点内容', 'Paste syllabus or exam focus notes first'));
      return;
    }
    busyRef.current = true;
    setErrorMsg(null);
    setBusy(t(lang, `正在提炼重点条目${ell}`, `Extracting focus topics${ell}`));
    try {
      const res = await tryAction<{ topics?: string[]; summary?: string; source?: string }>(host, 'focus.extract', {
        course: courseName.trim(),
        text: trimmed,
        sourceIds: courseSourceIds,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        const local = splitFocusTopicsInput(trimmed);
        if (local.length) {
          const merged = mergeUniqueTopics(splitFocusTopicsInput(topicsInput), local);
          setTopicsInput(merged.join('; '));
          setStatusNote(t(lang, `已用本地规则识别 ${local.length} 个重点条目`, `Parsed ${local.length} topic(s) locally`));
          return;
        }
        setErrorMsg(res.error?.message || t(lang, '提炼失败', 'Extraction failed'));
        return;
      }
      const incoming = res.value?.topics ?? [];
      if (!incoming.length) {
        setStatusNote(t(lang, '未识别出新条目，可直接在下方手动编辑', 'No new topics extracted; edit below manually'));
        return;
      }
      const merged = mergeUniqueTopics(splitFocusTopicsInput(topicsInput), incoming);
      setTopicsInput(merged.join('; '));
      setStatusNote(
        res.value?.source === 'local'
          ? t(lang, `本地规则识别 ${incoming.length} 条重点`, `Local rules found ${incoming.length} topic(s)`)
          : res.value?.summary || t(lang, `AI 提炼出 ${incoming.length} 条重点`, `Extracted ${incoming.length} topic(s)`),
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [rawText, courseSourceIds, host, courseName, topicsInput, lang, ell]);

  const handleLoadAndExtractImage = useCallback(async () => {
    if (busyRef.current) return;
    const cleaned = cleanPathInput(imagePath);
    if (!cleaned) {
      setErrorMsg(t(lang, '请输入本地截图或文本路径', 'Enter a local screenshot or syllabus file path'));
      return;
    }
    const resolved = isAbsolute(cleaned) ? cleaned : resolve(host.getLibraryRoot() || process.cwd(), cleaned);
    busyRef.current = true;
    setErrorMsg(null);
    setBusy(t(lang, `正在读取并暂存文件${ell}`, `Reading and staging local file${ell}`));
    try {
      const st = await stat(resolved);
      if (!st.isFile()) {
        throw new Error(t(lang, '该路径不是文件', 'Path is not a file'));
      }
      if (st.size <= 0 || st.size > MAX_IMAGE_BYTES) {
        throw new Error(t(lang, '文件大小需在 1B 到 10MB 之间', 'File size must be between 1B and 10MB'));
      }
      const ext = extname(resolved).toLowerCase();
      if (TEXT_EXTS.has(ext)) {
        const text = await readFile(resolved, 'utf8');
        if (!mountedRef.current) return;
        setRawText(text.slice(0, 20000));
        setStagedInfo(`${basename(resolved)} (${Math.round(st.size / 1024)} KB, text)`);
        const res = await tryAction<{ topics?: string[]; summary?: string }>(host, 'focus.extract', {
          course: courseName.trim(),
          text: `${imageNotes.trim()}\n${text}`.trim().slice(0, 20000),
          sourceIds: courseSourceIds,
        });
        if (!mountedRef.current) return;
        const incoming = res.ok ? (res.value?.topics ?? []) : splitFocusTopicsInput(text);
        if (incoming.length) {
          const merged = mergeUniqueTopics(splitFocusTopicsInput(topicsInput), incoming);
          setTopicsInput(merged.join('; '));
          setStatusNote(t(lang, `已从文件提炼 ${incoming.length} 条重点`, `Extracted ${incoming.length} topic(s) from file`));
        } else {
          setStatusNote(t(lang, '已读取文本文件，可在下方手动补充重点', 'Loaded file; edit topics below'));
        }
        return;
      }

      if (!IMAGE_EXTS.has(ext)) {
        throw new Error(t(lang, '支持 PNG/JPG/WebP/GIF 图片或 TXT/MD 文件', 'Supported: PNG/JPG/WebP/GIF or TXT/MD'));
      }
      const bytes = await readFile(resolved);
      const mime = detectImageMimeFromBytes(bytes);
      if (!mime) {
        throw new Error(t(lang, '文件内容不是有效的 PNG/JPG/WebP/GIF 图片', 'File bytes do not match a valid image header'));
      }
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      const stagedRes = await tryAction<{ files?: Array<{ relativePath?: string }> }>(host, 'focus.images.stage', {
        files: [{ name: basename(resolved), dataUrl }],
      });

      let stagedLabel = stagedRes.ok && stagedRes.value?.files?.[0]?.relativePath
        ? stagedRes.value.files[0].relativePath
        : '';

      if (!stagedLabel) {
        const libRoot = host.getLibraryRoot() || process.cwd();
        const destDir = join(libRoot, 'studyhub-work', 'focus-intake', randomUUID().slice(0, 8));
        const destFile = join(destDir, basename(resolved));
        await atomicCopyFile(resolved, destFile);
        stagedLabel = destFile;
      }

      if (!mountedRef.current) return;
      setStagedInfo(`${basename(resolved)} (${Math.round(st.size / 1024)} KB, ${mime}) ${asciiMode ? '->' : '→'} ${truncateDisplay(stagedLabel, 28, ell)}`);

      const combinedNotes = [imageNotes.trim(), `Screenshot file: ${basename(resolved)}`].filter(Boolean).join('\n');
      if (imageNotes.trim()) {
        const res = await tryAction<{ topics?: string[]; summary?: string }>(host, 'focus.extract', {
          course: courseName.trim(),
          text: combinedNotes,
          sourceIds: courseSourceIds,
        });
        if (!mountedRef.current) return;
        const incoming = res.ok ? (res.value?.topics ?? []) : splitFocusTopicsInput(imageNotes);
        if (incoming.length) {
          const merged = mergeUniqueTopics(splitFocusTopicsInput(topicsInput), incoming);
          setTopicsInput(merged.join('; '));
          setStatusNote(t(lang, `已暂存截图并提炼 ${incoming.length} 条重点`, `Staged screenshot & extracted ${incoming.length} topic(s)`));
        } else {
          setStatusNote(t(lang, '截图已暂存，请在下方填写或补充重点条目', 'Screenshot staged; enter focus topics below'));
        }
      } else {
        setStatusNote(t(lang, '截图已暂存！可补充图片备注或直接在下方输入重点条目', 'Screenshot staged! Add notes or enter focus topics below'));
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [imagePath, host, courseName, imageNotes, courseSourceIds, topicsInput, lang, asciiMode, ell]);

  const requestSuggestMatch = useCallback(() => {
    if (busyRef.current || busy !== null || confirmSuggestOpen) return;
    const trimmedRole = roleInput.trim();
    if (!trimmedRole) {
      setErrorMsg(t(lang, '请先填写目标岗位方向（如：后端工程师）', 'Enter a target role first (e.g. Backend Engineer)'));
      setField('role');
      return;
    }
    setErrorMsg(null);
    setConfirmSuggestOpen(true);
  }, [busy, confirmSuggestOpen, roleInput, lang]);

  const executeSuggestMatch = useCallback(async () => {
    if (busyRef.current) return;
    const trimmedRole = roleInput.trim().slice(0, 200);
    if (!trimmedRole) {
      setErrorMsg(t(lang, '请先填写目标岗位方向', 'Enter a target role first'));
      return;
    }
    busyRef.current = true;
    setErrorMsg(null);
    setBusy(t(lang, `正在匹配题库重点${ell}`, `Matching deck topics${ell}`));
    try {
      const trimmedJd = jdInput.trim().slice(0, 20000);
      const res = await tryAction<{ role?: string; jd?: string; targetTopics?: string[]; method?: string }>(
        host,
        'focus.suggest',
        {
          role: trimmedRole,
          ...(trimmedJd ? { jd: trimmedJd } : {}),
        },
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        setErrorMsg(res.error?.message || t(lang, '匹配题库重点失败', 'Failed to match deck topics'));
        return;
      }
      const targetTopics = Array.isArray(res.value?.targetTopics)
        ? res.value.targetTopics.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const method: 'ai' | 'rules' = res.value?.method === 'ai' ? 'ai' : 'rules';
      setSuggestResult({
        role: typeof res.value?.role === 'string' && res.value.role ? res.value.role : trimmedRole,
        jd: typeof res.value?.jd === 'string' ? res.value.jd : trimmedJd,
        targetTopics,
        method,
      });
      if (targetTopics.length > 0) {
        const merged = mergeUniqueTopics(splitFocusTopicsInput(topicsInput), targetTopics);
        setTopicsInput(merged.join('; '));
        setStatusNote(
          method === 'ai'
            ? t(lang, `AI 匹配到 ${targetTopics.length} 个现有知识点，已合并到下方重点`, `AI matched ${targetTopics.length} deck topic(s) & merged below`)
            : t(lang, `规则回退匹配到 ${targetTopics.length} 个知识点`, `Rules matched ${targetTopics.length} topic(s)`),
        );
      } else {
        setStatusNote(
          method === 'ai'
            ? t(lang, '现有题库中暂无匹配知识点，可手动补充重点', 'No matching deck topics found; enter manually')
            : t(lang, '当前使用规则回退且未匹配到知识点', 'Rules fallback found 0 matching topics'),
        );
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [roleInput, jdInput, ell, host, topicsInput, lang]);

  const createdSourceIdRef = useRef<string | null>(null);

  const handleSave = useCallback(async () => {
    if (busyRef.current) return;
    const trimmedCourse = courseName.trim();
    if (!trimmedCourse) {
      setErrorMsg(t(lang, '请填写课程名称', 'Course name is required'));
      return;
    }
    let parsedTopics = splitFocusTopicsInput(topicsInput);
    if (!parsedTopics.length && rawText.trim()) {
      parsedTopics = splitFocusTopicsInput(rawText);
    }
    if (!parsedTopics.length && imageNotes.trim()) {
      parsedTopics = splitFocusTopicsInput(imageNotes);
    }
    if (!parsedTopics.length) {
      setErrorMsg(t(lang, '请先提炼、匹配或输入至少 1 个重点知识点', 'Extract, match, or enter at least 1 focus topic'));
      return;
    }

    busyRef.current = true;
    setErrorMsg(null);
    setBusy(t(lang, `正在保存重点到课程${ell}`, `Saving focus topics${ell}`));
    try {
      const existingCourse = (snapshot?.courses ?? []).find(
        (c) => String(c.name || c.id || '').trim() === trimmedCourse,
      );
      let courseRecord: CourseRecordView | null = null;
      if (existingCourse?.id) {
        const got = await tryAction<CourseRecordView>(host, 'course.get', { id: String(existingCourse.id) });
        if (got.ok && got.value) courseRecord = got.value;
      }

      const baseGuidanceIds = [...(courseRecord?.guidanceSourceIds ?? [])];
      const sourceBody = rawText.trim() || (stagedInfo ? `Screenshot staged: ${stagedInfo}\n${imageNotes.trim()}`.trim() : '');
      const finalTopics = mergeUniqueTopics(existingTopics, parsedTopics);

      const tx = await runIdempotentTwoStep<string, boolean>({
        cachedStep1: createdSourceIdRef.current,
        setCachedStep1: (val) => {
          createdSourceIdRef.current = val;
        },
        step1: async () => {
          if (!saveAsMaterial || !sourceBody) return { ok: true, value: '' };
          const added = await tryAction<{ id: string }>(host, 'source.add', {
            title: `${trimmedCourse} · ${t(lang, '考试重点记录', 'Exam Focus Notes')}`,
            text: sourceBody.slice(0, 100_000),
            courses: [trimmedCourse],
            format: 'md',
          });
          if (!added.ok || !added.value?.id) return { ok: true, value: '' };
          return { ok: true, value: added.value.id };
        },
        step2: async (addedSourceId) => {
          const guidanceIds =
            addedSourceId && !baseGuidanceIds.includes(addedSourceId)
              ? [...baseGuidanceIds, addedSourceId]
              : baseGuidanceIds;
          const saved = await tryAction(host, 'course.save', {
            ...(courseRecord?.id ? { id: courseRecord.id } : {}),
            name: trimmedCourse,
            ...(courseRecord?.exam ? { exam: courseRecord.exam } : {}),
            ...(courseRecord?.plan ? { plan: courseRecord.plan } : {}),
            guidanceSourceIds: guidanceIds,
            focusTopics: finalTopics,
          });
          if (!saved.ok) {
            return { ok: false, error: saved.error?.message || t(lang, '保存失败', 'Failed to save focus topics') };
          }
          return { ok: true, value: true };
        },
      });
      if (!mountedRef.current) return;
      if (!tx.ok) {
        setErrorMsg(
          tx.step1Succeeded && tx.step1Value
            ? t(
                lang,
                `参考资料已入库，但保存课程重点失败（${tx.error}）；重试保存将复用已建资料而不重复创建`,
                `Reference material was saved, but saving course focus failed (${tx.error}); retrying will reuse it without duplicating`,
              )
            : tx.error,
        );
        return;
      }
      createdSourceIdRef.current = null;
      notify(t(lang, `已保存「${trimmedCourse}」共 ${finalTopics.length} 项重点`, `Saved ${finalTopics.length} focus topic(s) for ${trimmedCourse}`), 'success');
      onSaved(finalTopics.length);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [courseName, topicsInput, rawText, imageNotes, stagedInfo, saveAsMaterial, snapshot?.courses, host, existingTopics, lang, ell, notify, onSaved]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        if (busyRef.current) return;
        setErrorMsg(null);
        setMode((m) => {
          const next: IntakeMode = m === 'text' ? 'image' : m === 'image' ? 'suggest' : 'text';
          setField(next === 'suggest' ? 'role' : 'input');
          return next;
        });
        return;
      }
      if (key.ctrl && input === 'g') {
        if (busyRef.current) return;
        setErrorMsg(null);
        if (mode !== 'suggest') {
          setMode('suggest');
          setField('role');
        } else {
          requestSuggestMatch();
        }
        return;
      }
      if (key.ctrl && input === 'e') {
        if (mode === 'text') void handleExtractFromText();
        else if (mode === 'image') void handleLoadAndExtractImage();
        else requestSuggestMatch();
        return;
      }
      if (key.ctrl && input === 's') {
        void handleSave();
        return;
      }
      if (key.ctrl && input === 'm') {
        setSaveAsMaterial((v) => !v);
        return;
      }
      if (key.tab) {
        const order: FieldId[] =
          mode === 'text'
            ? ['course', 'input', 'topics']
            : mode === 'image'
              ? ['course', 'input', 'notes', 'topics']
              : ['course', 'role', 'jd', 'topics'];
        const idx = order.indexOf(field);
        const nextIdx = (idx + (key.shift ? -1 : 1) + order.length) % order.length;
        setField(order[nextIdx]);
      }
    },
    { isActive: modalInputActive },
  );

  const sep = asciiMode ? '|' : '·';

  return (
    <>
      <Modal
        title={t(lang, '添加考纲重点', 'Add Exam Focus')}
        subtitle={t(lang, `Ctrl+T 切模式 ${sep} Ctrl+G 岗位匹配 ${sep} Ctrl+S 保存`, `Ctrl+T: Mode ${sep} Ctrl+G: Match ${sep} Ctrl+S: Save`)}
        width={modalW}
        onClose={onClose}
        isActive={modalInputActive}
        hints={[
          { key: 'Ctrl+T', label: t(lang, '模式', 'Mode') },
          { key: 'Tab', label: t(lang, '字段', 'Field') },
          { key: 'Ctrl+E', label: mode === 'suggest' ? t(lang, 'AI匹配', 'AI Match') : t(lang, '提炼', 'Extract') },
          { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
          { key: 'Esc', label: t(lang, '取消', 'Cancel') },
        ]}
      >
        <Box flexDirection="column" gap={1}>
          {/* Mode Switcher */}
          <Box columnGap={1} flexWrap="wrap">
            <Badge
              label={`1: ${t(lang, '粘贴考纲', 'Paste Text')}`}
              tone={mode === 'text' ? 'primary' : 'muted'}
              variant={mode === 'text' ? 'solid' : 'outline'}
            />
            <Badge
              label={`2: ${t(lang, '截图/文件', 'Image/File')}`}
              tone={mode === 'image' ? 'primary' : 'muted'}
              variant={mode === 'image' ? 'solid' : 'outline'}
            />
            <Badge
              label={`3: ${t(lang, 'AI匹配题库', 'AI Match Topics')}`}
              tone={mode === 'suggest' ? 'primary' : 'muted'}
              variant={mode === 'suggest' ? 'solid' : 'outline'}
            />
            {busy ? <Spinner label={busy} active={isActive} /> : null}
          </Box>

          {/* Course Name */}
          <Box flexDirection="column">
            <Text color={field === 'course' ? theme.primary : theme.muted} bold>
              {t(lang, '目标课程：', 'Target Course:')}
            </Text>
            <TextInput
              value={courseName}
              onChange={setCourseName}
              placeholder={t(lang, '输入或确认课程名称', 'Course name')}
              isActive={modalInputActive && field === 'course'}
              width={contentW}
              onCancel={onClose}
              onSubmit={() => setField(mode === 'suggest' ? 'role' : 'input')}
            />
          </Box>

          {mode === 'text' ? (
            <Box flexDirection="column">
              <Text color={field === 'input' ? theme.primary : theme.muted} bold>
                {t(lang, '考纲文本 / 划重点记录（Ctrl+E AI提炼）：', 'Syllabus / Exam Focus Text (Ctrl+E to extract):')}
              </Text>
              <TextInput
                value={rawText}
                onChange={setRawText}
                multiline
                height={4}
                placeholder={t(lang, `粘贴老师发的考试范围、重点清单或章节提要${ell}`, `Paste syllabus scope, focus bullets, or lecture notes${ell}`)}
                isActive={modalInputActive && field === 'input'}
                width={contentW}
                onCancel={onClose}
                onSubmit={() => void handleExtractFromText()}
              />
            </Box>
          ) : mode === 'image' ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column">
                <Text color={field === 'input' ? theme.primary : theme.muted} bold>
                  {t(lang, '本地截图 / 文件路径（支持拖拽路径，Ctrl+E 读取暂存）：', 'Local Screenshot / File Path (Ctrl+E to stage & read):')}
                </Text>
                <TextInput
                  value={imagePath}
                  onChange={setImagePath}
                  placeholder={process.platform === 'win32' ? 'C:\\Users\\you\\Pictures\\exam-focus.png' : '/home/user/Pictures/exam-focus.png'}
                  isActive={modalInputActive && field === 'input'}
                  width={contentW}
                  onCancel={onClose}
                  onSubmit={() => void handleLoadAndExtractImage()}
                />
              </Box>
              {stagedInfo ? <Text color={theme.success}>{`${asciiMode ? '+' : '✓'} ${stagedInfo}`}</Text> : null}
              <Box flexDirection="column">
                <Text color={field === 'notes' ? theme.primary : theme.muted} bold>
                  {t(lang, '图片补充说明 / 识别文字（可选）：', 'Image Caption / Notes (optional):')}
                </Text>
                <TextInput
                  value={imageNotes}
                  onChange={setImageNotes}
                  placeholder={t(lang, `可补充截图中的关键词或章节名${ell}`, `Optional keywords or notes from the screenshot${ell}`)}
                  isActive={modalInputActive && field === 'notes'}
                  width={contentW}
                  onCancel={onClose}
                  onSubmit={() => void handleLoadAndExtractImage()}
                />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column">
                <Text color={field === 'role' ? theme.primary : theme.muted} bold>
                  {t(lang, '目标岗位方向（Ctrl+E / Ctrl+G 触发 AI 匹配题库）：', 'Target Role (Ctrl+E / Ctrl+G to AI match deck topics):')}
                </Text>
                <TextInput
                  value={roleInput}
                  onChange={setRoleInput}
                  placeholder={t(lang, '例如：后端开发工程师 / 算法岗', 'e.g. Backend Engineer / Systems Architect')}
                  isActive={modalInputActive && field === 'role'}
                  width={contentW}
                  onCancel={onClose}
                  onSubmit={() => setField('jd')}
                />
              </Box>
              <Box flexDirection="column">
                <Text color={field === 'jd' ? theme.primary : theme.muted} bold>
                  {t(lang, '岗位描述 / JD 关键词（可选，Enter 匹配）：', 'Job Description / Keywords (optional, Enter to match):')}
                </Text>
                <TextInput
                  value={jdInput}
                  onChange={setJdInput}
                  placeholder={t(lang, `粘贴 JD 职责或技术栈要求${ell}`, `Paste role requirements or tech stack${ell}`)}
                  isActive={modalInputActive && field === 'jd'}
                  width={contentW}
                  onCancel={onClose}
                  onSubmit={() => requestSuggestMatch()}
                />
              </Box>
              {suggestResult ? (
                <Box flexDirection="column">
                  <Box gap={1}>
                    <Badge
                      label={suggestResult.method === 'ai' ? 'AI' : t(lang, '规则回退', 'Rules')}
                      tone={suggestResult.method === 'ai' ? 'success' : 'warning'}
                      variant="solid"
                    />
                    <Text color={theme.text} bold>
                      {t(
                        lang,
                        `匹配 ${suggestResult.targetTopics.length} 个现有知识点：`,
                        `Matched ${suggestResult.targetTopics.length} deck topic(s):`,
                      )}
                    </Text>
                  </Box>
                  {suggestResult.targetTopics.length > 0 ? (
                    <Text color={theme.accent}>
                      {truncateDisplay(suggestResult.targetTopics.join(` ${sep} `), contentW, ell)}
                    </Text>
                  ) : null}
                </Box>
              ) : null}
            </Box>
          )}

          {/* Extracted / Editable Topics */}
          <Box flexDirection="column">
            <Text color={field === 'topics' ? theme.primary : theme.muted} bold>
              {t(lang, '重点条目（分号 ; 分隔，Ctrl+S 保存到课程）：', 'Focus Topics (separated by ; , Ctrl+S to save):')}
            </Text>
            <TextInput
              value={topicsInput}
              onChange={setTopicsInput}
              placeholder={t(lang, '例如：动态规划; 最短路径; 银行家算法', 'e.g. Dynamic Programming; Shortest Path; Banker Algorithm')}
              isActive={modalInputActive && field === 'topics'}
              width={contentW}
              onCancel={onClose}
              onSubmit={() => void handleSave()}
            />
          </Box>

          {mode !== 'suggest' ? (
            <Text color={theme.dim}>
              {`${saveAsMaterial ? (asciiMode ? '[x]' : '☑') : (asciiMode ? '[ ]' : '☐')} ${t(lang, '同时存为课程资料 (Ctrl+M 切换)', 'Also save raw notes as course material (Ctrl+M)')}`}
            </Text>
          ) : null}

          {statusNote ? <Text color={theme.info}>{truncateDisplay(statusNote, contentW, ell)}</Text> : null}
          {errorMsg ? <Text color={theme.error} wrap="wrap">{`${asciiMode ? '!' : '✕'} ${errorMsg}`}</Text> : null}
        </Box>
      </Modal>

      {confirmSuggestOpen ? (
        <ConfirmDialog
          title={t(lang, '确认 AI 匹配题库重点', 'Confirm AI Topic Matching')}
          message={t(
            lang,
            `将发起 1 次轻量 AI 调用，\n按岗位「${roleInput.trim()}」从现有题库中匹配最多 20 个相关知识点\n（仅读取主题列表，绝不修改任何题目）。确认继续？`,
            `This will make 1 lightweight AI call\nto match up to 20 relevant existing topics from your decks\nfor "${roleInput.trim()}" (never modifies cards). Continue?`,
          )}
          confirmLabel={t(lang, '开始匹配', 'Match Topics')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={Math.min(64, Math.max(40, width - 6))}
          isActive={isActive && confirmSuggestOpen}
          onConfirm={() => {
            setConfirmSuggestOpen(false);
            void executeSuggestMatch();
          }}
          onCancel={() => {
            if (!busyRef.current) setConfirmSuggestOpen(false);
          }}
        />
      ) : null}
    </>
  );
};

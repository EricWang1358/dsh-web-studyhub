import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Box, Text, useInput } from 'ink';
import type { HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { Badge, Modal, Spinner, TextInput, modalContentWidth, useTheme } from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { cleanPathInput, tryAction } from '../../host/index.js';
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

type IntakeMode = 'text' | 'image';
type FieldId = 'course' | 'input' | 'notes' | 'topics';

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
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);

  const [mode, setMode] = useState<IntakeMode>('text');
  const [field, setField] = useState<FieldId>('input');
  const [courseName, setCourseName] = useState(initialCourse);
  const [rawText, setRawText] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [imageNotes, setImageNotes] = useState('');
  const [topicsInput, setTopicsInput] = useState('');
  const [saveAsMaterial, setSaveAsMaterial] = useState(true);

  const [stagedInfo, setStagedInfo] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const modalW = Math.min(78, Math.max(44, width - 4));
  const contentW = modalContentWidth(modalW);

  const courseSourceIds = (snapshot?.sources ?? [])
    .filter((s) => !s.archived && (!courseName.trim() || s.course === courseName.trim() || s.courses?.includes(courseName.trim())))
    .map((s) => s.id)
    .slice(0, 12);

  const handleExtractFromText = useCallback(async () => {
    const trimmed = rawText.trim();
    if (!trimmed && !courseSourceIds.length) {
      setErrorMsg(t(lang, '请先粘贴考试大纲或划重点内容', 'Paste syllabus or exam focus notes first'));
      return;
    }
    setErrorMsg(null);
    setBusy(t(lang, '正在提炼重点条目…', 'Extracting focus topics…'));
    const res = await tryAction<{ topics?: string[]; summary?: string; source?: string }>(host, 'focus.extract', {
      course: courseName.trim(),
      text: trimmed,
      sourceIds: courseSourceIds,
    });
    if (!mountedRef.current) return;
    setBusy(null);
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
  }, [rawText, courseSourceIds, host, courseName, topicsInput, lang]);

  const handleLoadAndExtractImage = useCallback(async () => {
    const cleaned = cleanPathInput(imagePath);
    if (!cleaned) {
      setErrorMsg(t(lang, '请输入本地截图或文本路径', 'Enter a local screenshot or syllabus file path'));
      return;
    }
    const resolved = isAbsolute(cleaned) ? cleaned : resolve(host.getLibraryRoot() || process.cwd(), cleaned);
    setErrorMsg(null);
    setBusy(t(lang, '正在读取并暂存文件…', 'Reading and staging local file…'));
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
        setBusy(null);
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
        await mkdir(destDir, { recursive: true });
        const destFile = join(destDir, basename(resolved));
        await copyFile(resolved, destFile);
        stagedLabel = destFile;
      }

      if (!mountedRef.current) return;
      setStagedInfo(`${basename(resolved)} (${Math.round(st.size / 1024)} KB, ${mime}) → ${truncateDisplay(stagedLabel, 28)}`);

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
      setBusy(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setBusy(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [imagePath, host, courseName, imageNotes, courseSourceIds, topicsInput, lang]);

  const handleSave = useCallback(async () => {
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
      setErrorMsg(t(lang, '请先提炼或输入至少 1 个重点知识点', 'Extract or enter at least 1 focus topic'));
      return;
    }

    setErrorMsg(null);
    setBusy(t(lang, '正在保存重点到课程…', 'Saving focus topics…'));

    const existingCourse = (snapshot?.courses ?? []).find(
      (c) => String(c.name || c.id || '').trim() === trimmedCourse,
    );
    let courseRecord: CourseRecordView | null = null;
    if (existingCourse?.id) {
      const got = await tryAction<CourseRecordView>(host, 'course.get', { id: String(existingCourse.id) });
      if (got.ok && got.value) courseRecord = got.value;
    }

    let guidanceIds = [...(courseRecord?.guidanceSourceIds ?? [])];
    const sourceBody = rawText.trim() || (stagedInfo ? `Screenshot staged: ${stagedInfo}\n${imageNotes.trim()}`.trim() : '');
    if (saveAsMaterial && sourceBody) {
      const added = await tryAction<{ id: string }>(host, 'source.add', {
        title: `${trimmedCourse} · ${t(lang, '考试重点记录', 'Exam Focus Notes')}`,
        text: sourceBody.slice(0, 100_000),
        courses: [trimmedCourse],
        format: 'md',
      });
      if (added.ok && added.value?.id && !guidanceIds.includes(added.value.id)) {
        guidanceIds = [...guidanceIds, added.value.id];
      }
    }

    const finalTopics = mergeUniqueTopics(existingTopics, parsedTopics);
    const saved = await tryAction(host, 'course.save', {
      ...(courseRecord?.id ? { id: courseRecord.id } : {}),
      name: trimmedCourse,
      ...(courseRecord?.exam ? { exam: courseRecord.exam } : {}),
      ...(courseRecord?.plan ? { plan: courseRecord.plan } : {}),
      guidanceSourceIds: guidanceIds,
      focusTopics: finalTopics,
    });
    if (!mountedRef.current) return;
    setBusy(null);
    if (!saved.ok) {
      setErrorMsg(saved.error?.message || t(lang, '保存失败', 'Failed to save focus topics'));
      return;
    }
    notify(t(lang, `已保存「${trimmedCourse}」共 ${finalTopics.length} 项重点`, `Saved ${finalTopics.length} focus topic(s) for ${trimmedCourse}`), 'success');
    onSaved(finalTopics.length);
  }, [courseName, topicsInput, rawText, imageNotes, stagedInfo, saveAsMaterial, snapshot?.courses, host, existingTopics, lang, notify, onSaved]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        setMode((m) => {
          const next = m === 'text' ? 'image' : 'text';
          setField('input');
          return next;
        });
        return;
      }
      if (key.ctrl && input === 'e') {
        if (mode === 'text') void handleExtractFromText();
        else void handleLoadAndExtractImage();
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
        const order: FieldId[] = mode === 'text' ? ['course', 'input', 'topics'] : ['course', 'input', 'notes', 'topics'];
        const idx = order.indexOf(field);
        const nextIdx = (idx + (key.shift ? -1 : 1) + order.length) % order.length;
        setField(order[nextIdx]);
      }
    },
    { isActive },
  );

  return (
    <Modal
      title={t(lang, '添加考纲重点', 'Add Exam Focus')}
      subtitle={t(lang, 'Ctrl+T 切换文本/图片 · Ctrl+E 提炼 · Ctrl+S 保存', 'Ctrl+T: Mode · Ctrl+E: Extract · Ctrl+S: Save')}
      width={modalW}
      onClose={onClose}
      isActive={isActive}
      hints={[
        { key: 'Ctrl+T', label: t(lang, '文本/图片路径', 'Text/Image') },
        { key: 'Tab', label: t(lang, '切字段', 'Field') },
        { key: 'Ctrl+E', label: t(lang, '提炼重点', 'Extract') },
        { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ]}
    >
      <Box flexDirection="column" gap={1}>
        {/* Mode Switcher */}
        <Box gap={1}>
          <Badge
            label={`1: ${t(lang, '粘贴考纲文本', 'Paste Syllabus Text')}`}
            tone={mode === 'text' ? 'primary' : 'muted'}
            variant={mode === 'text' ? 'solid' : 'outline'}
          />
          <Badge
            label={`2: ${t(lang, '本地截图 / 文件路径', 'Screenshot / File Path')}`}
            tone={mode === 'image' ? 'primary' : 'muted'}
            variant={mode === 'image' ? 'solid' : 'outline'}
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
            isActive={isActive && field === 'course'}
            width={contentW}
            onCancel={onClose}
            onSubmit={() => setField('input')}
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
              placeholder={t(lang, '粘贴老师发的考试范围、重点清单或章节提要…', 'Paste syllabus scope, focus bullets, or lecture notes…')}
              isActive={isActive && field === 'input'}
              width={contentW}
              onCancel={onClose}
              onSubmit={() => void handleExtractFromText()}
            />
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text color={field === 'input' ? theme.primary : theme.muted} bold>
                {t(lang, '本地截图 / 文件路径（支持拖拽路径，Ctrl+E 读取暂存）：', 'Local Screenshot / File Path (Ctrl+E to stage & read):')}
              </Text>
              <TextInput
                value={imagePath}
                onChange={setImagePath}
                placeholder={process.platform === 'win32' ? 'C:\\Users\\you\\Pictures\\exam-focus.png' : '/home/user/Pictures/exam-focus.png'}
                isActive={isActive && field === 'input'}
                width={contentW}
                onCancel={onClose}
                onSubmit={() => void handleLoadAndExtractImage()}
              />
            </Box>
            {stagedInfo ? <Text color={theme.success}>{`✓ ${stagedInfo}`}</Text> : null}
            <Box flexDirection="column">
              <Text color={field === 'notes' ? theme.primary : theme.muted} bold>
                {t(lang, '图片补充说明 / 识别文字（可选）：', 'Image Caption / Notes (optional):')}
              </Text>
              <TextInput
                value={imageNotes}
                onChange={setImageNotes}
                placeholder={t(lang, '可补充截图中的关键词或章节名…', 'Optional keywords or notes from the screenshot…')}
                isActive={isActive && field === 'notes'}
                width={contentW}
                onCancel={onClose}
                onSubmit={() => void handleLoadAndExtractImage()}
              />
            </Box>
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
            isActive={isActive && field === 'topics'}
            width={contentW}
            onCancel={onClose}
            onSubmit={() => void handleSave()}
          />
        </Box>

        <Text color={theme.dim}>
          {`${saveAsMaterial ? '☑' : '☐'} ${t(lang, '同时存为课程资料 (Ctrl+M 切换)', 'Also save raw notes as course material (Ctrl+M)')}`}
        </Text>

        {statusNote ? <Text color={theme.info}>{truncateDisplay(statusNote, contentW)}</Text> : null}
        {errorMsg ? <Text color={theme.error}>{`✕ ${truncateDisplay(errorMsg, contentW)}`}</Text> : null}
      </Box>
    </Modal>
  );
};

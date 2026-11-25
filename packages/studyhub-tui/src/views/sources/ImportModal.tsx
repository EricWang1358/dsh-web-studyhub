import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import {
  IMPORT_FORMATS,
  addTextSource,
  cleanPathInput,
  errorMessage,
  importFormatOf,
  importLocalSource,
} from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from './path-complete.js';

export interface ImportModalProps {
  host: HostClient;
  defaultCourse?: string | null;
  isActive: boolean;
  onClose: () => void;
  onImported: () => Promise<void> | void;
}

type ImportMode = 'file' | 'text';
type FileField = 'path' | 'title' | 'course';
type TextField = 'title' | 'format' | 'course' | 'body';

const SUPPORTED_EXTS = IMPORT_FORMATS.map((f) => `.${f === 'markdown' ? 'markdown' : f}`);

export const ImportModal = memo(function ImportModal({
  host,
  defaultCourse,
  isActive,
  onClose,
  onImported,
}: ImportModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  const [mode, setMode] = useState<ImportMode>('file');
  const [fileField, setFileField] = useState<FileField>('path');
  const [textField, setTextField] = useState<TextField>('title');

  // Mode 1: local file
  const [filePath, setFilePath] = useState('');
  const [fileTitle, setFileTitle] = useState('');
  const [fileCourse, setFileCourse] = useState(defaultCourse || '');
  const [matches, setMatches] = useState<string[]>([]);
  const cachedCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  // Mode 2: text paste
  const [textTitle, setTextTitle] = useState('');
  const [textFormat, setTextFormat] = useState<'md' | 'txt'>('md');
  const [textCourse, setTextCourse] = useState(defaultCourse || '');
  const [textBody, setTextBody] = useState('');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const frameWidth = 74;
  const innerWidth = modalContentWidth(frameWidth);

  // Pre-fetch path completions while typing in path field so Tab can also resolve synchronously.
  useEffect(() => {
    if (!isActive || mode !== 'file' || fileField !== 'path') return;
    let cancelled = false;
    const cleaned = cleanPathInput(filePath);
    void completeFsPath(cleaned, { extensions: [...SUPPORTED_EXTS, '.htm'] }).then((res) => {
      if (cancelled) return;
      cachedCompletionRef.current = { input: filePath, completed: res.completed };
      setMatches(res.matches.slice(0, 6));
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, mode, fileField, filePath]);

  const handleTabComplete = useCallback((val: string) => {
    const cached = cachedCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    const cleaned = cleanPathInput(val);
    void completeFsPath(cleaned, { extensions: [...SUPPORTED_EXTS, '.htm'] }).then((res) => {
      cachedCompletionRef.current = { input: res.completed, completed: res.completed };
      setMatches(res.matches.slice(0, 6));
      if (res.completed && res.completed !== val) setFilePath(res.completed);
    });
    return undefined;
  }, []);

  const submitFileImport = useCallback(async () => {
    if (busy) return;
    const cleaned = cleanPathInput(filePath);
    const expanded = expandHomePath(cleaned);
    if (!expanded) {
      setErr(t(lang, '请输入本地文件路径', 'Please enter a local file path'));
      return;
    }
    const fmt = importFormatOf(expanded);
    if (!fmt) {
      setErr(
        t(
          lang,
          '不支持的文件类型，支持 PDF / PPTX / DOCX / MD / LaTeX / HTML / TXT',
          'Unsupported file type. Supported: PDF / PPTX / DOCX / MD / LaTeX / HTML / TXT',
        ),
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await importLocalSource(host, {
        path: expanded,
        ...(fileTitle.trim() ? { title: fileTitle.trim() } : {}),
        ...(fileCourse.trim() ? { course: fileCourse.trim() } : {}),
        format: fmt,
      });
      await onImported();
      notify(t(lang, '资料导入成功', 'Source imported'), 'success');
      onClose();
    } catch (error) {
      setErr(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [busy, filePath, fileTitle, fileCourse, host, lang, notify, onImported, onClose]);

  const submitTextImport = useCallback(async () => {
    if (busy) return;
    const title = textTitle.trim();
    const body = textBody.trim();
    if (!title) {
      setErr(t(lang, '请输入资料标题', 'Please enter a title'));
      return;
    }
    if (!body) {
      setErr(t(lang, '请输入或粘贴资料内容', 'Please enter or paste text content'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await addTextSource(host, {
        title,
        text: body,
        format: textFormat,
        ...(textCourse.trim() ? { courses: [textCourse.trim()] } : {}),
      });
      await onImported();
      notify(t(lang, '文本资料已保存', 'Text material saved'), 'success');
      onClose();
    } catch (error) {
      setErr(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [busy, textTitle, textBody, textFormat, textCourse, host, lang, notify, onImported, onClose]);

  useInput(
    (input, key) => {
      if (busy) return;
      if (key.ctrl && input === 't') {
        setMode((m) => (m === 'file' ? 'text' : 'file'));
        setErr(null);
        return;
      }
      if (key.ctrl && input === 's') {
        if (mode === 'file') void submitFileImport();
        else void submitTextImport();
        return;
      }
      if (mode === 'file') {
        const order: FileField[] = ['path', 'title', 'course'];
        const idx = order.indexOf(fileField);
        if (key.downArrow || (key.ctrl && input === 'n')) {
          setFileField(order[(idx + 1) % order.length]);
        } else if (key.upArrow || (key.ctrl && input === 'p')) {
          setFileField(order[(idx - 1 + order.length) % order.length]);
        }
      } else {
        const order: TextField[] = ['title', 'format', 'course', 'body'];
        const idx = order.indexOf(textField);
        if (textField === 'format') {
          if (key.leftArrow || key.rightArrow || input === ' ') {
            setTextFormat((f) => (f === 'md' ? 'txt' : 'md'));
            return;
          }
        }
        if ((textField !== 'body' && key.downArrow) || (key.ctrl && input === 'n')) {
          setTextField(order[(idx + 1) % order.length]);
        } else if ((textField !== 'body' && key.upArrow) || (key.ctrl && input === 'p')) {
          setTextField(order[(idx - 1 + order.length) % order.length]);
        } else if (key.tab && textField !== 'body') {
          setTextField(order[(idx + 1) % order.length]);
        }
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Ctrl+T', label: t(lang, '切换模式', 'Switch mode') },
      { key: asciiMode ? 'Up/Down' : '↑/↓', label: t(lang, '切换字段', 'Next field') },
      ...(mode === 'file' && fileField === 'path' ? [{ key: 'Tab', label: t(lang, '路径补全', 'Complete') }] : []),
      { key: 'Ctrl+S', label: t(lang, '导入', 'Import') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ],
    [lang, asciiMode, mode, fileField],
  );

  const detectedFmt = importFormatOf(expandHomePath(cleanPathInput(filePath)));
  const promptGlyph = asciiMode ? '>' : '›';

  return (
    <Modal
      title={t(lang, '导入学习资料', 'Import Study Material')}
      subtitle={asciiMode ? 'PDF | PPTX | DOCX | MD | LaTeX | HTML | TXT' : 'PDF · PPTX · DOCX · MD · LaTeX · HTML · TXT'}
      icon={asciiMode ? '#' : '▤'}
      width={frameWidth}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      <Box flexDirection="row" marginBottom={1}>
        <Badge
          label={`1. ${t(lang, '导入本地文件', 'Local File')}`}
          tone={mode === 'file' ? 'primary' : 'muted'}
          variant={mode === 'file' ? 'solid' : 'outline'}
        />
        <Text> </Text>
        <Badge
          label={`2. ${t(lang, '粘贴文本 / Markdown', 'Paste Text / MD')}`}
          tone={mode === 'text' ? 'primary' : 'muted'}
          variant={mode === 'text' ? 'solid' : 'outline'}
        />
        <Box flexGrow={1} />
        <Text color={theme.dim}>Ctrl+T</Text>
      </Box>

      {mode === 'file' ? (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={fileField === 'path' ? theme.primary : theme.muted} bold={fileField === 'path'}>
              {t(lang, '文件路径 (支持 ~, /, \\, C:\\... 及拖拽路径)', 'File Path (supports ~, /, \\, C:\\... & drag-drop)')}
            </Text>
            {detectedFmt ? <Badge label={detectedFmt.toUpperCase()} tone="success" variant="soft" /> : null}
          </Box>
          <TextInput
            value={filePath}
            onChange={setFilePath}
            onTab={handleTabComplete}
            onSubmit={() => void submitFileImport()}
            onCancel={onClose}
            placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\lecture.pdf' : '~/Documents/lecture.pdf'}
            width={Math.max(20, innerWidth - 4)}
            isActive={isActive && !busy && fileField === 'path'}
            prompt={promptGlyph}
          />

          {matches.length > 0 && fileField === 'path' ? (
            <Box flexDirection="column" marginTop={0} marginBottom={1}>
              <Text color={theme.dim}>
                {t(lang, 'Tab 候选:', 'Matches:')} {matches.join('  ')}
              </Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text color={fileField === 'title' ? theme.primary : theme.muted} bold={fileField === 'title'}>
              {t(lang, '自定义标题 (可选，留空用文件名)', 'Custom Title (optional)')}
            </Text>
          </Box>
          <TextInput
            value={fileTitle}
            onChange={setFileTitle}
            onSubmit={() => void submitFileImport()}
            onCancel={onClose}
            placeholder={t(lang, '留空自动使用文件名', 'Leave blank to use filename')}
            width={Math.max(20, innerWidth - 4)}
            isActive={isActive && !busy && fileField === 'title'}
            prompt={promptGlyph}
          />

          <Box marginTop={1}>
            <Text color={fileField === 'course' ? theme.primary : theme.muted} bold={fileField === 'course'}>
              {t(lang, '所属课程 (可选)', 'Course (optional)')}
            </Text>
          </Box>
          <TextInput
            value={fileCourse}
            onChange={setFileCourse}
            onSubmit={() => void submitFileImport()}
            onCancel={onClose}
            placeholder={t(lang, '例如：线性代数', 'e.g. Linear Algebra')}
            width={Math.max(20, innerWidth - 4)}
            isActive={isActive && !busy && fileField === 'course'}
            prompt={promptGlyph}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color={textField === 'title' ? theme.primary : theme.muted} bold={textField === 'title'}>
            {t(lang, '资料标题', 'Title')}
          </Text>
          <TextInput
            value={textTitle}
            onChange={setTextTitle}
            onSubmit={() => setTextField('body')}
            onCancel={onClose}
            placeholder={t(lang, '例如：第3章课堂笔记', 'e.g. Chapter 3 Notes')}
            width={Math.max(20, innerWidth - 4)}
            isActive={isActive && !busy && textField === 'title'}
            prompt={promptGlyph}
          />

          <Box flexDirection="row" marginTop={1}>
            <Text color={textField === 'format' ? theme.primary : theme.muted} bold={textField === 'format'}>
              {t(lang, '格式 (Space 切换): ', 'Format (Space): ')}
            </Text>
            <Badge label="Markdown (md)" tone={textFormat === 'md' ? 'primary' : 'muted'} variant={textFormat === 'md' ? 'solid' : 'outline'} />
            <Text> </Text>
            <Badge label="Plain Text (txt)" tone={textFormat === 'txt' ? 'primary' : 'muted'} variant={textFormat === 'txt' ? 'solid' : 'outline'} />
          </Box>

          <Box marginTop={1}>
            <Text color={textField === 'course' ? theme.primary : theme.muted} bold={textField === 'course'}>
              {t(lang, '所属课程 (可选)', 'Course (optional)')}
            </Text>
          </Box>
          <TextInput
            value={textCourse}
            onChange={setTextCourse}
            onSubmit={() => setTextField('body')}
            onCancel={onClose}
            placeholder={t(lang, '例如：数据结构', 'e.g. Data Structures')}
            width={Math.max(20, innerWidth - 4)}
            isActive={isActive && !busy && textField === 'course'}
            prompt={promptGlyph}
          />

          <Box marginTop={1}>
            <Text color={textField === 'body' ? theme.primary : theme.muted} bold={textField === 'body'}>
              {t(lang, '正文内容 (Ctrl+S 保存导入)', 'Content (Ctrl+S to save)')}
            </Text>
          </Box>
          <TextInput
            value={textBody}
            onChange={setTextBody}
            onSubmit={() => void submitTextImport()}
            onCancel={onClose}
            placeholder={t(lang, `粘贴讲义、笔记或知识点原文${ell}`, `Paste notes, slides or study material${ell}`)}
            multiline
            height={5}
            width={Math.max(20, innerWidth - 4)}
            isActive={isActive && !busy && textField === 'body'}
          />
        </Box>
      )}

      {busy ? (
        <Box marginTop={1}>
          <Spinner label={t(lang, `正在解析并导入资料${ell}`, `Importing material${ell}`)} />
        </Box>
      ) : null}
      {err ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{`${asciiMode ? 'x' : '✕'} ${err}`}</Text>
        </Box>
      ) : null}
    </Modal>
  );
});

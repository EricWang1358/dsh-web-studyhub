import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { BookNode, BookOpenResult, FlatTocItem } from './types.js';

export interface BookEditModalProps {
  host: HostClient;
  course: string | null;
  selectedItem?: FlatTocItem | null;
  bookData?: BookOpenResult | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onSaved?: () => void;
}

interface BookSuggestionItem {
  id: string;
  text: string;
  kind?: 'generated' | 'theirs' | string;
}

interface BookFileMeta {
  version: number;
  forked?: boolean;
  suggestions?: BookSuggestionItem[];
}

interface BookNodeWithMeta extends BookNode {
  suggestions?: BookSuggestionItem[];
}

interface BookOpenFull extends BookOpenResult {
  files?: Record<string, BookFileMeta>;
  history?: Record<string, number>;
  write?: string;
}

type EditableSlot = 'gen' | 'mine';
type EditorFocus = 'editor' | 'actions';

function findNode(
  nodes: BookNode[] | undefined,
  key: string | undefined,
  hid: string | undefined,
): BookNodeWithMeta | null {
  for (const node of nodes ?? []) {
    if ((hid && node.hid === hid) || (key && node.key === key)) {
      return node as BookNodeWithMeta;
    }
    if (node.children?.length) {
      const found = findNode(node.children, key, hid);
      if (found) return found;
    }
  }
  return null;
}

function firstPreviewLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean) return clean;
  }
  return '';
}

function isConflictResponse(code: string | undefined, message: string | undefined): boolean {
  if (code === 'course-book-conflict') return true;
  if (!message) return false;
  return /conflict|changed|updated elsewhere|书已更新|改过/i.test(message);
}

export const BookEditModal = memo(function BookEditModal({
  host,
  course,
  selectedItem,
  bookData,
  isActive,
  width,
  height,
  onClose,
  onSaved,
}: BookEditModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);

  const initialFull = bookData as BookOpenFull | null | undefined;
  const [openData, setOpenData] = useState<BookOpenFull | null>(() => (initialFull ? initialFull : null));
  const [loading, setLoading] = useState(() => !initialFull);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slot, setSlot] = useState<EditableSlot>('gen');
  const [focus, setFocus] = useState<EditorFocus>('editor');
  const [text, setText] = useState('');
  const [loadedText, setLoadedText] = useState('');
  const [loadedVersion, setLoadedVersion] = useState<number>(1);
  const [busy, setBusy] = useState<'save' | 'revert' | 'suggestion' | 'reload' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] = useState<null | 'close' | 'reload' | 'accept'>(null);
  const confirmDiscard = pendingDiscardAction !== null;

  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const hydratedFileRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const effectiveCourse = openData?.course ?? course ?? null;
  const courseArgs = useMemo(
    () => (effectiveCourse !== null && effectiveCourse !== undefined ? { course: effectiveCourse } : {}),
    [effectiveCourse],
  );

  const targetNode = useMemo(() => {
    if (!selectedItem) return null;
    if (openData?.status === 'ok') {
      const matched = findNode(openData.nodes, selectedItem.key, selectedItem.hid);
      if (matched) return matched;
    }
    return (selectedItem.node as BookNodeWithMeta | undefined) ?? null;
  }, [openData, selectedItem]);

  const fileTargets = useMemo(() => {
    if (!selectedItem || !selectedItem.leaf) return null;
    const rawId = selectedItem.key?.startsWith('bk:') ? selectedItem.key.slice(3) : '';
    const gen = targetNode?.files?.gen || (rawId ? `${rawId}.gen.md` : '');
    const mine = targetNode?.files?.mine || (rawId ? `${rawId}.mine.md` : '');
    if (!gen && !mine) return null;
    return { gen, mine };
  }, [selectedItem, targetNode]);

  const activeFile = useMemo(() => {
    if (!fileTargets) return '';
    if (slot === 'mine' && fileTargets.mine) return fileTargets.mine;
    return fileTargets.gen || fileTargets.mine;
  }, [fileTargets, slot]);

  const canSwitchSlot = Boolean(fileTargets?.gen && fileTargets?.mine);
  const dirty = text !== loadedText;
  dirtyRef.current = dirty;

  const syncFromBook = useCallback(
    (doc: BookOpenFull, fileKey: string, opts?: { preserveEditorText?: boolean }) => {
      setOpenData(doc);
      const node = selectedItem ? findNode(doc.nodes, selectedItem.key, selectedItem.hid) : null;
      const meta = fileKey ? doc.files?.[fileKey] : undefined;
      const nextVer = typeof meta?.version === 'number' ? meta.version : 1;
      const fileText =
        fileKey.endsWith('.mine.md')
          ? (node?.mine ?? '')
          : (node?.gen ?? '');
      setLoadedVersion(nextVer);
      if (!opts?.preserveEditorText) {
        setText(fileText);
        setLoadedText(fileText);
        hydratedFileRef.current = fileKey;
      }
    },
    [selectedItem],
  );

  // Hydrate initial open state & fresh file versions/suggestions/history from host.
  useEffect(() => {
    let cancelled = false;
    const args = course !== null && course !== undefined ? { course } : {};
    void tryAction<BookOpenFull>(host, 'course.book.open', { ...args, language: lang }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      setLoading(false);
      if (!res.ok || !res.value) {
        if (!openData) {
          setLoadError(res.error?.message || t(lang, '无法读取复习全书', 'Failed to open review book'));
        }
        return;
      }
      setLoadError(null);
      setOpenData(res.value);
      const node = selectedItem ? findNode(res.value.nodes, selectedItem.key, selectedItem.hid) : null;
      const rawId = selectedItem?.key?.startsWith('bk:') ? selectedItem.key.slice(3) : '';
      const resolvedFile =
        slot === 'mine'
          ? (node?.files?.mine || (rawId ? `${rawId}.mine.md` : ''))
          : (node?.files?.gen || (rawId ? `${rawId}.gen.md` : ''));
      if (resolvedFile && !dirtyRef.current) {
        syncFromBook(res.value, resolvedFile);
      }
    });
    return () => {
      cancelled = true;
    };
    // Run once on mount (or when course/lang changes) so we don't clobber edits mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, course, lang]);

  // Synchronize text buffer when activeFile changes cleanly (e.g. initial mount with bookData or slot switch).
  useEffect(() => {
    if (!activeFile || !openData || openData.status !== 'ok') return;
    if (hydratedFileRef.current === activeFile) return;
    syncFromBook(openData, activeFile);
  }, [activeFile, openData, syncFromBook]);

  const fileMeta = activeFile ? openData?.files?.[activeFile] : undefined;
  const historyCount = activeFile ? (openData?.history?.[activeFile] ?? 0) : 0;
  const suggestions = useMemo(() => {
    if (fileMeta?.suggestions?.length) return fileMeta.suggestions;
    if (slot === 'gen' && targetNode?.suggestions?.length) return targetNode.suggestions;
    return [];
  }, [fileMeta?.suggestions, slot, targetNode?.suggestions]);
  const topSuggestion = suggestions[0] ?? null;
  const isForked = Boolean(fileMeta?.forked);
  const canEdit = openData?.status === 'ok' && Boolean(activeFile);

  const reloadBook = useCallback(async () => {
    if (savingRef.current || busy) return;
    savingRef.current = true;
    setBusy('reload');
    setError(null);
    try {
      const res = await tryAction<BookOpenFull>(host, 'course.book.open', { ...courseArgs, language: lang });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '重新加载失败', 'Reload failed'));
        return;
      }
      setConflictNotice(null);
      setStatusNote(t(lang, '已加载最新版本', 'Reloaded latest version'));
      if (activeFile) {
        syncFromBook(res.value, activeFile);
      } else {
        setOpenData(res.value);
      }
      notify(t(lang, '已刷新本节最新内容与版本号', 'Reloaded latest section content and version'), 'info');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [activeFile, busy, courseArgs, host, lang, notify, syncFromBook]);

  const handleSave = useCallback(
    async (textOverride?: string) => {
      if (savingRef.current || busy || !activeFile) return;
      const nextText = typeof textOverride === 'string' ? textOverride : text;
      savingRef.current = true;
      setBusy('save');
      setError(null);
      setStatusNote(null);
      try {
        const res = await tryAction<BookOpenFull>(host, 'course.book.save', {
          ...courseArgs,
          file: activeFile,
          text: nextText,
          version: loadedVersion,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '保存失败', 'Failed to save');
          if (isConflictResponse(res.error?.code, res.error?.message)) {
            const notice = t(
              lang,
              '版本冲突：文件已在别处更新，未覆盖远端改动。请按 Tab 切到操作栏后按 [r] 重载再保存。',
              'Stale version conflict: file changed elsewhere. Not overwritten — press Tab then [r] to reload.',
            );
            setConflictNotice(notice);
            notify(notice, 'warning');
          } else {
            setError(msg);
            notify(msg, 'error');
          }
          return;
        }

        const savedDoc = res.value;
        const nextVer = savedDoc.files?.[activeFile]?.version ?? loadedVersion + 1;
        setOpenData(savedDoc);
        setLoadedVersion(nextVer);
        setText(nextText);
        setLoadedText(nextText);
        hydratedFileRef.current = activeFile;

        if (savedDoc.write === 'merged') {
          const notice = t(
            lang,
            `检测到版本冲突：已保留你的编辑 (v${nextVer})，原更新版已存为上方待审阅建议（[a] 采用 / [i] 忽略 / [r] 重载）。`,
            `Version conflict: kept your edits (v${nextVer}) and queued the other version as a suggestion ([a] accept / [i] ignore / [r] reload).`,
          );
          setConflictNotice(notice);
          notify(notice, 'warning');
          onSaved?.();
        } else if (savedDoc.write === 'unchanged') {
          setConflictNotice(null);
          setStatusNote(t(lang, '内容与当前版本一致，无需保存', 'No changes to save'));
          notify(t(lang, '内容无变化', 'No changes to save'), 'info');
        } else {
          setConflictNotice(null);
          const okMsg = t(lang, `已保存 ${activeFile} (v${nextVer})`, `Saved ${activeFile} (v${nextVer})`);
          setStatusNote(okMsg);
          notify(okMsg, 'success');
          onSaved?.();
        }
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        notify(msg, 'error');
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setBusy(null);
      }
    },
    [activeFile, busy, courseArgs, host, lang, loadedVersion, notify, onSaved, text],
  );

  const handleRevert = useCallback(async () => {
    if (savingRef.current || busy || !activeFile) return;
    savingRef.current = true;
    setBusy('revert');
    setError(null);
    setStatusNote(null);
    try {
      const res = await tryAction<BookOpenFull>(host, 'course.book.revert', {
        ...courseArgs,
        file: activeFile,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        const msg = res.error?.message || t(lang, '回退失败', 'Revert failed');
        if (isConflictResponse(res.error?.code, res.error?.message)) {
          setConflictNotice(msg);
          notify(msg, 'warning');
        } else {
          setError(msg);
          notify(msg, 'error');
        }
        return;
      }
      setConflictNotice(null);
      syncFromBook(res.value, activeFile);
      const nextVer = res.value.files?.[activeFile]?.version ?? loadedVersion + 1;
      const okMsg = t(lang, `已回退 ${activeFile} 至上一版本 (v${nextVer})`, `Reverted ${activeFile} (v${nextVer})`);
      setStatusNote(okMsg);
      notify(okMsg, 'success');
      onSaved?.();
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, 'error');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [activeFile, busy, courseArgs, host, lang, loadedVersion, notify, onSaved, syncFromBook]);

  const handleSuggestion = useCallback(
    async (action: 'accept' | 'ignore') => {
      if (savingRef.current || busy || !activeFile || !topSuggestion) return;
      savingRef.current = true;
      setBusy('suggestion');
      setError(null);
      setStatusNote(null);
      try {
        const res = await tryAction<BookOpenFull>(host, 'course.book.suggestion', {
          ...courseArgs,
          file: activeFile,
          ...(topSuggestion.id ? { id: topSuggestion.id } : {}),
          action,
          version: loadedVersion,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '处理建议失败', 'Suggestion action failed');
          if (isConflictResponse(res.error?.code, res.error?.message)) {
            const notice = t(
              lang,
              '书已更新，请先按 [r] 重载最新内容后再决定是否采用/忽略建议。',
              'Book changed elsewhere — press [r] to reload before accepting/ignoring.',
            );
            setConflictNotice(notice);
            notify(notice, 'warning');
          } else {
            setError(msg);
            notify(msg, 'error');
          }
          return;
        }
        setConflictNotice(null);
        const updatedDoc = res.value;
        if (action === 'accept') {
          syncFromBook(updatedDoc, activeFile);
          const msg = t(lang, `已采用建议并更新 ${activeFile}`, `Accepted suggestion for ${activeFile}`);
          setStatusNote(msg);
          notify(msg, 'success');
        } else {
          syncFromBook(updatedDoc, activeFile, { preserveEditorText: true });
          const msg = t(lang, '已忽略该建议', 'Ignored suggestion');
          setStatusNote(msg);
          notify(msg, 'info');
        }
        onSaved?.();
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        notify(msg, 'error');
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setBusy(null);
      }
    },
    [activeFile, busy, courseArgs, host, lang, loadedVersion, notify, onSaved, syncFromBook, topSuggestion],
  );

  const switchSlot = useCallback(() => {
    if (!canSwitchSlot || !openData) return;
    if (dirty) {
      setError(
        t(
          lang,
          '当前文件有未保存修改，请先按 Ctrl+S 保存或按 [r] 重载后再切换文件',
          'Unsaved changes in current file — Ctrl+S to save or [r] to discard before switching',
        ),
      );
      return;
    }
    const nextSlot: EditableSlot = slot === 'gen' ? 'mine' : 'gen';
    const nextFile = nextSlot === 'mine' ? fileTargets!.mine : fileTargets!.gen;
    setError(null);
    setConflictNotice(null);
    setStatusNote(null);
    setSlot(nextSlot);
    syncFromBook(openData, nextFile);
  }, [canSwitchSlot, dirty, fileTargets, lang, openData, slot, syncFromBook]);

  const requestClose = useCallback(() => {
    if (busy || confirmRevert || confirmDiscard) return;
    if (dirtyRef.current) {
      setPendingDiscardAction('close');
      return;
    }
    onClose();
  }, [busy, confirmDiscard, confirmRevert, onClose]);

  useInput(
    (input, key) => {
      if (busy || confirmRevert || confirmDiscard || !canEdit) return;
      if (key.tab) {
        setFocus((f) => (f === 'editor' ? 'actions' : 'editor'));
        return;
      }
      if (key.ctrl && input === 's') {
        // Multiline TextInput already invokes onSubmit -> handleSave on Ctrl+S when editor is active.
        if (focus !== 'editor') {
          void handleSave();
        }
        return;
      }
      if (focus === 'actions') {
        if (input === 'u' || (key.ctrl && input === 'u')) {
          setConfirmRevert(true);
          return;
        }
        if (input === 'a' && topSuggestion) {
          if (dirtyRef.current) {
            setPendingDiscardAction('accept');
          } else {
            void handleSuggestion('accept');
          }
          return;
        }
        if (input === 'i' && topSuggestion) {
          void handleSuggestion('ignore');
          return;
        }
        if (input === 'f' && canSwitchSlot) {
          switchSlot();
          return;
        }
        if (input === 'r') {
          if (dirtyRef.current) {
            setPendingDiscardAction('reload');
          } else {
            void reloadBook();
          }
          return;
        }
        if (key.return || input === 'e') {
          setFocus('editor');
        }
      }
    },
    { isActive: isActive && !busy && !confirmRevert && !confirmDiscard && !loading && canEdit },
  );

  const frameW = Math.max(48, Math.min(104, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const editorWidth = Math.max(12, innerW - 4);
  const bodyH = Math.max(8, frameH - 5);
  const ell = asciiMode ? '...' : '…';

  const bannerRows = topSuggestion ? 2 : 0;
  const noticeRows = conflictNotice || error || statusNote ? 1 : 0;
  const editorHeight = Math.max(4, bodyH - (2 + 1 + bannerRows + noticeRows + 2));

  const hints = useMemo<KeyHint[]>(() => {
    if (!canEdit) return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    if (focus === 'actions') {
      return [
        { key: 'Tab', label: t(lang, '编辑正文', 'Edit') },
        { key: 'u', label: t(lang, '回退', 'Revert') },
        ...(topSuggestion
          ? [
              { key: 'a', label: t(lang, '采用建议', 'Accept') },
              { key: 'i', label: t(lang, '忽略', 'Ignore') },
            ]
          : []),
        ...(canSwitchSlot ? [{ key: 'f', label: t(lang, '切文件', 'File') }] : []),
        { key: 'r', label: t(lang, '重载', 'Reload') },
        { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
      {
        key: 'Tab',
        label: topSuggestion
          ? t(lang, '操作/审阅建议', 'Actions/Suggest')
          : t(lang, '操作栏(回退/切文件)', 'Actions(Revert/File)'),
      },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [canEdit, canSwitchSlot, focus, lang, topSuggestion]);

  const sectionLabel = selectedItem
    ? `${selectedItem.number} ${selectedItem.title}`
    : t(lang, '复习全书编辑', 'Edit Review Book');

  const emptyInfo = useMemo(() => {
    if (loadError) {
      return {
        title: t(lang, '无法打开复习全书', 'Cannot open review book'),
        hint: loadError,
      };
    }
    if (openData?.status === 'rebuild-pending') {
      return {
        title: t(lang, '总纲重组待确认', 'Outline rebuild pending'),
        hint: t(lang, '关闭弹窗后按 [g] 先应用新总纲结构，再编辑本节。', 'Close and press [g] to apply the rebuilt outline first.'),
      };
    }
    if (!openData || openData.status !== 'ok') {
      return {
        title:
          openData?.reason === 'no-course'
            ? t(lang, '请先选择一门课程', 'Select a course first')
            : t(lang, '这门课还没有复习全书', 'No review book for this course yet'),
        hint:
          openData?.reason === 'no-course'
            ? t(lang, '关闭弹窗后按 [c] 选择课程', 'Close and press [c] to pick a course')
            : t(lang, '请先在复习全书页面按 [g] 生成课程总纲与讲义', 'Press [g] in Book view to build the outline and review book'),
      };
    }
    if (!selectedItem) {
      return {
        title: t(lang, '未选中知识点', 'No section selected'),
        hint: t(lang, '请在左侧目录选择一个知识点后再按 [e] 编辑。', 'Select a knowledge point in the TOC then press [e].'),
      };
    }
    return {
      title: t(lang, '当前章节行没有可编辑文件', 'Selected row has no editable file'),
      hint: t(
        lang,
        '章节标题仅用于目录分组；请上下移动选择一个具体知识点（叶子节点）再按 [e] 编辑。',
        'Chapter rows are headings only; select a leaf knowledge point and press [e] to edit.',
      ),
    };
  }, [loadError, openData, selectedItem, lang]);

  return (
    <Modal
      title={t(lang, '编辑复习全书', 'Edit Review Book')}
      subtitle={truncateDisplay(sectionLabel, Math.max(12, Math.floor(innerW * 0.5)), ell)}
      icon={asciiMode ? '#' : '✎'}
      tone="primary"
      width={frameW}
      height={frameH}
      onClose={busy || confirmRevert || confirmDiscard ? undefined : requestClose}
      isActive={isActive && !confirmRevert && !confirmDiscard}
      hints={hints}
    >
      {loading ? (
        <Box height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在读取本节文件${ell}`, `Loading section file${ell}`)} active={isActive} />
        </Box>
      ) : !canEdit ? (
        <EmptyState
          icon={asciiMode ? '!' : '▣'}
          title={emptyInfo.title}
          hint={emptyInfo.hint}
          actions={[{ key: 'Esc', label: t(lang, '关闭', 'Close') }]}
          width={innerW}
          height={bodyH}
        />
      ) : (
        <Box flexDirection="column" width={innerW} height={bodyH} overflow="hidden">
          {/* Row 1: File path, version & state badges */}
          <Box height={1} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
            <Box gap={1} overflow="hidden">
              <Text color={theme.primary} bold>
                {truncateDisplay(activeFile, Math.max(12, Math.floor(innerW * 0.45)), ell)}
              </Text>
              <Badge label={`v${loadedVersion}`} tone="info" variant="soft" />
              {isForked ? <Badge label={t(lang, '已修改基线', 'Forked')} tone="accent" variant="outline" /> : null}
              {dirty ? <Badge label={t(lang, '未保存', 'Modified')} tone="warning" variant="solid" /> : null}
              {historyCount > 0 ? (
                <Badge label={t(lang, `历史 ${historyCount}`, `Hist ${historyCount}`)} tone="neutral" variant="soft" />
              ) : null}
            </Box>
            <Box flexShrink={0}>
              {busy ? (
                <Spinner
                  label={
                    busy === 'save'
                      ? t(lang, `保存中${ell}`, `Saving${ell}`)
                      : busy === 'revert'
                        ? t(lang, `回退中${ell}`, `Reverting${ell}`)
                        : busy === 'suggestion'
                          ? t(lang, `处理中${ell}`, `Applying${ell}`)
                          : t(lang, `重载中${ell}`, `Reloading${ell}`)
                  }
                  active={isActive}
                />
              ) : null}
            </Box>
          </Box>

          {/* Row 2: Focus / Actions bar */}
          <Box height={1} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
            <Box gap={1} overflow="hidden">
              <Text color={focus === 'actions' ? theme.primary : theme.muted} bold={focus === 'actions'}>
                {focus === 'actions'
                  ? t(lang, '[操作栏 · Tab 切回正文]', '[Actions · Tab to edit]')
                  : t(lang, '[编辑中 · Tab 切到操作栏]', '[Editing · Tab for actions]')}
              </Text>
              <Text color={focus === 'actions' ? theme.warning : theme.dim}>
                {t(lang, '[u] 回退', '[u] Revert')}
              </Text>
              {canSwitchSlot ? (
                <Text color={focus === 'actions' ? theme.accent : theme.dim}>
                  {slot === 'gen' ? t(lang, '[f] 切我的笔记', '[f] Mine') : t(lang, '[f] 切讲义正文', '[f] Gen')}
                </Text>
              ) : null}
              <Text color={focus === 'actions' ? theme.info : theme.dim}>
                {t(lang, '[r] 重载', '[r] Reload')}
              </Text>
            </Box>
            <Text color={theme.dim}>
              {truncateDisplay(
                slot === 'gen' ? t(lang, '讲义 (.gen.md)', 'Section (.gen.md)') : t(lang, '笔记 (.mine.md)', 'Notes (.mine.md)'),
                Math.max(10, Math.floor(innerW * 0.3)),
                ell,
              )}
            </Text>
          </Box>

          <Divider width={innerW} />

          {/* Optional Pending Suggestion Banner (2 rows) */}
          {topSuggestion ? (
            <Box flexDirection="column" height={2} width={innerW} overflow="hidden" flexShrink={0}>
              <Box height={1} flexDirection="row" justifyContent="space-between" overflow="hidden">
                <Box gap={1} overflow="hidden">
                  <Badge
                    label={
                      topSuggestion.kind === 'theirs'
                        ? t(lang, '并发更新待审阅', 'Concurrent Update')
                        : t(lang, `AI 新版建议 (${suggestions.length})`, `AI Suggestion (${suggestions.length})`)
                    }
                    tone="warning"
                    variant="solid"
                  />
                  <Text color={focus === 'actions' ? theme.success : theme.muted} bold={focus === 'actions'}>
                    {t(lang, '[a] 采用', '[a] Accept')}
                  </Text>
                  <Text color={focus === 'actions' ? theme.error : theme.muted} bold={focus === 'actions'}>
                    {t(lang, '[i] 忽略', '[i] Ignore')}
                  </Text>
                </Box>
                <Text color={theme.dim}>
                  {focus === 'editor' ? t(lang, '按 Tab 审阅', 'Tab to review') : ''}
                </Text>
              </Box>
              <Box height={1} overflow="hidden">
                <Text color={theme.muted}>
                  {truncateDisplay(
                    `${asciiMode ? '>' : '›'} ${firstPreviewLine(topSuggestion.text) || t(lang, '(空文本建议)', '(empty suggestion)')}`,
                    innerW,
                    ell,
                  )}
                </Text>
              </Box>
            </Box>
          ) : null}

          {/* Multiline Markdown Editor */}
          <Box
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={focus === 'editor' ? theme.borderActive : theme.border}
            paddingX={1}
            width={innerW}
            flexShrink={0}
          >
            <TextInput
              value={text}
              onChange={setText}
              onSubmit={(val) => void handleSave(val)}
              onCancel={busy || confirmRevert || confirmDiscard ? undefined : requestClose}
              multiline
              height={editorHeight}
              width={editorWidth}
              isActive={isActive && focus === 'editor' && !busy && !confirmRevert && !confirmDiscard && !loading && canEdit}
              placeholder={t(lang, '输入 Markdown 正文，Ctrl+S 保存…', 'Write Markdown, Ctrl+S to save…')}
              captureInput={false}
            />
          </Box>

          {/* Optional Conflict / Error / Status line (1 row) */}
          {conflictNotice ? (
            <Box height={1} overflow="hidden" flexShrink={0}>
              <Text color={theme.warning} bold>
                {`${asciiMode ? '!' : '▲'} ${truncateDisplay(conflictNotice, Math.max(10, innerW - 3), ell)}`}
              </Text>
            </Box>
          ) : error ? (
            <Box height={1} overflow="hidden" flexShrink={0}>
              <Text color={theme.error}>
                {`${asciiMode ? '!' : '✕'} ${error}`}
              </Text>
            </Box>
          ) : statusNote ? (
            <Box height={1} overflow="hidden" flexShrink={0}>
              <Text color={theme.success}>
                {`${asciiMode ? '+' : '✓'} ${truncateDisplay(statusNote, Math.max(10, innerW - 3), ell)}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      )}

      {confirmRevert ? (
        <ConfirmDialog
          title={t(lang, '回退到上一版本', 'Revert to Previous Version')}
          message={t(
            lang,
            `确定将「${activeFile}」回退到上一个版本吗？当前内容会存入版本历史。`,
            `Revert "${activeFile}" to its previous version? Current text will be kept in history.`,
          )}
          confirmLabel={t(lang, '回退', 'Revert')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && confirmRevert}
          onConfirm={() => {
            setConfirmRevert(false);
            void handleRevert();
          }}
          onCancel={() => setConfirmRevert(false)}
        />
      ) : null}

      {pendingDiscardAction ? (
        <ConfirmDialog
          title={
            pendingDiscardAction === 'reload'
              ? t(lang, '放弃修改并重载', 'Discard Changes & Reload')
              : pendingDiscardAction === 'accept'
                ? t(lang, '放弃修改并采用建议', 'Discard Changes & Accept')
                : t(lang, '放弃未保存的修改', 'Discard Unsaved Changes')
          }
          message={
            pendingDiscardAction === 'reload'
              ? t(
                  lang,
                  '有未保存的修改，重新加载将覆盖当前编辑内容，确定放弃并重载吗？',
                  'You have unsaved changes. Reloading will overwrite your current edits. Discard and reload?',
                )
              : pendingDiscardAction === 'accept'
                ? t(
                    lang,
                    '有未保存的修改，采用建议将覆盖当前编辑内容，确定放弃并采用吗？',
                    'You have unsaved changes. Accepting this suggestion will overwrite your current edits. Discard and accept?',
                  )
                : t(
                    lang,
                    '有未保存的修改，确定放弃并关闭吗？',
                    'You have unsaved changes. Discard and close?',
                  )
          }
          confirmLabel={
            pendingDiscardAction === 'reload'
              ? t(lang, '放弃并重载', 'Discard & Reload')
              : pendingDiscardAction === 'accept'
                ? t(lang, '放弃并采用', 'Discard & Accept')
                : t(lang, '放弃并关闭', 'Discard & Close')
          }
          cancelLabel={t(lang, '继续编辑', 'Keep Editing')}
          danger
          isActive={isActive && confirmDiscard}
          onConfirm={() => {
            const action = pendingDiscardAction;
            setPendingDiscardAction(null);
            if (action === 'close') {
              onClose();
            } else if (action === 'reload') {
              void reloadBook();
            } else if (action === 'accept') {
              void handleSuggestion('accept');
            }
          }}
          onCancel={() => setPendingDiscardAction(null)}
        />
      ) : null}
    </Modal>
  );
});

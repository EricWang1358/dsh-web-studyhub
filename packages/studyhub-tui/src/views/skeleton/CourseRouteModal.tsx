import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';

export interface CourseRouteModalProps {
  host: HostClient;
  activeCourse?: string | null;
  isActive: boolean;
  onClose: () => void;
}

export interface CourseRouteChapter {
  deckId: string;
  title: string;
  total: number;
  learned: number;
  weak: number;
  mastered: number;
  status: 'done' | 'current' | 'started' | 'upcoming' | string;
}

export interface CourseRouteNext {
  label: string;
  fresh: number;
  reviews: number;
}

export interface CourseRouteData {
  course: string | null;
  cards?: number;
  learned?: number;
  mastered?: number;
  weak?: number;
  current?: number | null;
  chapters: CourseRouteChapter[];
  next?: CourseRouteNext | null;
}

export const CourseRouteModal = memo(function CourseRouteModal({
  host,
  activeCourse,
  isActive,
  onClose,
}: CourseRouteModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const { columns, rows } = useStableWindowSize();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [starting, setStarting] = useState(false);
  const [route, setRoute] = useState<CourseRouteData | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const reqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const reqId = ++reqRef.current;
    setLoading(true);
    setError('');
    setActionError('');

    const args = activeCourse ? { course: activeCourse } : {};
    host
      .call<CourseRouteData>('course.route', args)
      .then((res) => {
        if (cancelled || !mountedRef.current || reqRef.current !== reqId) return;
        if (!res.ok) {
          setRoute(null);
          setError(res.error?.message || t(lang, '加载课程路线失败', 'Failed to load course route'));
          return;
        }
        const data = res.value ?? null;
        setRoute(data);
        const chapters = Array.isArray(data?.chapters) ? data.chapters : [];
        const curIdx = typeof data?.current === 'number' && data.current >= 0 && data.current < chapters.length ? data.current : 0;
        setSelectedIndex(curIdx);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current || reqRef.current !== reqId) return;
        setRoute(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled && mountedRef.current && reqRef.current === reqId) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [host, activeCourse, isActive, reloadSeq, lang]);

  const chapters = useMemo(
    () => (Array.isArray(route?.chapters) ? route.chapters : []),
    [route],
  );

  useEffect(() => {
    if (selectedIndex >= chapters.length) {
      setSelectedIndex(Math.max(0, chapters.length - 1));
    }
  }, [chapters.length, selectedIndex]);

  const startChapter = useCallback(
    async (chapter: CourseRouteChapter) => {
      if (busyRef.current || !chapter?.deckId) return;
      busyRef.current = true;
      setStarting(true);
      setActionError('');
      try {
        const res = await host.call<{ id?: string }>('review.start', {
          mode: 'path',
          deckId: chapter.deckId,
          fresh: true,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value?.id) {
          const msg = res.error?.message || t(lang, '启动章节练习失败', 'Failed to start chapter review');
          setActionError(msg);
          useTuiStore.getState().notify(msg, 'error');
          return;
        }
        const courseTarget = route?.course || activeCourse || undefined;
        onClose();
        useTuiStore.getState().navigate('review', {
          runId: res.value.id,
          ...(courseTarget ? { course: courseTarget } : {}),
        });
      } catch (err) {
        if (mountedRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          setActionError(msg);
          useTuiStore.getState().notify(msg, 'error');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setStarting(false);
      }
    },
    [host, lang, route?.course, activeCourse, onClose],
  );

  useInput(
    (input) => {
      if (!isActive || loading || starting) return;
      if (input === 'r') {
        setReloadSeq((n) => n + 1);
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (loading) return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    return [
      { key: 'j/k', label: t(lang, '选择', 'Select') },
      { key: 'Enter', label: t(lang, '开始章节', 'Start') },
      { key: 'r', label: t(lang, '刷新', 'Reload') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [lang, loading]);

  const frameW = Math.max(44, Math.min(84, columns - 4));
  const frameH = Math.max(13, Math.min(24, rows - 2));
  const innerW = modalContentWidth(frameW);
  const innerH = Math.max(6, frameH - 5);
  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' | ' : ' · ';

  const cards = route?.cards ?? 0;
  const learned = route?.learned ?? 0;
  const mastered = route?.mastered ?? 0;
  const weak = route?.weak ?? 0;
  const hasNext = Boolean(route?.next?.label);
  const headerRows = 3 + (hasNext ? 1 : 0) + (actionError || starting ? 1 : 0);
  const listH = Math.max(4, innerH - headerRows);

  const renderChapterRow = useCallback(
    (ch: CourseRouteChapter, ctx: VirtualListRenderContext) => {
      const pointer = ctx.selected ? (asciiMode ? '>' : '❯') : ' ';
      let badgeText: string;
      let badgeColor: string;
      if (ch.status === 'done') {
        badgeText = asciiMode ? '[OK]' : '[✔]';
        badgeColor = theme.success;
      } else if (ch.status === 'current') {
        badgeText = asciiMode ? '[>>]' : '[▶]';
        badgeColor = theme.primary;
      } else if (ch.status === 'started') {
        badgeText = asciiMode ? '[~]' : '[◐]';
        badgeColor = theme.warning;
      } else {
        badgeText = asciiMode ? '[ ]' : '[○]';
        badgeColor = theme.muted;
      }
      const paddedBadge = padDisplay(badgeText, 4);
      const weakText = ch.weak > 0 ? ` ${t(lang, '弱', 'W')}${ch.weak}` : '';
      const countText = `${ch.learned}/${ch.total}${weakText}`;
      const prefix = `${pointer} ${paddedBadge} `;
      const rightW = displayWidth(countText) + 1;
      const titleAvail = Math.max(8, ctx.width - displayWidth(prefix) - rightW);
      const titleText = padDisplay(truncateDisplay(ch.title, titleAvail, ell), titleAvail);
      return (
        <Box width={ctx.width} height={1} overflow="hidden">
          <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
            {`${pointer} `}
          </Text>
          <Text color={badgeColor} bold={ch.status === 'current' || ctx.selected}>
            {`${paddedBadge} `}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {titleText}
          </Text>
          <Text color={ch.weak > 0 ? theme.error : theme.muted}>{` ${countText}`}</Text>
        </Box>
      );
    },
    [asciiMode, ell, lang, theme],
  );

  const courseTitle = route?.course || activeCourse || t(lang, '当前课程', 'Current Course');

  return (
    <Modal
      title={t(lang, '课程学习路线', 'Course Route')}
      subtitle={courseTitle}
      icon={asciiMode ? '>' : '◈'}
      width={frameW}
      height={frameH}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      {loading ? (
        <Box height={innerH} width={innerW} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在加载课程路线...', 'Loading course route...')} active={isActive} />
        </Box>
      ) : error ? (
        <Box height={innerH} width={innerW} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
          <Text color={theme.error} bold>
            {t(lang, '加载路线失败', 'Failed to load route')}
          </Text>
          <Text color={theme.muted} wrap="wrap">{error}</Text>
        </Box>
      ) : chapters.length === 0 ? (
        <EmptyState
          icon={asciiMode ? 'o' : '◌'}
          title={t(lang, '暂无课程学习路线', 'No course route available')}
          hint={t(lang, '当前课程还没有可用题组或章节', 'No active chapters or decks in this course yet')}
          width={innerW}
          height={innerH}
        />
      ) : (
        <Box flexDirection="column" width={innerW} height={innerH}>
          <Box height={1} width={innerW} justifyContent="space-between" overflow="hidden">
            <Text color={theme.text} bold>
              {truncateDisplay(
                `${chapters.length}${t(lang, '章', ' ch')}${sep}${t(lang, '已学', 'Learned')} ${learned}/${cards}${sep}${t(lang, '掌握', 'Mastered')} ${mastered}`,
                Math.max(12, innerW - 10),
                ell,
              )}
            </Text>
            <Text color={weak > 0 ? theme.error : theme.success}>
              {t(lang, `薄弱 ${weak}`, `Weak ${weak}`)}
            </Text>
          </Box>
          <Box height={1} width={innerW} overflow="hidden">
            <ProgressBar
              ratio={cards > 0 ? learned / cards : 0}
              width={innerW}
              label={t(lang, '总进度', 'Route')}
            />
          </Box>
          {hasNext && route?.next ? (
            <Box height={1} width={innerW} overflow="hidden">
              <Text color={theme.accent}>
                {truncateDisplay(
                  `${t(lang, '下一批', 'Next')}: ${route.next.label} (${t(lang, `新题 ${route.next.fresh}`, `${route.next.fresh} new`)}${route.next.reviews > 0 ? `, ${t(lang, `巩固 ${route.next.reviews}`, `${route.next.reviews} rev`)}` : ''})`,
                  innerW,
                  ell,
                )}
              </Text>
            </Box>
          ) : null}
          <Box height={1} width={innerW} overflow="hidden">
            <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, innerW))}</Text>
          </Box>
          <VirtualList
            items={chapters}
            width={innerW}
            height={listH}
            selectedIndex={selectedIndex}
            onChange={(idx) => setSelectedIndex(idx)}
            onSelect={(ch) => void startChapter(ch)}
            isActive={isActive && !loading && !starting}
            keyExtractor={(ch) => ch.deckId}
            renderItem={renderChapterRow}
            ascii={asciiMode}
          />
          {starting ? (
            <Box height={1} width={innerW} overflow="hidden">
              <Spinner label={t(lang, '正在启动章节练习...', 'Starting chapter review...')} active={isActive} />
            </Box>
          ) : actionError ? (
            <Box width={innerW}>
              <Text color={theme.error} wrap="wrap">{actionError}</Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});

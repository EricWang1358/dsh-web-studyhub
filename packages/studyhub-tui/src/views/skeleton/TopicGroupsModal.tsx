import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import type { SkeletonNode } from './types.js';

export interface TopicGroupEntry {
  id: string;
  title: string;
  description?: string;
  count: number;
  decks?: number;
  topics: string[];
  updatedAt?: string;
}

export interface TopicListEntry {
  key: string;
  topic: string;
  count: number;
}

export interface SkeletonTopicsResponse {
  topics?: TopicListEntry[];
  groups?: {
    groups?: TopicGroupEntry[];
    ungrouped?: string[];
    updatedAt?: string;
  };
}

export interface TopicGroupsModalProps {
  host: HostClient;
  activeCourse?: string | null;
  isActive: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type ModalTab = 'groups' | 'create';
type CreateFocus = 'title' | 'topics';

export const TopicGroupsModal = memo(function TopicGroupsModal({
  host,
  activeCourse,
  isActive,
  onClose,
  onSaved,
}: TopicGroupsModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const { columns, rows } = useStableWindowSize();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<ModalTab>('groups');
  const [createFocus, setCreateFocus] = useState<CreateFocus>('title');
  const [topics, setTopics] = useState<TopicListEntry[]>([]);
  const [groups, setGroups] = useState<TopicGroupEntry[]>([]);
  const [ungroupedKeys, setUngroupedKeys] = useState<string[]>([]);
  const [groupCursor, setGroupCursor] = useState(0);
  const [topicCursor, setTopicCursor] = useState(0);
  const [title, setTitle] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [reloadSeq, setReloadSeq] = useState(0);

  const mountedRef = useRef(true);
  const reqRef = useRef(0);
  const savingRef = useRef(false);

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
    const args = activeCourse ? { course: activeCourse } : {};

    host
      .call<SkeletonTopicsResponse>('skeleton.topics', args)
      .then((res) => {
        if (cancelled || !mountedRef.current || reqRef.current !== reqId) return;
        if (!res.ok) {
          setError(res.error?.message || t(lang, '加载主题分组失败', 'Failed to load topic groups'));
          return;
        }
        const val = res.value;
        setTopics(Array.isArray(val?.topics) ? val.topics : []);
        setGroups(Array.isArray(val?.groups?.groups) ? val.groups.groups : []);
        setUngroupedKeys(Array.isArray(val?.groups?.ungrouped) ? val.groups.ungrouped : []);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current || reqRef.current !== reqId) return;
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

  const ownerByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      for (const k of g.topics ?? []) {
        map.set(k, g.title);
      }
    }
    return map;
  }, [groups]);

  const orderedTopics = useMemo(() => {
    const ungroupedSet = new Set(ungroupedKeys);
    return [...topics].sort((a, b) => {
      const aFree = ungroupedSet.has(a.key) ? 0 : 1;
      const bFree = ungroupedSet.has(b.key) ? 0 : 1;
      if (aFree !== bFree) return aFree - bFree;
      return b.count - a.count;
    });
  }, [topics, ungroupedKeys]);

  useEffect(() => {
    if (groupCursor >= groups.length) setGroupCursor(Math.max(0, groups.length - 1));
  }, [groups.length, groupCursor]);

  useEffect(() => {
    if (topicCursor >= orderedTopics.length) setTopicCursor(Math.max(0, orderedTopics.length - 1));
  }, [orderedTopics.length, topicCursor]);

  const toggleTopic = useCallback((key: string) => {
    setSaveError('');
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (savingRef.current || saving) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setSaveError(t(lang, '请输入分组名称', 'Please enter a group title'));
      setCreateFocus('title');
      return;
    }
    const keys = [...selectedKeys];
    if (keys.length === 0) {
      setSaveError(t(lang, '请按空格选择至少 1 个主题', 'Press Space to select at least 1 topic'));
      setCreateFocus('topics');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      const res = await host.call<SkeletonTopicsResponse['groups']>('topic.groups.save', {
        ...(activeCourse ? { course: activeCourse } : {}),
        mode: 'merge',
        groups: [{ title: trimmedTitle, topics: keys }],
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setSaveError(res.error?.message || t(lang, '保存主题分组失败', 'Failed to save topic group'));
        return;
      }
      setTitle('');
      setSelectedKeys(new Set());
      setTab('groups');
      setReloadSeq((n) => n + 1);
      useTuiStore.getState().notify(
        t(lang, `已保存主题分组「${trimmedTitle}」`, `Saved topic group "${trimmedTitle}"`),
        'success',
      );
      onSaved?.();
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [saving, title, selectedKeys, host, activeCourse, lang, onSaved]);

  useInput(
    (input, key) => {
      if (!isActive || loading || saving) return;
      if (key.ctrl && input === 's' && tab === 'create') {
        void handleSave();
        return;
      }
      if (key.tab) {
        if (tab === 'groups') {
          setTab('create');
          setCreateFocus('title');
          setSaveError('');
        } else if (key.shift) {
          if (createFocus === 'topics') setCreateFocus('title');
          else setTab('groups');
        } else if (createFocus === 'title') {
          setCreateFocus('topics');
        } else {
          setTab('groups');
        }
        return;
      }
      const inTitleInput = tab === 'create' && createFocus === 'title';
      if (inTitleInput) {
        if (key.downArrow) {
          setCreateFocus('topics');
        }
        return;
      }
      if (input === '1') {
        setTab('groups');
        return;
      }
      if (input === '2' || (tab === 'groups' && input === 'n')) {
        setTab('create');
        setCreateFocus('title');
        setSaveError('');
        return;
      }
      if (tab === 'groups' && input === 'r') {
        setReloadSeq((n) => n + 1);
        return;
      }
      if (tab === 'create' && createFocus === 'topics') {
        if (input === ' ') {
          const item = orderedTopics[topicCursor];
          if (item) toggleTopic(item.key);
        } else if (key.upArrow && topicCursor === 0) {
          setCreateFocus('title');
        }
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (loading) return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    if (tab === 'groups') {
      return [
        { key: '1/2', label: t(lang, '切换标签', 'Tab') },
        { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
        { key: 'r', label: t(lang, '刷新', 'Reload') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'Tab', label: t(lang, '切换焦点', 'Focus') },
      { key: 'Space', label: t(lang, '勾选', 'Toggle') },
      { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [lang, loading, tab]);

  const frameW = Math.max(46, Math.min(82, columns - 4));
  const frameH = Math.max(14, Math.min(24, rows - 2));
  const innerW = modalContentWidth(frameW);
  const innerH = Math.max(8, frameH - 5);
  const inputW = Math.max(12, innerW - 4);
  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' | ' : ' · ';

  const groupsListH = Math.max(4, innerH - 4);
  const topicsListH = Math.max(4, innerH - 7);

  const renderGroupRow = useCallback(
    (g: TopicGroupEntry, ctx: VirtualListRenderContext) => {
      const pointer = ctx.selected ? (asciiMode ? '>' : '❯') : ' ';
      const stats = `${g.topics.length}${t(lang, '主题', 'T')} ${g.count}${t(lang, '题', 'Q')}`;
      const prefix = `${pointer} `;
      const rightW = displayWidth(stats) + 1;
      const desc = g.description ? ` - ${g.description}` : '';
      const bodyAvail = Math.max(8, ctx.width - prefix.length - rightW);
      const bodyText = padDisplay(truncateDisplay(`${g.title}${desc}`, bodyAvail, ell), bodyAvail);
      return (
        <Box width={ctx.width} height={1} overflow="hidden">
          <Text color={ctx.selected ? theme.primary : theme.muted} bold={ctx.selected}>
            {prefix}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {bodyText}
          </Text>
          <Text color={theme.info}>{` ${stats}`}</Text>
        </Box>
      );
    },
    [asciiMode, ell, lang, theme],
  );

  const renderTopicRow = useCallback(
    (tp: TopicListEntry, ctx: VirtualListRenderContext) => {
      const pointer = ctx.selected ? (asciiMode ? '>' : '❯') : ' ';
      const checked = selectedKeys.has(tp.key);
      const checkBox = checked ? (asciiMode ? '[x]' : '[✓]') : '[ ]';
      const owner = ownerByKey.get(tp.key);
      const ownerTag = owner ? ` [${truncateDisplay(owner, 12, ell)}]` : '';
      const countText = `${tp.count}${t(lang, '题', 'Q')}${ownerTag}`;
      const prefix = `${pointer} ${checkBox} `;
      const rightW = displayWidth(countText) + 1;
      const avail = Math.max(8, ctx.width - prefix.length - rightW);
      const nameText = padDisplay(truncateDisplay(tp.topic, avail, ell), avail);
      return (
        <Box width={ctx.width} height={1} overflow="hidden">
          <Text color={ctx.selected ? theme.primary : theme.muted}>{`${pointer} `}</Text>
          <Text color={checked ? theme.success : theme.muted} bold={checked}>
            {`${checkBox} `}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {nameText}
          </Text>
          <Text color={owner ? theme.dim : theme.muted}>{` ${countText}`}</Text>
        </Box>
      );
    },
    [asciiMode, ell, lang, ownerByKey, selectedKeys, theme],
  );

  const titleFocusActive = isActive && !loading && !saving && tab === 'create' && createFocus === 'title';
  const topicsFocusActive = isActive && !loading && !saving && tab === 'create' && createFocus === 'topics';

  return (
    <Modal
      title={t(lang, '主题分组管理', 'Topic Groups')}
      subtitle={activeCourse || undefined}
      icon={asciiMode ? '#' : '▦'}
      width={frameW}
      height={frameH}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      {loading ? (
        <Box height={innerH} width={innerW} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在加载主题与分组...', 'Loading topics & groups...')} active={isActive} />
        </Box>
      ) : error ? (
        <Box height={innerH} width={innerW} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
          <Text color={theme.error} bold>
            {t(lang, '加载失败', 'Load failed')}
          </Text>
          <Text color={theme.muted} wrap="wrap">{error}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" width={innerW} height={innerH}>
          {/* Tab header */}
          <Box height={1} width={innerW} gap={2} overflow="hidden">
            <Text
              backgroundColor={tab === 'groups' ? theme.primary : theme.surface}
              color={tab === 'groups' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={tab === 'groups'}
            >
              {` [1] ${t(lang, '分组列表', 'Groups')} (${groups.length}) `}
            </Text>
            <Text
              backgroundColor={tab === 'create' ? theme.primary : theme.surface}
              color={tab === 'create' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={tab === 'create'}
            >
              {` [2] ${t(lang, '新建分组', 'New Group')} `}
            </Text>
          </Box>
          <Box height={1} width={innerW} overflow="hidden">
            <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, innerW))}</Text>
          </Box>

          {tab === 'groups' ? (
            <Box flexDirection="column" width={innerW} height={Math.max(5, innerH - 2)}>
              <Box height={1} width={innerW} justifyContent="space-between" overflow="hidden">
                <Text color={theme.text}>
                  {truncateDisplay(
                    `${t(lang, '已建分组', 'Groups')}: ${groups.length}${sep}${t(lang, '未分组主题', 'Ungrouped')}: ${ungroupedKeys.length}`,
                    innerW,
                    ell,
                  )}
                </Text>
              </Box>
              <Box height={1} width={innerW} overflow="hidden">
                <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, innerW))}</Text>
              </Box>
              {groups.length === 0 ? (
                <Box height={groupsListH} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
                  <Text color={theme.muted}>{t(lang, '还没有主题分组', 'No topic groups yet')}</Text>
                  <Text color={theme.dim}>
                    {truncateDisplay(
                      t(
                        lang,
                        `共有 ${ungroupedKeys.length} 个未分组主题；按 [Tab] 或 [2] 新建分组`,
                        `${ungroupedKeys.length} ungrouped topics; press [Tab] or [2] to create a group`,
                      ),
                      innerW,
                      ell,
                    )}
                  </Text>
                </Box>
              ) : (
                <VirtualList
                  items={groups}
                  width={innerW}
                  height={groupsListH}
                  selectedIndex={groupCursor}
                  onChange={(idx) => setGroupCursor(idx)}
                  isActive={isActive && tab === 'groups' && !loading}
                  keyExtractor={(g) => g.id}
                  renderItem={renderGroupRow}
                  ascii={asciiMode}
                />
              )}
            </Box>
          ) : (
            <Box flexDirection="column" width={innerW} height={Math.max(6, innerH - 2)}>
              <Box height={1} width={innerW} overflow="hidden">
                <Text color={createFocus === 'title' ? theme.primary : theme.muted} bold={createFocus === 'title'}>
                  {t(lang, '分组名称:', 'Group Title:')}
                </Text>
              </Box>
              <Box height={1} width={innerW} overflow="hidden">
                <TextInput
                  value={title}
                  onChange={(v) => {
                    setSaveError('');
                    setTitle(v);
                  }}
                  onSubmit={() => setCreateFocus('topics')}
                  placeholder={t(lang, '输入主题分组名称 (最多40字)', 'Enter group title (max 40 chars)')}
                  width={inputW}
                  maxLength={40}
                  prompt={asciiMode ? '>' : '›'}
                  isActive={titleFocusActive}
                />
              </Box>
              <Box height={1} width={innerW} justifyContent="space-between" overflow="hidden">
                <Text color={createFocus === 'topics' ? theme.primary : theme.muted} bold={createFocus === 'topics'}>
                  {t(lang, '选择包含主题 (Space 勾选):', 'Select Topics (Space to toggle):')}
                </Text>
                <Text color={selectedKeys.size > 0 ? theme.success : theme.muted}>
                  {t(lang, `已选 ${selectedKeys.size}`, `${selectedKeys.size} selected`)}
                </Text>
              </Box>
              <Box height={1} width={innerW} overflow="hidden">
                <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(4, innerW))}</Text>
              </Box>
              <VirtualList
                items={orderedTopics}
                width={innerW}
                height={topicsListH}
                selectedIndex={topicCursor}
                onChange={(idx) => setTopicCursor(idx)}
                onSelect={() => void handleSave()}
                isActive={topicsFocusActive}
                keyExtractor={(tp) => tp.key}
                renderItem={renderTopicRow}
                emptyText={t(lang, '当前范围暂无可用主题', 'No topics available in scope')}
                ascii={asciiMode}
              />
              <Box width={innerW}>
                {saving ? (
                  <Spinner label={t(lang, '正在保存分组...', 'Saving topic group...')} active={isActive} />
                ) : saveError ? (
                  <Text color={theme.error} wrap="wrap">{saveError}</Text>
                ) : (
                  <Text color={theme.dim}>
                    {truncateDisplay(
                      t(lang, '按 [Tab] 在标题与列表间切换，[Ctrl+S] 保存', 'Press [Tab] to switch focus, [Ctrl+S] to save'),
                      innerW,
                      ell,
                    )}
                  </Text>
                )}
              </Box>
            </Box>
          )}
        </Box>
      )}
    </Modal>
  );
});

export interface NodeEditModalProps {
  host: HostClient;
  skeletonId: string;
  node: SkeletonNode;
  isActive: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const NodeEditModal = memo(function NodeEditModal({
  host,
  skeletonId,
  node,
  isActive,
  onClose,
  onSaved,
}: NodeEditModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const { columns, rows } = useStableWindowSize();

  const [term, setTerm] = useState(node.term);
  const [meaning, setMeaning] = useState(node.meaning);
  const [field, setField] = useState<'term' | 'meaning'>('term');
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState('');

  const dirty = term !== node.term || meaning !== node.meaning;
  const requestClose = useCallback(() => {
    if (savingRef.current || saving) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [saving, dirty, onClose]);

  const mountedRef = useRef(true);
  const savingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setTerm(node.term);
    setMeaning(node.meaning);
    setField('term');
    setError('');
  }, [node.id, node.term, node.meaning]);

  const handleSave = useCallback(async () => {
    if (savingRef.current || saving) return;
    const nextTerm = term.trim();
    const nextMeaning = meaning.trim();
    if (!nextTerm) {
      setError(t(lang, '节点名称不能为空', 'Node term cannot be empty'));
      setField('term');
      return;
    }
    if (!nextMeaning) {
      setError(t(lang, '节点释义不能为空', 'Node meaning cannot be empty'));
      setField('meaning');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const res = await host.call('skeleton.patch', {
        id: skeletonId,
        ops: [
          {
            op: 'node.update',
            id: node.id,
            set: { term: nextTerm, meaning: nextMeaning },
          },
        ],
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(res.error?.message || t(lang, '更新节点失败', 'Failed to update node'));
        return;
      }
      useTuiStore.getState().notify(
        t(lang, `已更新节点「${nextTerm}」`, `Updated node "${nextTerm}"`),
        'success',
      );
      onSaved();
      onClose();
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [saving, term, meaning, lang, host, skeletonId, node.id, onSaved, onClose]);

  useInput(
    (input, key) => {
      if (!isActive || saving || confirmDiscard) return;
      if (key.ctrl && input === 's') {
        void handleSave();
        return;
      }
      if (key.tab || key.upArrow || key.downArrow) {
        setField((f) => (f === 'term' ? 'meaning' : 'term'));
      }
    },
    { isActive: isActive && !confirmDiscard },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Tab', label: t(lang, '切换字段', 'Field') },
      { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
      { key: 'Esc', label: dirty ? t(lang, '放弃/取消', 'Discard') : t(lang, '取消', 'Cancel') },
    ],
    [lang, dirty],
  );

  const frameW = Math.max(42, Math.min(72, columns - 6));
  const frameH = Math.max(11, Math.min(13, rows - 2));
  const innerW = modalContentWidth(frameW);
  const inputW = Math.max(12, innerW - 4);
  const ell = asciiMode ? '...' : '…';

  return (
    <>
    <Modal
      title={t(lang, '编辑知识节点', 'Edit Knowledge Node')}
      subtitle={dirty ? t(lang, '未保存', 'unsaved') : node.id}
      icon={asciiMode ? '*' : '✎'}
      width={frameW}
      height={frameH}
      isActive={isActive && !confirmDiscard}
      onClose={saving || confirmDiscard ? undefined : requestClose}
      hints={hints}
    >
      <Box flexDirection="column" width={innerW}>
        <Box height={1} width={innerW} overflow="hidden">
          <Text color={field === 'term' ? theme.primary : theme.muted} bold={field === 'term'}>
            {t(lang, '概念名称 (term):', 'Node Term:')}
          </Text>
        </Box>
        <Box height={1} width={innerW} overflow="hidden">
          <TextInput
            value={term}
            onChange={(v) => {
              setError('');
              setTerm(v);
            }}
            onSubmit={() => setField('meaning')}
            onCancel={requestClose}
            width={inputW}
            maxLength={80}
            prompt={asciiMode ? '>' : '›'}
            isActive={isActive && !saving && !confirmDiscard && field === 'term'}
          />
        </Box>
        <Box height={1} width={innerW} marginTop={1} overflow="hidden">
          <Text color={field === 'meaning' ? theme.primary : theme.muted} bold={field === 'meaning'}>
            {t(lang, '概念释义 (meaning):', 'Node Meaning:')}
          </Text>
        </Box>
        <Box height={1} width={innerW} overflow="hidden">
          <TextInput
            value={meaning}
            onChange={(v) => {
              setError('');
              setMeaning(v);
            }}
            onSubmit={() => void handleSave()}
            onCancel={requestClose}
            width={inputW}
            maxLength={300}
            prompt={asciiMode ? '>' : '›'}
            isActive={isActive && !saving && !confirmDiscard && field === 'meaning'}
          />
        </Box>
        <Box height={1} width={innerW} marginTop={1} overflow="hidden">
          {saving ? (
            <Spinner label={t(lang, '正在保存节点...', 'Saving node...')} active={isActive} />
          ) : error ? (
            <Text color={theme.error} wrap="wrap">{error}</Text>
          ) : (
            <Text color={theme.dim}>
              {truncateDisplay(
                t(lang, 'Enter 进入下一项/保存，Ctrl+S 直接保存', 'Enter for next/save, Ctrl+S to save'),
                innerW,
                ell,
              )}
            </Text>
          )}
        </Box>
      </Box>
    </Modal>

    {confirmDiscard ? (
      <ConfirmDialog
        title={t(lang, '放弃未保存的节点修改？', 'Discard unsaved node edits?')}
        message={t(
          lang,
          '当前知识节点的名称或释义尚未保存。放弃后将丢失这些修改。',
          'You have unsaved edits to this knowledge node. Closing now will discard them.',
        )}
        confirmLabel={t(lang, '放弃修改', 'Discard')}
        cancelLabel={t(lang, '继续编辑', 'Keep Editing')}
        danger
        isActive={isActive && confirmDiscard}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    ) : null}
    </>
  );
});

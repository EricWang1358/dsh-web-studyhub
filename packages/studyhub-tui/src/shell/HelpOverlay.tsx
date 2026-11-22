import React, { memo, useMemo } from 'react';
import { useInput, useWindowSize } from 'ink';
import defaultChalk, { Chalk, type ChalkInstance } from 'chalk';
import { PAGE_REGISTRY, type KeyHint } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { padDisplay, truncateDisplay } from '../render/index.js';
import { Modal, modalContentWidth } from '../components/Modal.js';
import { ScrollView } from '../components/ScrollView.js';
import { pageIcon } from './data.js';

const chalk: ChalkInstance = new Chalk({ level: defaultChalk.level });

export interface HelpOverlayProps {
  isActive: boolean;
  onClose: () => void;
  /** Extra page-specific shortcuts (defaults to the current footer hints). */
  pageHints?: readonly KeyHint[];
}

export interface ShortcutSection {
  title: string;
  items: readonly KeyHint[];
}

export function globalShortcuts(lang: 'zh' | 'en', asciiMode = false): KeyHint[] {
  return [
    { key: 'Ctrl+K  /', label: t(lang, '命令面板 / 全文搜题与原文', 'Command palette & search') },
    { key: '?', label: t(lang, '帮助', 'Help') },
    { key: 'c', label: t(lang, '切换课程', 'Switch course') },
    { key: 'I', label: t(lang, '收件箱与通知', 'Notification inbox') },
    { key: '1-9 0', label: t(lang, '跳转页面', 'Jump to page') },
    { key: '[  ]', label: t(lang, '上/下一页面', 'Prev / next page') },
    { key: asciiMode ? 'Bksp' : '⌫', label: t(lang, '返回', 'Back') },
    { key: '\\', label: t(lang, '折叠侧栏', 'Toggle sidebar') },
    { key: 'Ctrl+R', label: t(lang, '刷新', 'Refresh') },
    { key: 'q', label: t(lang, '退出', 'Quit') },
    { key: asciiMode ? 'j/k' : 'j/k ↑↓', label: t(lang, '列表 / 行移动', 'Move up / down') },
    { key: 'Ctrl+D/U', label: t(lang, '半页下/上翻', 'Half-page scroll') },
    { key: 'Ctrl+F/B', label: t(lang, '整页下/上翻', 'Full-page scroll') },
    { key: 'g/G', label: t(lang, '首尾跳转 (Home/End)', 'Top / bottom (Home/End)') },
    { key: 'Esc', label: t(lang, '关闭 / 取消', 'Close / cancel') },
  ];
}

export function featureShortcuts(lang: 'zh' | 'en'): ShortcutSection[] {
  return [
    {
      title: t(lang, '学习库 · Library', 'Library'),
      items: [
        { key: 'p', label: t(lang, '今日计划', 'Daily plan') },
        { key: 'g', label: t(lang, 'AI 带学工作台', 'AI Guided Study') },
        { key: 'C', label: t(lang, '课程设置', 'Course settings') },
        { key: 'o', label: t(lang, '题组导入/合并/拆分', 'Deck import/merge/split') },
        { key: 'm: + / k', label: t(lang, '题组补题 / 转换题型', 'Deck supplement / convert') },
      ],
    },
    {
      title: t(lang, '刷题复习 · Review', 'Review'),
      items: [
        { key: 'T', label: t(lang, '翻译题目', 'Translate') },
        { key: 'S', label: t(lang, '同类题', 'Similar cards') },
        { key: 'D', label: t(lang, '卡片工具', 'Card tools') },
        { key: 'F', label: t(lang, '费曼复述', 'Feynman retell') },
        { key: 'G', label: t(lang, 'AI 评分标准批改', 'AI rubric grade') },
        { key: 'L', label: t(lang, '互动带学', 'Socratic teach') },
        { key: 'A', label: t(lang, '答题卡 / 案例强化', 'Answer card & drills') },
        { key: '*', label: t(lang, '标记重点', 'Toggle focus') },
      ],
    },
    {
      title: t(lang, '出题与草稿 · Generate / Drafts', 'Generate & Drafts'),
      items: [
        { key: 'S / R', label: t(lang, '草稿查重与修复', 'Draft similar & repair') },
      ],
    },
    {
      title: t(lang, '复习全书 · Book', 'Review Book'),
      items: [
        { key: 'w', label: t(lang, '期末一周与模考', 'Final-week crunch & mock') },
        { key: 'P', label: t(lang, '书内精选问答', 'Pinned book QA') },
      ],
    },
    {
      title: t(lang, '考试教练 · Exam Coach', 'Exam Coach'),
      items: [
        { key: 'p', label: t(lang, '学习画像与偏好', 'Coach profile & prefs') },
      ],
    },
    {
      title: t(lang, '备考补习 · Exam Prep', 'Exam Prep'),
      items: [
        { key: 'P', label: t(lang, '备考计划与就绪度', 'Study plan & readiness') },
      ],
    },
    {
      title: t(lang, '资料与阅读 · Sources / Reader', 'Sources & Reader'),
      items: [
        { key: 'G', label: t(lang, 'AI 课程归类', 'AI organize') },
        { key: 'V', label: t(lang, '引用覆盖率', 'Coverage') },
        { key: 'F', label: t(lang, '文件夹筛选', 'Folders') },
        { key: 'm', label: t(lang, '移至文件夹', 'Move folder') },
        { key: 'C', label: t(lang, '伴学页面', 'Companions') },
        { key: 'O', label: t(lang, '目录大纲', 'Outline TOC') },
        { key: 'B', label: t(lang, '书签与批注', 'Bookmarks & notes') },
      ],
    },
    {
      title: t(lang, '待办看板 · Board', 'Board'),
      items: [
        { key: 'P / Space', label: t(lang, '番茄钟启停', 'Pomodoro toggle') },
        { key: 'M', label: t(lang, '专注/休息模式', 'Focus/break mode') },
        { key: '+/-', label: t(lang, '调整时长', 'Adjust minutes') },
        { key: 'R', label: t(lang, '重置计时', 'Reset timer') },
        { key: 'S', label: t(lang, '同步学习库看板', 'Sync StudyHub board') },
      ],
    },
    {
      title: t(lang, '后台任务 · Tasks', 'Tasks'),
      items: [
        { key: 'w / o / m', label: t(lang, '工作流历史 / 输出 / 指令', 'Workflows / Output / Msg') },
      ],
    },
    {
      title: t(lang, '设置 · Settings', 'Settings'),
      items: [
        { key: 'x', label: t(lang, '导出学习库备份', 'Export backup') },
      ],
    },
  ];
}

export const HelpOverlay = memo(function HelpOverlay({ isActive, onClose, pageHints }: HelpOverlayProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const footer = useTuiStore((s) => s.footerHints);
  const page = useTuiStore((s) => s.page);
  const hints = pageHints ?? footer;
  const meta = PAGE_REGISTRY.find((p) => p.id === page);
  const ell = asciiMode ? '...' : '…';

  useInput(
    (input) => {
      if (input === '?' || input === 'q') onClose();
    },
    { isActive },
  );

  const width = Math.min(104, Math.max(44, columns - 6));
  const innerW = modalContentWidth(width);
  const textW = Math.max(20, innerW - 1);
  const twoCol = textW >= 68;
  const gap = 3;
  const colW = twoCol ? Math.floor((textW - gap) / 2) : textW;
  const keyW = Math.min(12, Math.max(8, Math.floor(colW * 0.3)));
  const labelW = Math.max(4, colW - keyW - 1);

  const packedLines = useMemo(() => {
    const headStyle = chalk.hex(theme.heading).bold;
    const keyStyle = chalk.hex(theme.accent).bold;
    const textStyle = chalk.hex(theme.text);

    const renderSection = (title: string, list: readonly KeyHint[]): string[] => {
      const out: string[] = [headStyle(truncateDisplay(title, colW, ell))];
      for (const h of list) {
        const k = keyStyle(padDisplay(truncateDisplay(h.key, keyW, ell), keyW));
        const lbl = textStyle(truncateDisplay(h.label, labelW, ell));
        out.push(`${k} ${lbl}`);
      }
      return out;
    };

    const globals = globalShortcuts(lang, asciiMode);
    const features = featureShortcuts(lang);
    const pages = PAGE_REGISTRY.map((p) => ({
      key: p.shortcut,
      label: `${pageIcon(p.id, asciiMode, p.icon)} ${t(lang, p.labelZh, p.labelEn)}`,
    }));

    if (!twoCol) {
      const lines: string[] = [...renderSection(t(lang, '全局', 'Global'), globals)];
      if (hints.length > 0) {
        lines.push('', ...renderSection(t(lang, '当前页面', 'This page'), hints));
      }
      for (const sec of features) {
        lines.push('', ...renderSection(sec.title, sec.items));
      }
      lines.push('', ...renderSection(t(lang, '页面跳转', 'Pages'), pages));
      return lines;
    }

    const left: string[] = [...renderSection(t(lang, '全局', 'Global'), globals)];
    if (hints.length > 0) {
      left.push('', ...renderSection(t(lang, '当前页面', 'This page'), hints));
    }

    const right: string[] = [...renderSection(t(lang, '页面跳转', 'Pages'), pages)];
    for (const sec of features) {
      right.push('', ...renderSection(sec.title, sec.items));
    }

    const totalRows = Math.max(left.length, right.length);
    const combined: string[] = [];
    const spacer = ' '.repeat(gap);
    for (let i = 0; i < totalRows; i += 1) {
      const l = padDisplay(left[i] ?? '', colW);
      const r = right[i] ? truncateDisplay(right[i], colW, ell) : '';
      combined.push(r ? `${l}${spacer}${r}` : l);
    }
    return combined;
  }, [theme.heading, theme.accent, theme.text, colW, keyW, labelW, ell, lang, asciiMode, hints, twoCol]);

  const maxModalH = Math.max(8, rows - 2);
  const modalH = Math.min(maxModalH, packedLines.length + 5);
  const bodyH = Math.max(3, modalH - 5);

  return (
    <Modal
      title={t(lang, '快捷键', 'Keyboard Shortcuts')}
      icon="?"
      subtitle={meta ? `${pageIcon(meta.id, asciiMode, meta.icon)} ${t(lang, meta.labelZh, meta.labelEn)}` : undefined}
      width={width}
      height={modalH}
      onClose={onClose}
      isActive={isActive}
      hints={[
        { key: asciiMode ? 'j/k Ctrl+D/U' : 'j/k ↑↓ Ctrl+D/U', label: t(lang, '滚动', 'Scroll') },
        { key: 'g/G', label: t(lang, '首尾', 'Top/End') },
        { key: 'Esc / ? / q', label: t(lang, '关闭', 'Close') },
      ]}
    >
      <ScrollView lines={packedLines} width={innerW} height={bodyH} isActive={isActive} ascii={asciiMode} />
    </Modal>
  );
});

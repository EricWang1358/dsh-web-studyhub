import React, { memo, useMemo } from 'react';
import { useInput, useWindowSize } from 'ink';
import { PAGE_REGISTRY, type KeyHint } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { getColorLevel, makeChalk, useTheme } from '../theme/tokens.js';
import { padDisplay, truncateDisplay } from '../render/cjk.js';
import { Modal, modalContentWidth } from '../components/Modal.js';
import { ScrollView } from '../components/ScrollView.js';
import { pageIcon } from './data.js';

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
    { key: 'Ctrl+S', label: t(lang, '提交 (Ctrl+J/Shift+Enter换行)', 'Submit (Ctrl+J/Shift+Enter nl)') },
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
        { key: '[ / ]', label: t(lang, '上移/下移题组顺序', 'Reorder deck up/down') },
        { key: 'R', label: t(lang, '定制本轮练习', 'Custom round config') },
        { key: 'm: + / k', label: t(lang, '题组补题 / 转换题型', 'Deck supplement / convert') },
        { key: 'm: Space/F/S', label: t(lang, '题组批量重点/暂停', 'Deck batch focus/suspend') },
        { key: 'm: T', label: t(lang, '题组批量改主题', 'Deck batch retag topic') },
        { key: 'm: L', label: t(lang, '题组批量关联前置', 'Deck batch link prereq') },
        { key: 'm: X', label: t(lang, '题组批量斩题', 'Deck batch slay') },
      ],
    },
    {
      title: t(lang, '刷题复习 · Review', 'Review'),
      items: [
        { key: '0-5', label: t(lang, 'FSRS-6 六级记忆自评', 'FSRS-6 six-grade rating') },
        { key: 'T', label: t(lang, '翻译题目', 'Translate') },
        { key: 'S', label: t(lang, '同类题', 'Similar cards') },
        { key: 'D', label: t(lang, '卡片工具', 'Card tools') },
        { key: 'F', label: t(lang, '费曼复述', 'Feynman retell') },
        { key: 'G', label: t(lang, 'AI 评分标准批改', 'AI rubric grade') },
        { key: 'L', label: t(lang, '互动带学', 'Socratic teach') },
        { key: 'A', label: t(lang, '答题卡 / 案例强化', 'Answer card & drills') },
        { key: 'Q', label: t(lang, '队列编辑', 'Edit queue') },
        { key: '*', label: t(lang, '标记重点', 'Toggle focus') },
        { key: 'u', label: t(lang, '撤销上一题评分', 'Undo last rating') },
        { key: 'q', label: t(lang, '结束本轮 (二次确认)', 'End round (confirm)') },
      ],
    },
    {
      title: t(lang, '出题与草稿 · Generate / Drafts', 'Generate & Drafts'),
      items: [
        { key: 'i', label: t(lang, '录题 / 粘贴既有题', 'Capture & ingest') },
        { key: 'S', label: t(lang, 'AI 出题建议', 'AI suggest strategy') },
        { key: 'S / R', label: t(lang, '草稿查重与修复', 'Draft similar & repair') },
        { key: 'u', label: t(lang, '撤销移除草稿题', 'Undo removed draft card') },
        { key: 'Ctrl+S/J', label: t(lang, '保存 / 换行 (Shift+Enter)', 'Save / newline (Shift+Enter)') },
      ],
    },
    {
      title: t(lang, '复习全书 · Book', 'Review Book'),
      items: [
        { key: 'w', label: t(lang, '期末一周与模考', 'Final-week crunch & mock') },
        { key: 'P', label: t(lang, '书内精选问答', 'Pinned book QA') },
        { key: 'e', label: t(lang, '编辑/回退全书', 'Edit/revert section') },
        { key: 'x', label: t(lang, '导出 Markdown', 'Export Markdown') },
        { key: 'R', label: t(lang, '节点改名', 'Rename node') },
        { key: '[ / ]', label: t(lang, '同级上移/下移节点', 'Move node up/down') },
        { key: 'D / z', label: t(lang, '删节点 / 撤销结构', 'Delete / undo struct') },
        { key: 'a / u', label: t(lang, '应用 / 撤销总纲重建', 'Apply / undo rebuild') },
        { key: 'U', label: t(lang, '归位未归位段落', 'Place unplaced section') },
        { key: 'T', label: t(lang, '费曼复述知识点', 'Feynman retell point') },
        { key: 'M', label: t(lang, '章节模拟卷', 'Chapter mock exam') },
      ],
    },
    {
      title: t(lang, '错题本 · Wrong Book', 'Wrong Book'),
      items: [
        { key: 'Space / B', label: t(lang, '勾选并批量练错题', 'Select & batch practice') },
        { key: 'V', label: t(lang, '练错题变式', 'Practice variants') },
      ],
    },
    {
      title: t(lang, '学习统计 · Dashboard', 'Dashboard'),
      items: [
        { key: 'Enter/p', label: t(lang, '钻取练习', 'Drill practice') },
        { key: 'f', label: t(lang, '7天预测', '7d forecast') },
        { key: 'm', label: t(lang, '知识地图 / 依赖图', 'Study map & prereq graph') },
      ],
    },
    {
      title: t(lang, '模拟考 · Exam', 'Mock Exam'),
      items: [
        { key: 's', label: t(lang, '切换材料', 'Toggle case') },
        { key: 'H', label: t(lang, '标亮段落', 'Highlight') },
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
        { key: 'P', label: t(lang, '备考计划与定制向导', 'Study plan & custom wizard') },
        { key: 'a', label: t(lang, '添加重点 / AI 匹配主题', 'Add focus & AI suggest') },
      ],
    },
    {
      title: t(lang, '骨架与笔记 · Skeleton / Notes', 'Skeleton & Notes'),
      items: [
        { key: 'R', label: t(lang, '课程学习路线', 'Course route') },
        { key: 'G', label: t(lang, '主题分组管理', 'Topic groups') },
        { key: 'E', label: t(lang, '编辑骨架节点', 'Edit skeleton node') },
        { key: 'D', label: t(lang, '删除知识骨架', 'Delete skeleton') },
        { key: 'L', label: t(lang, '骨架自检 / 发布链接', 'Skeleton lint / Publish link') },
        { key: 'M', label: t(lang, '骨架互动图管理', 'Skeleton diagrams') },
        { key: 'C', label: t(lang, '取消每日总结', 'Cancel daily recap') },
        { key: 'o', label: t(lang, '跳转关联', 'Jump linked ref') },
      ],
    },
    {
      title: t(lang, '资料与阅读 · Sources / Reader', 'Sources & Reader'),
      items: [
        { key: 'Enter', label: t(lang, '打开阅读器 (自动续读上次页码)', 'Open reader (auto-resume page)') },
        { key: 'Space', label: t(lang, '多选批量 (移夹/归档/补全)', 'Multi-select (move/arch/enrich)') },
        { key: 'E', label: t(lang, '补全资料元信息', 'Enrich metadata') },
        { key: 'G', label: t(lang, 'AI 课程归类 / 术语译文', 'AI organize / Glossary') },
        { key: 'V', label: t(lang, '引用覆盖率与关联题卡', 'Coverage & linked cards') },
        { key: 'F', label: t(lang, '文件夹筛选', 'Folders') },
        { key: 'm', label: t(lang, '移至文件夹', 'Move folder') },
        { key: 'M', label: t(lang, 'MinerU / 标记章节已读', 'MinerU / Toggle chapter read') },
        { key: 'C', label: t(lang, '伴学页面', 'Companions') },
        { key: '[ / ]', label: t(lang, '上移/下移置顶资料', 'Reorder pinned material') },
        { key: 'R', label: t(lang, '重读清单', 'Reread queue') },
        { key: 'O', label: t(lang, '原始文件 / 目录大纲', 'Original file / Outline TOC') },
        { key: 'X', label: t(lang, '清除自定义目录 (大纲内)', 'Clear custom outline (TOC)') },
        { key: 'H', label: t(lang, '标记段落', 'Mark passage') },
        { key: 'B', label: t(lang, '书签与批注', 'Bookmarks & notes') },
        { key: 't', label: t(lang, '双语翻译 (缓存/估算)', 'Bilingual translate (cached)') },
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
      title: t(lang, '后台任务与音频 · Tasks / Audio', 'Tasks & Audio'),
      items: [
        { key: 'w / o / m', label: t(lang, '工作流历史 / 输出 / 指令', 'Workflows / Output / Msg') },
        { key: 'e / D', label: t(lang, '导出 / 清空调用轨迹', 'Export / Purge Traces') },
        { key: 'p', label: t(lang, '暂停任务 / 音频自检', 'Pause tasks / Audio preflight') },
        { key: '+/-', label: t(lang, '并发数', 'Concurrency') },
        { key: 'R', label: t(lang, '恢复中断任务 / 重试音频', 'Recover jobs / Retry audio') },
        { key: 'u', label: t(lang, '导入字幕', 'Import subtitles') },
        { key: 'c', label: t(lang, '复核音频存疑处', 'Review audio corrections') },
      ],
    },
    {
      title: t(lang, '设置 · Settings', 'Settings'),
      items: [
        { key: 'x', label: t(lang, '导出学习库备份', 'Export backup') },
        { key: 'f', label: t(lang, '实验性功能开关', 'Experimental toggle') },
        { key: 'u / U', label: t(lang, '使用记录开关 / 清空', 'Usage toggle / clear') },
        { key: 'a', label: t(lang, '自动检查更新开关', 'Auto update check toggle') },
        { key: 'v', label: t(lang, '切换语义检索提供方', 'Cycle retrieval provider') },
      ],
    },
    {
      title: t(lang, '命令面板 · Palette', 'Command Palette'),
      items: [
        { key: '/#?@:', label: t(lang, '命令/题/段/课/页筛选', 'Cmd/card/text/course/page') },
        { key: '/ascii /math /recover', label: t(lang, 'ASCII/数学符号/恢复中断任务', 'ASCII / Math / Recover jobs') },
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

  const colorLevel = getColorLevel();
  const packedLines = useMemo(() => {
    const chalk = makeChalk(colorLevel);
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
  }, [colorLevel, theme.heading, theme.accent, theme.text, colW, keyW, labelW, ell, lang, asciiMode, hints, twoCol]);

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

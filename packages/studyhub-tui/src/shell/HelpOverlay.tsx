import React, { memo, useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../components/key-dispatcher.js';
import { PAGE_REGISTRY, type KeyHint, type UiLanguage } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { getColorLevel, makeChalk, useTheme } from '../theme/tokens.js';
import { padDisplay, truncateDisplay, wrapDisplay } from '../render/cjk.js';
import { Modal, modalContentWidth } from '../components/Modal.js';
import { ScrollView } from '../components/ScrollView.js';
import { ClickableBox } from '../components/mouse.js';
import { pageIcon } from './data.js';
import { buildGlobalHelpShortcuts } from './global-keymap.js';

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
  return buildGlobalHelpShortcuts(lang, asciiMode);
}

export function featureShortcuts(lang: 'zh' | 'en'): ShortcutSection[] {
  return [
    {
      title: t(lang, '学习库 · Library', 'Library'),
      items: [
        { key: 'p', label: t(lang, '今日计划', 'Daily plan') },
        { key: 'g', label: t(lang, 'AI带学工作台 (B支线/u回/Q问答)', 'AI Guided Study (B/u/Q)') },
        { key: 'g: A', label: t(lang, '保存带学产物笔记', 'Save guided artifact') },
        { key: 'C', label: t(lang, '课程设置', 'Course settings') },
        { key: 'o', label: t(lang, '题组导入/AI建议/合并拆分', 'Deck import/AI suggest/merge') },
        { key: '[ / ]', label: t(lang, '上移/下移题组顺序', 'Reorder deck up/down') },
        { key: 'R', label: t(lang, '定制本轮练习', 'Custom round config') },
        { key: 'm: + / k', label: t(lang, '题组补题 / 转换题型', 'Deck supplement / convert') },
        { key: 'm: Space/F/S', label: t(lang, '题组批量重点/暂停', 'Deck batch focus/suspend') },
        { key: 'm: T', label: t(lang, '题组批量改主题', 'Deck batch retag topic') },
        { key: 'm: L', label: t(lang, '题组批量关联前置', 'Deck batch link prereq') },
        { key: 'm: X', label: t(lang, '题组批量斩题', 'Deck batch slay') },
        { key: 'm: C', label: t(lang, '题组更改所属课程', 'Deck change course') },
        { key: 'x', label: t(lang, '导出题组复习卷 (MD)', 'Export deck sheet (MD)') },
        { key: '/', label: t(lang, '关键词筛选题组', 'Filter decks by keyword') },
      ],
    },
    {
      title: t(lang, '刷题复习 · Review', 'Review'),
      items: [
        { key: 'Space/Enter', label: t(lang, '翻开答案 / 提交选择', 'Reveal answer / submit') },
        { key: '0-5', label: t(lang, 'FSRS-6 六级记忆自评', 'FSRS-6 six-grade rating') },
        { key: 'h', label: t(lang, 'AI 帮我理解 / 讲解抽屉', 'AI Tutor / explanation drawer') },
        { key: 't', label: t(lang, '带学（可直接进复述阶段）', 'Guided Study (direct to Retell stage)') },
        { key: '*', label: t(lang, '标记重点', 'Toggle focus') },
        { key: 'G', label: t(lang, 'AI 评分标准批改', 'AI rubric grade') },
        { key: 'A', label: t(lang, '答题卡 / 案例强化', 'Answer card & drills') },
        { key: 'W', label: t(lang, '翻译题目', 'Translate') },
        { key: 'S', label: t(lang, '同类题', 'Similar cards') },
        { key: 'D', label: t(lang, '卡片工具 (编辑/反馈/重试改题)', 'Card tools (edit/feedback/retry)') },
        { key: 'Q', label: t(lang, '队列编辑', 'Edit queue') },
        { key: 'E', label: t(lang, '标记题目问题', 'Flag card issue') },
        { key: 's', label: t(lang, '跳过本题', 'Skip card') },
        { key: 'u', label: t(lang, '撤销上一题评分', 'Undo last rating') },
        { key: ', / .', label: t(lang, '上一题 / 下一题', 'Prev / next card') },
        { key: 'o', label: t(lang, '跳转资料原文', 'Open source citation') },
        { key: 'J / K', label: t(lang, '手动改AI分 / 确认订正', 'Adjust AI grade / Ack fix') },
        { key: 'N', label: t(lang, 'AI 陪学点拨与小检查', 'AI coach nudge & check') },
        { key: 'd', label: t(lang, '本轮 AI 复盘点评', 'Round AI debrief') },
        { key: 'X', label: t(lang, '结束本轮 (二次确认)', 'End round (confirm)') },
      ],
    },
    {
      title: t(lang, '出题与草稿 · Generate / Drafts', 'Generate & Drafts'),
      items: [
        { key: 'i', label: t(lang, '录题 / 粘贴既有题', 'Capture & ingest') },
        { key: 'W', label: t(lang, '填入课程薄弱知识点', 'Fill weak topics') },
        { key: 'S', label: t(lang, 'AI 出题建议', 'AI suggest strategy') },
        { key: 'P', label: t(lang, '分步出题路径规划', 'Multi-step study path') },
        { key: 'g: /', label: t(lang, '筛选出题参考资料', 'Filter source materials') },
        { key: 'S / R', label: t(lang, '草稿查重与修复', 'Draft similar & repair') },
        { key: 'V', label: t(lang, '草稿发布预检', 'Draft publish preflight') },
        { key: 'u', label: t(lang, '撤销移除草稿题', 'Undo removed draft card') },
        { key: '/ / X', label: t(lang, '筛选草稿题 / 导出草稿 MD', 'Filter draft / Export draft MD') },
        { key: 'Ctrl+S/J', label: t(lang, '保存 / 换行 (Shift+Enter)', 'Save / newline (Shift+Enter)') },
      ],
    },
    {
      title: t(lang, '复习全书 · Book', 'Review Book'),
      items: [
        { key: 'w', label: t(lang, '期末一周与模考', 'Final-week crunch & mock') },
        { key: 'P', label: t(lang, '书内精选问答', 'Pinned book QA') },
        { key: 'e', label: t(lang, '编辑/回退全书', 'Edit/revert section') },
        { key: 'H', label: t(lang, '版本历史与回退', 'Revision history & revert') },
        { key: 'x', label: t(lang, '导出 Markdown', 'Export Markdown') },
        { key: 'R', label: t(lang, '节点改名', 'Rename node') },
        { key: '[ / ]', label: t(lang, '同级上移/下移节点', 'Move node up/down') },
        { key: 'D / z', label: t(lang, '删节点 / 撤销结构', 'Delete / undo struct') },
        { key: 'a / u', label: t(lang, '应用 / 撤销总纲重建', 'Apply / undo rebuild') },
        { key: 'U', label: t(lang, '归位未归位段落', 'Place unplaced section') },
        { key: 'T', label: t(lang, '费曼复述知识点', 'Feynman retell point') },
        { key: 'M', label: t(lang, '章节模拟卷', 'Chapter mock exam') },
        { key: 'E', label: t(lang, 'AI深入讲解/补充段落', 'AI explain / add section') },
        { key: 'B', label: t(lang, '审阅/保留/删除 AI 补充块', 'Review / keep / delete AI blocks') },
        { key: '/', label: t(lang, '关键词筛选全书目录', 'Filter book TOC by keyword') },
      ],
    },
    {
      title: t(lang, '错题本 · Wrong Book', 'Wrong Book'),
      items: [
        { key: 'Space / B', label: t(lang, '勾选并批量练错题', 'Select & batch practice') },
        { key: 'Q', label: t(lang, '高频错题聚类一键急救', 'Top weak cluster quick drill') },
        { key: 'V', label: t(lang, '练错题变式', 'Practice variants') },
        { key: 'X', label: t(lang, '导出错题复习卷 (Markdown)', 'Export wrong cards (Markdown)') },
        { key: '/', label: t(lang, '关键词筛选错题', 'Filter wrong cards by keyword') },
      ],
    },
    {
      title: t(lang, '学习统计 · Dashboard', 'Dashboard'),
      items: [
        { key: 'Enter/p', label: t(lang, '钻取练习', 'Drill practice') },
        { key: 'f', label: t(lang, '7天预测', '7d forecast') },
        { key: 'T', label: t(lang, '切换课程掌握度统计表', 'Toggle course mastery table') },
        { key: 'm', label: t(lang, '知识地图 / 依赖图', 'Study map & prereq graph') },
        { key: 'd / x', label: t(lang, '切换用量周期 / 导出进度报告', 'Usage window / Export report') },
        { key: '/', label: t(lang, '筛选薄弱点与课程', 'Filter weak topics & courses') },
      ],
    },
    {
      title: t(lang, '模拟考 · Exam', 'Mock Exam'),
      items: [
        { key: 's', label: t(lang, '切换材料', 'Toggle case') },
        { key: 'H', label: t(lang, '标亮段落', 'Highlight') },
        { key: 'x', label: t(lang, '导出模考历史报告 (MD)', 'Export exam report (MD)') },
      ],
    },
    {
      title: t(lang, '考试教练 · Exam Coach', 'Exam Coach'),
      items: [
        { key: 'p', label: t(lang, '学习画像与偏好及记忆要点', 'Coach profile, prefs & bullets') },
        { key: 'f', label: t(lang, '触发教练后台备题队列', 'Flush coach prep queue') },
        { key: 'X', label: t(lang, '导出校准与学习画像 (MD)', 'Export coach profile (MD)') },
        { key: '/', label: t(lang, '筛选任务族/错题/考点', 'Filter families/variants/points') },
      ],
    },
    {
      title: t(lang, '备考补习 · Exam Prep', 'Exam Prep'),
      items: [
        { key: 'P', label: t(lang, '备考计划与定制向导', 'Study plan & custom wizard') },
        { key: 'a', label: t(lang, '添加重点 / AI 匹配主题', 'Add focus & AI suggest') },
        { key: 'Z', label: t(lang, '隐藏本次考期缺口预警', 'Dismiss exam gap alert') },
        { key: '/ / x', label: t(lang, '筛选重点 / 导出备考计划 MD', 'Filter focus / Export prep MD') },
      ],
    },
    {
      title: t(lang, '骨架与笔记 · Skeleton / Notes', 'Skeleton & Notes'),
      items: [
        { key: 'R', label: t(lang, '课程学习路线', 'Course route') },
        { key: 'G', label: t(lang, '主题分组管理', 'Topic groups') },
        { key: 'E', label: t(lang, '编辑骨架节点', 'Edit skeleton node') },
        { key: 'D', label: t(lang, '删除知识骨架', 'Delete skeleton') },
        { key: 'L', label: t(lang, '骨架自检 / 发布与查找链接', 'Skeleton lint / Publish & lookup') },
        { key: 'M', label: t(lang, '骨架互动图 / 笔记入资料库', 'Skeleton diagrams / Note to source') },
        { key: 'g', label: t(lang, 'AI起草笔记正文', 'AI draft note') },
        { key: 'C', label: t(lang, '停止笔记/每日总结生成', 'Stop note / recap gen') },
        { key: 'o', label: t(lang, '跳转关联', 'Jump linked ref') },
        { key: '/ / x', label: t(lang, '筛选骨架节点 / 导出大纲 MD', 'Filter nodes / Export skeleton MD') },
        { key: 'n: /', label: t(lang, '关键词筛选学习笔记', 'Filter notes by keyword') },
      ],
    },
    {
      title: t(lang, '资料与阅读 · Sources / Reader', 'Sources & Reader'),
      items: [
        { key: 'Enter', label: t(lang, '打开阅读器 (自动续读上次页码)', 'Open reader (auto-resume page)') },
        { key: 'Space', label: t(lang, '多选批量 (移夹/归档/补全)', 'Multi-select (move/arch/enrich)') },
        { key: 'E', label: t(lang, '补全资料元信息', 'Enrich metadata') },
        { key: 'G', label: t(lang, 'AI 课程归类 / 术语译文', 'AI organize / Glossary') },
        { key: 'G/F: X', label: t(lang, '清除待审归类/分夹建议', 'Dismiss pending proposals') },
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
        { key: 'a: f', label: t(lang, '阅读问答存为闪卡', 'Save reader Q&A as card') },
        { key: 't', label: t(lang, '双语翻译 (缓存/估算)', 'Bilingual translate (cached)') },
        { key: 'x', label: t(lang, '导出资料目录与覆盖率 (MD)', 'Export sources catalog (MD)') },
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
        { key: '/ / x', label: t(lang, '筛选卡片 / 导出看板 Markdown', 'Filter cards / Export Markdown') },
      ],
    },
    {
      title: t(lang, '后台任务与音频 · Tasks / Audio', 'Tasks & Audio'),
      items: [
        { key: 'w / o / m', label: t(lang, '工作流上下文 / 输出 / 指令', 'Workflows ctx / Output / Msg') },
        { key: 'e / D', label: t(lang, '导出 / 清空调用轨迹', 'Export / Purge Traces') },
        { key: 'p', label: t(lang, '暂停任务 / 音频自检', 'Pause tasks / Audio preflight') },
        { key: 'P', label: t(lang, '排队任务立即并行启动', 'Promote queued job to parallel') },
        { key: '+/-', label: t(lang, '并发数', 'Concurrency') },
        { key: 'R', label: t(lang, '恢复中断任务 / 重试音频', 'Recover jobs / Retry audio') },
        { key: 'u', label: t(lang, '导入字幕', 'Import subtitles') },
        { key: 'c', label: t(lang, '复核音频存疑处', 'Review audio corrections') },
        { key: '/ / x', label: t(lang, '筛选音频 / 导出转写 MD', 'Filter audio / Export transcript MD') },
        { key: 't: /  X', label: t(lang, '筛选任务 / 导出任务汇总 MD', 'Filter jobs / Export jobs MD') },
      ],
    },
    {
      title: t(lang, '设置 · Settings', 'Settings'),
      items: [
        { key: 'x', label: t(lang, '导出学习库备份', 'Export backup') },
        { key: 'f', label: t(lang, '实验性功能开关', 'Experimental toggle') },
        { key: 'u / U', label: t(lang, '使用记录开关 / 清空', 'Usage toggle / clear') },
        { key: 'i', label: t(lang, '使用频率报表与导出', 'Usage report & export') },
        { key: 'a', label: t(lang, '自动检查更新开关', 'Auto update check toggle') },
        { key: 'A', label: t(lang, '手动检查新版本', 'Check for updates') },
        { key: 'v', label: t(lang, '切换语义检索提供方', 'Cycle retrieval provider') },
        { key: 't', label: t(lang, '语义检索诊断/试搜/镜像源', 'Retrieval diag / search / mirror') },
        { key: 'L', label: t(lang, '学习库上下文总览与导出', 'Library context & export') },
      ],
    },
    {
      title: t(lang, '命令面板 · Palette', 'Command Palette'),
      items: [
        { key: '/#?@:', label: t(lang, '命令/题/段/课/页筛选', 'Cmd/card/text/course/page') },
        { key: '/due /theme /lang', label: t(lang, '今日到期/6主题(护眼)/语言', 'Due / 6 themes / Lang') },
        { key: '/ascii /math /recover', label: t(lang, 'ASCII/数学符号/恢复中断任务', 'ASCII / Math / Recover jobs') },
        { key: '/density /proactive /terminal /pin', label: t(lang, '紧凑密度/主动提示/终端诊断/书签', 'Density / Proactive / Diag / Pin') },
        { key: 'Ctrl+Space / I:/ e', label: t(lang, '常驻AI助手 · 收件箱筛选导出', 'AI Assistant · Inbox filter/JSON') },
      ],
    },
  ];
}

export function buildInAppGuideLines(lang: UiLanguage, width: number, asciiMode = false): string[] {
  const sections: Array<{ heading: string; bullets: string[] }> =
    lang === 'en'
      ? [
          {
            heading: '1. First-Time Setup & Three Screen Areas',
            bullets: [
              'TopBar: active page, course [c], inbox [I], running jobs, due count, model status, [?] Help & [/]/[Ctrl+K] Palette.',
              'SideNav: Daily / Exam / Tools groups + top Resume [r]. Keys overridden by the current page are automatically hidden on SideNav.',
              'Reserved global keys (never shadowed): [r] Return to active review, [q] Safe quit (confirms during practice/exam), [?] Help/Guide.',
              'Models: press [,] -> [1] Models to activate agy CLI or OpenAI-compatible provider. Offline 0-token features still work without a model.',
            ],
          },
          {
            heading: '2. Core Workflow: Import -> Generate -> Practise -> Mistakes',
            bullets: [
              '[2] Sources -> [i] Import PDF/PPTX/DOCX/MD (Tab completes paths) -> Enter to read; press [r] anytime to jump back to review.',
              '[3] Generate -> Space to pick sources -> Ctrl+S to generate -> Tab to DraftEditor -> [P] Publish to deck.',
              '[1] Library -> Enter to start deck (or press [r] anywhere). In Library, [m] opens Deck Card Manager (Esc exits).',
              '[4] Mistakes -> [t] 0-token triage, Space + [B] batch retry weak cards.',
            ],
          },
          {
            heading: '3. Review Page, AI Drawer & Next-Step Instructions',
            bullets: [
              'Bottom keys: [h] AI Tutor (reuses saved Q&As; [R] regenerates with AI call; [N] saves for reuse), [t] Guided Study/Retell (AI Assistant; standalone modals: [L] Socratic Teach, [F] Feynman Retell), [S] Similar, [*] Focus, [G] Rubric Grade, [A] Answer Card, [W] Translate, [D] Card Tools, [Q] Queue, [E] Flag, [s] Skip, [u] Undo, [,/.] Prev/Next, [o] Source, [X] End Round.',
              'After any AI tool result (Vocab, Teach, Retell, Answer Card, Similar), press [a] at the bottom bar to give custom follow-up instructions or pick quick presets [1-4], then [N] to save.',
              'FSRS-6 Rating [0-5]: 0 Blackout, 1 Forgot, 2 Barely, 3 Hard, 4 Good (standard), 5 Easy. Misrated? Press [u] to undo.',
            ],
          },
          {
            heading: '4. Command Palette, Mouse & CLI Fast Paths',
            bullets: [
              'Ctrl+K prefixes: / commands (/due, /guide, /theme, /lang, /ascii, /math, /recover, /quit), # cards, ? passages, @ courses, : pages.',
              'Mouse: Alt+click = mouse action; plain click keeps terminal text selection/copy (launch with --mouse or STUDYHUB_TUI_MOUSE=1; wheel always works; --mouse-alt=0 or STUDYHUB_TUI_MOUSE_ALT=0 allows plain clicks).',
              'CLI fast paths (offline): --doctor, --stats, --due, --board, --search <q>, --export (writes to <libraryRoot>/backups/).',
              'Full Chinese manual with all 16 pages & task lookup table: packages/studyhub-tui/docs/GUIDE.md',
            ],
          },
        ]
      : [
          {
            heading: '一、第一次打开：看懂三块区域与保留键',
            bullets: [
              '顶栏：当前页面、课程 [c]、收件箱 [I]、后台任务、今日到期、模型状态、[?] 帮助与命令面板。',
              '左侧栏：每日/考试/整理 15 页 + 顶部「继续练习 r」。当前页覆盖了某个字母键时，侧栏会自动隐藏该键避免误导。',
              '三大保留全局键（任何页面不覆盖）：[r] 回到题目/继续练习、[q] 安全退出（刷题/考试中带确认）、[?] 帮助与教程。',
              '配模型：按 [,] -> [1] 模型启用 agy CLI 或 OpenAI 兼容预设；没配模型时阅读、刷已有题、错题分流、看板和 CLI 仍可正常用。',
            ],
          },
          {
            heading: '二、核心闭环：导入 -> 出题 -> 练习 -> 错题',
            bullets: [
              '1) [2] 资料 -> [i] 导入讲义（Tab 补全路径）-> Enter 阅读；阅读器或抽屉内随时按 [r] 回到正在做的题。',
              '2) [3] 创建题组 -> Space 勾选资料 -> Ctrl+S 出题 -> Tab 切草稿编辑 -> [P] 发布题组。',
              '3) [1] 学习库 -> Enter 开始刷题（[m] 进题组管理批量操作，Esc 退出；[R] 定制本轮）。',
              '4) [4] 错题本 -> [t] 0-token 分流，Space 勾选后 [B] 批量重练错题。',
            ],
          },
          {
            heading: '三、刷题页工具、AI 抽屉、后续指令与自评 0-5',
            bullets: [
              '底部键：[h]讲解(复用已存讲解，[R]重生成调用模型，[N]保存供下次复用) [t]带学(常驻助手带学/复述；独立弹窗：[L]苏格拉底带学 [F]费曼复述) [S]同类 [*]收藏 [G]评分 [A]答题卡 [W]翻译 [D]工具 [Q]队列 [E]标记 [s]跳过 [u]撤销 [,/.]换题 [o]原文 [X]结束本轮。',
              'AI 结果页（生词提取/带学/复述/答题卡/同类题）底部统一按 [a] 自由下指令，或选 [1-4] 快捷项，回答后按 [N] 存追问/笔记。',
              'FSRS-6 自评 [0-5]：0完全不会 / 1看答案才想起 / 2勉强或漏细节 / 3困难但对 / 4正常记住(常用) / 5秒杀。选错马上按 [u] 撤销。',
            ],
          },
          {
            heading: '四、命令面板、鼠标与命令行快路径',
            bullets: [
              'Ctrl+K 前缀：/ 命令（/due /guide /theme /lang /ascii /math /recover /quit）、# 搜题、? 搜原文、@ 切课程、: 跳页面。',
              '鼠标：Alt+点击 = 鼠标操作；普通点击保留终端选择与复制（加 --mouse 或 STUDYHUB_TUI_MOUSE=1 启用，滚轮不受影响；--mouse-alt=0 或 STUDYHUB_TUI_MOUSE_ALT=0 允许普通点击生效）。',
              '无头 CLI：--doctor / --stats / --due / --board / --search / --export（备份导出到 <学习库>/backups/）。',
              '完整图文任务教程（含全部 16 页与「我想做 X 去哪里」对照表）：packages/studyhub-tui/docs/GUIDE.md',
            ],
          },
        ];

  const bulletPrefix = asciiMode ? '- ' : '• ';
  const out: string[] = [];
  const w = Math.max(20, width);
  sections.forEach((sec, sIdx) => {
    if (sIdx > 0) out.push('');
    out.push(...wrapDisplay(sec.heading, w));
    for (const b of sec.bullets) {
      const wrapped = wrapDisplay(b, Math.max(12, w - 2));
      wrapped.forEach((line, i) => {
        out.push(i === 0 ? `${bulletPrefix}${line}` : `  ${line}`);
      });
    }
  });
  return out;
}

export const HelpOverlay = memo(function HelpOverlay({ isActive, onClose, pageHints }: HelpOverlayProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const footer = useTuiStore((s) => s.footerHints);
  const page = useTuiStore((s) => s.page);
  const helpTab = useTuiStore((s) => s.helpTab);
  const setHelpTab = useTuiStore((s) => s.setHelpTab);
  const hints = pageHints ?? footer;
  const meta = PAGE_REGISTRY.find((p) => p.id === page);
  const ell = asciiMode ? '...' : '…';

  useInput(
    (input, key) => {
      if (input === '?' || input === 'q') {
        onClose();
        return;
      }
      if (key.tab) {
        setHelpTab(helpTab === 'shortcuts' ? 'guide' : 'shortcuts');
        return;
      }
      if (input === '1') setHelpTab('shortcuts');
      else if (input === '2') setHelpTab('guide');
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

  const pageSummary = meta ? t(lang, meta.descriptionZh, meta.descriptionEn) : '';

  const colorLevel = getColorLevel();
  const packedLines = useMemo(() => {
    const chalk = makeChalk(colorLevel);
    const headStyle = chalk.hex(theme.heading).bold;
    const keyStyle = chalk.hex(theme.accent).bold;
    const textStyle = chalk.hex(theme.text);

    if (helpTab === 'guide') {
      return buildInAppGuideLines(lang, textW, asciiMode).map((line) =>
        /^(?:[一二三四]、|\d+\.\s)/.test(line) ? headStyle(line) : textStyle(line),
      );
    }

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
  }, [colorLevel, theme.heading, theme.accent, theme.text, colW, keyW, labelW, textW, ell, lang, asciiMode, hints, twoCol, helpTab]);

  const headerExtraRows = 1;
  const maxModalH = Math.max(10, rows - 2);
  const modalH = Math.min(maxModalH, packedLines.length + 5 + headerExtraRows);
  const bodyH = Math.max(3, modalH - 5 - headerExtraRows);

  return (
    <Modal
      title={helpTab === 'guide' ? t(lang, '使用教程 · 快捷键', 'Usage Guide') : t(lang, '快捷键与帮助', 'Keyboard Shortcuts')}
      icon="?"
      subtitle={meta ? `${pageIcon(meta.id, asciiMode, meta.icon)} ${t(lang, meta.labelZh, meta.labelEn)}` : undefined}
      width={width}
      height={modalH}
      onClose={onClose}
      isActive={isActive}
      hints={[
        { key: 'Tab / 1-2', label: helpTab === 'guide' ? t(lang, '切快捷键', 'Shortcuts') : t(lang, '使用教程', 'Guide') },
        { key: asciiMode ? 'j/k Ctrl+D/U' : 'j/k ↑↓ Ctrl+D/U', label: t(lang, '滚动', 'Scroll') },
        { key: 'g/G', label: t(lang, '首尾', 'Top/End') },
        { key: 'Esc / ? / q', label: t(lang, '关闭', 'Close') },
      ]}
    >
      <Box height={1} width={innerW} flexDirection="row" justifyContent="space-between" gap={1} overflow="hidden" flexShrink={0}>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <ClickableBox clickActive={isActive} onClick={() => setHelpTab('shortcuts')}>
            <Text
              backgroundColor={helpTab === 'shortcuts' ? theme.primary : theme.surface}
              color={helpTab === 'shortcuts' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={helpTab === 'shortcuts'}
            >
              {` [1] ${t(lang, '快捷键速查', 'Shortcuts')} `}
            </Text>
          </ClickableBox>
          <ClickableBox clickActive={isActive} onClick={() => setHelpTab('guide')}>
            <Text
              backgroundColor={helpTab === 'guide' ? theme.primary : theme.surface}
              color={helpTab === 'guide' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={helpTab === 'guide'}
            >
              {` [2] ${t(lang, '使用教程', 'Usage Guide')} `}
            </Text>
          </ClickableBox>
        </Box>
        {pageSummary ? (
          <Box flexShrink={1} overflow="hidden">
            <Text color={theme.accent} wrap="truncate">
              {truncateDisplay(
                `${t(lang, '当前页', 'Page')}: ${pageSummary}`,
                Math.max(10, innerW - 32),
                ell,
              )}
            </Text>
          </Box>
        ) : null}
      </Box>
      <ScrollView lines={packedLines} width={innerW} height={bodyH} isActive={isActive} ascii={asciiMode} vimJumpKeys />
    </Modal>
  );
});

# PR #1297 审查问题清单（Claude 实机+读码，针对 b9965932）

> **历史归档**：本清单针对提交 `b9965932`（2026-11-22）。文中 P0–P4 问题均已于 `7596c2f5`–`86c0a25b` 及后续轮次完成修复，CI / eslint / lint-guard / `test:smoke` 现已恢复，部分早期测试文件已在后续测试整合中归并；本文件仅作历史溯源参考。

修复顺序建议：P0 正确性/数据丢失 → P1 功能不可用/与 web 不一致 → P2 模型额度浪费 → P3 测试与工程化 → P4 细节。
每修完一组请在 board 汇报并在提交信息里写明修复编号。

### EricWang1358 @ 2026-11-22T07:14:20Z

## 审查结论（针对 `b9965932`，Windows 11 本机实测）

能启动、能刷题，但选择题模拟考和口试实测是坏的，自带测试在 Windows 上也不是全过。建议先修「一、二」两组再合并。

下面路径省略前缀 `packages/studyhub-tui/`。标注：**实机** = 在真实 Windows 伪终端（ConPTY）里复现；**读码** = 对照后端代码核对过；**待核** = 只读过 TUI 一侧，没逐条复核。

### 本机运行情况

- 构建通过，`npx tsc --noEmit` 0 错。
- 用临时学习库和临时 `DSH_HOME` 启动：启动页、载入示例课、学习库、帮助浮层、刷题（翻卡 → 评分 → 下一题）正常；学习库页按 `q` 退出码 0，终端恢复正常。
- 不带 `WT_SESSION`（模拟老 PowerShell 窗口）80x24：自动切成纯 ASCII 边框，布局完整。
- 启动耗时：首帧约 1.4–1.7 秒，到能操作的学习库约 4.3–7 秒（示例课小库）。说明里的「冷启动 54ms」没复现出对应口径。
- 没验证：真实模型调用；真实窗口里的字体和字符宽度；资料导入、出题、音频、笔记、看板、任务页的实际操作。

### 一、功能直接坏掉

1. **选择题模拟考开不了**（实机）。按一次 Enter 发了两次 `review.start`：`src/views/exam/ExamSetup.tsx:112-113`（自己的 `useInput`）和 `:227`（`SelectList` 的 `onSelect`）各发一次。后端开第二场时会关掉第一场（`lib/contexts/study/operations.js:658`），界面留下哪一场取决于后端先处理哪个。实测第 1 题按 `1` 显示 `Review has ended`，选不了、切不了题，交卷报 `Exam has ended without submission`。调用追踪 3 次都是两次 `review.start`，间隔约 70ms。碰巧能考时也会多留一场被关掉的空考卷。
2. **口试没有可选范围**（实机）。`src/views/exam/utils.ts:69` 用 `cardCount` 过滤题组，后端题组行的字段叫 `count`（`lib/contexts/library/operations.js:342`），没有 `cardCount`、`dueCount`、`wrongCount`、`cards`。示例课 9 道题，口试页显示「当前课程暂无可用考题」。同一原因：侧栏错题数恒为 0（`src/shell/data.ts:167`），到期数回退读不到（`src/shell/data.ts:163`）。
3. **知识骨架每个节点掌握度都是 0%**（读码）。`src/views/skeleton/SkeletonView.tsx:378-397` 从 `snapshot.decks[].cards` 建索引，后端快照不带 `cards`。
4. **复习全书「应用总纲重组」必失败**（读码）。`src/views/book/BookView.tsx:361` 没传 `outlineId`，`lib/course-book-rebuild.js:42` 要求它等于当前总纲 id。

### 二、会丢数据或误操作

5. **Ctrl+K 能在弹窗上面再开命令面板，底下弹窗照样收键**（读码，未实机复现）。`src/shell/AppShell.tsx:111-115` 只看 `overlayOpen`，不看 `inputCaptured`；`src/components/ConfirmDialog.tsx:40-52` 默认一直收键。删除确认框开着时按 Ctrl+K，搜索词里带 `y` 就等于确认删除。编辑笔记时 Ctrl+K 还同时是「删到行尾」（`src/components/TextInput.tsx:250-253`）。
6. **看板文件读失败就当成空看板，下一次保存把原文件覆盖**（读码）。`src/views/board/board-store.ts:128-135`。
7. **刷题页 `q` 立刻结束本轮，没有确认，结束后不能恢复**（实机）。`src/views/review/ReviewView.tsx:749-752`。说明里 `q` 写的是「退出」。一题没答按 `q` 就进了「本轮练习总结 已结束 已答 0/9」。
8. **删除运行中的任务提示「任务记录已移除」，其实没删**（读码）。`src/views/tasks/TasksView.tsx:756-771` 只看 `res.ok`，后端对运行中任务返回的是 `skipped`（`lib/contexts/jobs/operations.js:297`）。
9. **「先归档再删除」中途失败会留下半截**（读码）。`src/views/library/LibraryView.tsx:309-330`、`src/views/sources/SourcesView.tsx:288-319`：归档成功（并关掉该题组进行中的练习）后删除失败，界面只说「删除失败」。
10. **题组改名会把一份没改完的编辑草稿整份发布**（待核，很可能）。`src/views/library/DeckManageModal.tsx:564-607` 走 `deck.edit` → `draft.save` → `draft.publish.quick`，已有编辑草稿时 `deck.edit` 返回旧草稿（`lib/contexts/bank/operations.js:144-145`）。
11. **草稿里按 `x` 删题无确认、无撤销**（待核）。`src/views/generate/DraftEditor.tsx:363-369`。

### 三、会白花模型额度

12. **骨架页 `g`**（读码）：先调一个后端已退役、必被拒绝的动作（`SkeletonView.tsx:554`；`lib/workflow-skeleton.js:170`），再不经确认直接调模型（`:593`）；模型输出不能用时悄悄换成「按主题机械归并」并提示「已创建知识骨架」（`:606-642`）。
13. **备考页 `g`/`G`、考试教练 `g`/`A`、保存教练笔记后自动分析**（待核）：没有估算、没有确认，按键处理不看忙碌状态，连按两次提交两次。`src/views/examprep/ExamPrepView.tsx:299-309`、`src/views/examcoach/ExamCoachView.tsx:396-419`、`:440`、`:267`。`StudyPlanModal.tsx:502-554` 是对的写法（先估算、再确认、忙时不收键）。

### 四、另起了一套，和 web 结果会不一致

宿主层做对了：`src/host/tui-host.ts` 直接复用桌面版的 `createDesktopHost`，用到的 174 个动作名后端都有；判分、FSRS 排期、统计、备考计划都是后端算。没复用的地方：

14. 看板是 TUI 自己存的一份 `<学习库>/tui-board.json`，和 web 看板不是同一份，只单向同步；本地删掉的同步卡下次又回来（`src/views/board/board-store.ts:339-358`）（待核）。
15. 自评只有 4 档，映射成 1/3/4/5 分，web 是 0–5 六档；评 3 分是否自动下一题写死成 `>= 4`，web 是 `>= 3` 且跟用户设置走。`src/views/review/review-helpers.ts:113-118`、`ReviewView.tsx:362`（待核）。
16. 资料分组在客户端重写，少了「跳过旧版本」和「跳过考点清单/总纲」两步。`src/views/sources/source-helpers.ts:196-313` 对 `lib/source-groups.js:282-294`（待核，很可能）。
17. 阅读器「保存问答到笔记」手工拼了一遍，后端已有 `note.qa.add`（`AiHelpDrawer.tsx:246` 用的就是它）；批注锚点固定是页首 360 字。`src/views/sources/ReaderNotesDrawer.tsx:184-252`（待核）。
18. 导入题组 JSON 的预检比后端严，题干里有单反斜杠 LaTeX 的文件 web 能导、TUI 报解析失败。`src/views/library/DeckOpsModal.tsx:95-139` 对 `lib/bulk-import.js:69-84`（待核）。
19. 「同型组卷检查」用的是压缩过的参数（每类最多 5 题、每题 2 分/90 秒，后端默认 5 分/180 秒）。`src/views/examcoach/ExamCoachView.tsx:371-394`（待核，很可能）。

### 五、测试和工程

20. **说明写「TUI 167/167」，Windows 本机不是全过**（实机）。`npm test` 共 170 条：第一次 2 挂，第二次 6 挂。
    - `tests/cross-platform.test.mjs:109`：`shouldAutoAscii({})` 期望 false，Windows 上必为 true，必挂。
    - `tests/round14-e2e.test.mjs:580-585`：断言屏幕上有库目录名，Windows 临时路径长，被截断后看不到，必挂。
    - `tests/deep-views-e2e.test.mjs:282`：就是第 1 条的竞态，单跑 3 次挂 2 次，一挂连带后面 3 条。
21. **TUI 的测试和类型检查不在 CI 里**（读码）。`scripts/test.mjs`、`.github/workflows/verify.yml` 里没有这个包；根 `eslint.config.js:112` 只管 `.js/.mjs`，`.ts/.tsx` 没有 lint。CI 全绿不代表 TUI 没问题。
22. **按说明装完 TUI 依赖后，仓库自己的测试会挂一条**（实机）。`tests/lint-guard.test.mjs:15` 会扫 `packages/` 下所有 `.js/.mjs`，把这个包的 `node_modules/**` 和 `dist/**` 里的 `eslint-disable` 注释都算成违规。CI 不装 TUI 依赖所以是绿的。
23. e2e 测的是 `dist/`，但 `npm test` 不先构建；`package.json:17` 的 `test:smoke` 指向不存在的文件（读码）。
24. 测试几乎只断言「屏幕上出现某段字」；提交评分后数据是否落盘、口试、骨架生成、全书重建、备考页都没测；`tests/host.test.mjs:573` 在 Windows 上直接 `return`，算通过而不是跳过（待核）。

### 六、小问题

- ASCII 模式下还有没降级的字符：`TextInput.tsx:298`、`BoardCardModal.tsx:104,124,159,189`、`ModelsTab.tsx:375-398,824,830,852`（待核）。
- 侧栏右列数字有时是快捷键、有时是数量（实机：学习库显示 2、资料 2、创建题组 1，错题本却是快捷键 4）。
- 设置页学习库路径从尾部截断，看不到最后的文件夹名（实机）。
- 后端英文报错原样显示在中文界面（实机：`Review has ended`）。
- 答案区显示「讲义 第 0 页」，像是页码少加了 1（实机看到，没核对）。
- 启动阶段按的键会被丢掉（实机）。
- 番茄钟离开看板页就清零（`PomodoroBar.tsx:52-76`）；多行输入靠 Alt+Enter 换行，Windows Terminal 默认把它占成全屏（`TextInput.tsx:189`）（待核）。

### 仓库级检查（在 PR 头上跑）

- `npm run lint`：通过。
- `node scripts/test.mjs --fast`：11589 条，3 挂。一条是第 22 条；`tests/practice-tips.test.mjs:189` 和 `tests/study-materials-perf-regression.test.mjs:190` 与本 PR 无关（TUI 包以外只改了 `package.json` 3 行）。
- 打包：根 `package.json` 的 `files` 不含 `packages/`，对现有发布没有影响。


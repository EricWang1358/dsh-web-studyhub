---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-14T21:30:00Z"
title: "dsh-daily-flashcard perf/panel-load: sharded storage, coach fixes, and the planned global todo board"
summary: "perf/panel-load 分支（未推送、未开 PR）完成：分片存储、打开/做题提速、陪学改题与提示修复、agent 资料搜索、宿主重启后 405 自愈；147 测试通过。下一项是用户要求记录、暂不实现的全工作区待办看板（类 Trello）。"
keywords: ["dsh-daily-flashcard", "perf", "sharded-store", "coach", "source.search", "transport-405", "todo-board", "kanban", "handoff"]
cwd: "D:\\A\\1NUS\\1Sem\\dsh-daily-flashcard"
resume_focus: "先确认用户是否要推送 perf/panel-load 并开 PR；然后按本文「待办看板」设计实现全工作区待办备忘"
repository: "EricWang1358/dsh-web-studyhub"
branch: "perf/panel-load"
base: "main (29df363, PR #1 merged)"
head: "see git log; last code commit 40f0393"
worktree_path: "D:\\A\\1NUS\\1Sem\\dsh-daily-flashcard"
---

# Handoff：perf/panel-load 进度与全工作区待办看板设计

## 当前状态

- 分支 `perf/panel-load` 基于已合并的 `main`（PR #1），**全部提交在本地，尚未推送、未开 PR**。用户说「用一段时间确认没问题后再推」。
- `npm run verify`：lint 0 错误（7 个旧 warning），**147 测试全过**，构建成功。
- **DSH 直接加载这个仓库**：`~/.dsh/profiles/{web,study-validation,study-validation-web}/node_modules/@ericwang1358/dsh-daily-flashcard` 都是指向本仓库的链接。切分支或 `npm run build` 会立即改变 DSH 实际运行的插件；服务端改动需重启 `dsh web`，界面改动刷新页面即可。
- 用户真实学习库 `D:\A\1NUS\1Sem\SWE5001\.dsh-study` **已迁移为分片格式（版本 2）**，原单文件在 `backups/study-workspace-v1-*.json`。切回 `main`（旧版插件）会看到「版本太新，请更新插件」，回退需用备份替换 `study-workspace.json`。

## 本分支已完成（按提交）

| 提交 | 内容 |
|---|---|
| `bee6e09` | 宿主取会话目录改用 `sessionPersistence.stat`（只读会话头）并按会话缓存，不再用 `observeSession` 回放整份日志；快照指纹基于文件 stat，没变化时不读库；首屏两个请求并行；宿主请求 >1s 打 `[study-workspace] … took` 日志；陪学改题在答案不变时原地更新已答题；改题与备题分队列；无 off/low 档位时取最低档；「太难」基础题自动设为原题前置；定制题显示「变式 · 源自…」 |
| `69176d9` | 作答/翻卡/下一题后不再整包刷新 1MB 快照；旧逻辑冻结的已答题自动修复为新版；改题干时要求答案、解析、选项同步 |
| `69b1e58` `01f4093` | **分片存储**：`study-workspace.json` 变为清单，资料/题组/草稿/每轮练习各一个内容哈希分片，作答记录每 1000 条一片，陪学日志各一片；只写变化分片后原子替换清单并清理旧分片；读取按清单 stat 缓存；写入从已提交分片文本重建私有副本；服务返回值为独立拷贝；v1 单文件首写时备份并迁移。真实库副本并发实测：作答 325–740ms→约 55ms，轮询 0.5–1s→1–2ms，最长卡顿 484ms→38ms |
| `83c16e7` | agent 新动作 `source.search`（一次搜遍资料，只返回片段+偏移）、`source.list`、`card.search`；工具说明、系统提示和「不会？问 AI / 提升质量」预填改为先搜索。起因：agent 为查 Agile/Scrum 连调 80+ 次 `source.get` 且漏掉 PDF03 |
| `21c4a8d` | 填空题显示 `cloze.text`：`card.update` 与陪学改题现在能改它（只改 prompt 且空格标记一致时自动同步）；「请按新版重新作答」只在已作答时出现。已修复用户库中 4 张受影响卡（复习进度因题干变化重置，可 `card.revert`） |
| `f822fd4` | 陪学点按题型取学习者真实答案（填空答案原被空 `selected` 数组遮住），提示词针对该答案解释并要求小检查无歧义；陪学栏显示「你的答案 · 应为」 |
| `40f0393` | 宿主重启后 `HTTP 405`：前端曾在一次 404/405 后永久改走不存在的旧接口。现在只有旧接口真正成功才切换，否则抛可重试错误；首屏加载对这类错误退避重试并显示「正在连接学习插件…」 |

## 已知问题 / 未做

- 每次重启 DSH 后，每个会话首次打开仍约 1.4s：宿主 `stat` 会逐个工作区目录找日志（日志已证实）。可选：把「会话→目录」缓存写盘；在慢日志里标明走的是 stat 还是 observeSession。
- 作答后侧栏「回到题目 x/y」要等下一次 2.5s 轮询才更新（为省掉每次点击的整包快照而有意为之）。
- 每次答错都会调用一次陪学模型，暂无每日/每轮上限；agent 通过工具调用 `review.answer` 答错也会触发预取。
- 陪学 token 用量未记录（宿主流式返回里有 `cacheReadTokens` 等，插件只取了文本）。
- 分片写入仍需重新解析全部分片 + 序列化全部分片来找变化（约 50ms/次），若要再快需要按集合声明脏数据。
- 新建对话「选择工作区」失灵一次，重启后恢复，未定位；若复现按：不打开学习页 → 切回 main → 从 profile 暂时移除本插件，逐步对照。

## 待办看板（用户要求记录，暂不实现）

用户原话：「添加一个全工作区可见的待办备忘，类似于 Trello 看板」，入口在左侧导航「错题本」下方（截图箭头位置）。

### 建议设计（实现前可与用户确认细节）

- **存储**：与全局笔记本目录同级，`~/.dsh/study/board.json`（遵循 `DSH_HOME`），不放进任何学习库，所以所有工作区看到同一块板。复用 `lib/notebooks.js` 的 `updateRegistry` 模式：目录锁 + 临时文件原子替换；带 `revision`，写入时校验，防止两个窗口互相覆盖。
- **数据**：`{ version, revision, columns: [{id, title, cardIds}], cards: {id: {title, note, due?, labels?, createdAt, updatedAt, origin: {workspace, workspaceTitle, deckId?, cardId?}}}, archived: [...] }`。默认三列「待办 / 进行中 / 已完成」，列可增、改名、删除（仅空列）。
- **动作**（宿主 handler 与 `notebook.*` 同样不依赖学习库；`scripts/dev.mjs` 同步镜像；agent 工具也开放，便于在对话里说「帮我记一个待办」）：`board.get {since?}`（未变化返回 `unchanged`）、`board.card.add {column?, title, note?, due?, link?}`、`board.card.edit`、`board.card.move {id, column, index}`、`board.card.remove`/`archive`、`board.column.add/rename/remove`。卡片自动记录创建时的工作区；点击来源可用现有 `host.openWorkspaceNotebook(cwd)` 跳到那个工作区。
- **界面**：`ui/Board.jsx` + `ui/views.css`，导航项「待办」带未完成数徽标（非「已完成」列的卡数）。
  - 列横向排列，窄屏横向滚动；列内卡片可拖拽排序、跨列移动（HTML5 DnD），并提供键盘/按钮移动（←/→ 换列、↑/↓ 排序）作为无障碍替代。
  - 列底「＋ 添加卡片」行内输入，回车即添加；点卡片打开编辑弹层（标题、备注 Markdown、截止日期、标签）。
  - 看板页可见时每 5s 轮询 `board.get {since}`，其他页面只在导航徽标需要时低频刷新。
- **可选增强**（未经用户确认）：做题页工具栏「记到待办」，把当前题目以链接形式加为卡片；到期提醒在学习库首页显示。
- **测试**：并发写冲突（revision）、`DSH_HOME` 隔离、跨列移动顺序、删除非空列被拒、损坏文件降级为空板且不覆盖原字节。

## 下一步建议

1. 问用户是否推送 `perf/panel-load` 并开 PR（base `main`）。
2. 实现待办看板前，确认：默认列名、是否需要标签/截止日期、是否要做题页「记到待办」。

# StudyHub TUI 常驻 AI 助手全流程融入设计规范（#1315）

> 核心标准：**用户不用学就会用**。助手不是外挂弹窗，而是随叫随到、知道上下文、不抢焦点、可撤销、永不走进死路的右侧工作台。

---

## 1. 十条设计原则

1. **一键可达**：任何页面按 `Ctrl+Space`（或 `Ctrl+G`）唤出，无需切页；所有停靠页面统一采用两步 `Esc`（退出输入 → 退出全屏 → 先把键盘还给页面且面板继续显示 → 再按一次 `Esc` 收起面板；聚焦面板时单字母键统一由 `KeyDispatcher` 隔离，绝不穿透到左侧页面），保留会话历史与带学阶段。
   - 面板只显示当前这道题的对话；之前的对话收成顶部一行，按 `o` 展开 / 收起（#1426）。发给模型的最近对话也只取当前这道题的。
2. **知道自己在哪**：打开即自动携带当前上下文（页面、课程、当前题目/序号/是否答错、作答草稿、练习上下文栈），顶部单行上下文条明确回显，用户不用解释「这题是哪题」。
3. **先给 Chips 再给输入框**：顶部固定呈现 **2–4 个与当前场景最相关的快捷动作**（键盘 `[1]–[4]` 直达，也支持 `Alt+点击`），底部才是自由输入框。
4. **不抢焦点、不挡内容**：右侧停靠分栏（窄屏退化为上下分栏），**严禁用模态框盖住题目**。`Ctrl+Space` 初次打开时默认**停靠不抢焦点**，用户仍可直接按 `1-6`/`Space`/`Enter` 答题或翻页；再按一次 `Ctrl+Space`（或 `Ctrl+G` / `Alt+点击`）聚焦助手；`[F]` 切换全屏，`Esc` 退回分栏。
5. **执行前说清、执行后给结果 + 撤销**：除用户在 6 项错因列表中显式点选 `pick_error_reason` 直接写回并提供 `[z]` 撤销外，其余写操作/导出/耗额度操作均经 `ConfirmDialog` 展示「将执行：动作 + 参数」预览；执行后给出一行中文结果并提供 `[z]` 撤销入口（支持错因标记、页面导航等可逆动作）。
6. **永不走进死路**：超出范围或模型不可用时，不报错卡死，直接给出**最近替代动作（`[A]`）** + **`[P]` 复制带上下文的提示词**（优先 OSC 52，失败原子落盘至 `<library>/backups/copy-<time>.md`）。
7. **延迟可感知**：流式输出；执行动作立即显示「正在执行：xxx」；超过 **2 秒** 自动提示进度与 `Esc` 中止（一次性定时器，空闲零轮询）。
8. **语言一致**：全程简洁中文短句（英文模式下为简洁英文短句），不复述用户原话，不暴露英文堆栈。
9. **越用越顺手**：仅对已注册推荐 Chip ID（`ASSISTANT_CHIP_CATALOG`）按页面统计频次并持久化至 `tui-usage.json`（上限 16 页 × 20 条，不写入 `tui.json`，自由输入文本仅驻留本次会话内存）；**同一推荐 Chip 重复执行 ≥ 3 次自动晋升为该页常驻 Chip**，最近使用自动置顶。
10. **键盘优先**：所有动作均有纯键盘路径（`Ctrl+Space`/`Ctrl+G`、`1-4`、`i`、`Tab`、`z`、`P`、`c/C/y`、`F`、`S`、`Esc`），`Alt+点击` 仅为叠加补充。

---

## 2. 布局与停靠几何

| 终端尺寸 / 模式 | 主内容区 | 助手面板位置与尺寸 | 焦点策略 |
| --- | --- | --- | --- |
| 宽屏停靠（主区可用宽 ≥ 78 列） | 左侧 `columns - navW - dockW - 2` | 右侧停靠 `dockW = clamp(36..66, 46%)`，高 `bodyH` | `Ctrl+Space` 打开时不抢焦点，主区保持 `isActive=true` |
| 窄屏停靠（主区可用宽 < 78 列） | 上方 58% 高度 | 下方 42% 高度（仍不遮挡题干） | 同上 |
| `[F]` 全屏模式 | 隐藏侧栏与主区 | 占满 `columns - 2` × `bodyH` | 助手聚焦；`Esc` 退回分栏 |
| 独立挂载默认尺寸 | — | `min(columns - 4, 120)` × `rows - 2` | — |

---

## 3. 智能 Chips 排序与晋升规则（`src/shell/assistant-chips.ts`）

展示上限为 **4 个 Chip**，按以下优先级去重填满：

1. **练习上下文栈返程项（最高优先）**：位于非刷题页且 `practiceStack.length > 0` 时，固定首位显示 `[1] 回到第 N 题`。
2. **高频晋升项（`count >= 3`）**：当前页重复使用 ≥ 3 次的指令自动晋升，按最近使用时间倒序置顶（高亮标记）。
3. **当前场景默认项（最近使用上浮）**：
   - 刷题页 · **答错状态**：`通俗讲解`、`标记错因`（列出六个错因供选择，不替你决定）、`带学复述`、`查看统计`
   - 刷题页 · **未作答 / 卡住状态**：`苏格拉底带学`、`通俗讲解`、`查看统计`、`看资料原文`
   - 错题本页：`导出本课错题`、`查看统计`、`开始刷题`、`进入带学`
   - 资料页：`去创建题组`、`查看统计`、`打开错题本`、`进入带学`
   - 其他页面：`查看统计`、`打开错题本`、`打开资料库`、`进入带学`

---

## 4. 统一带学与复述阶段 + 复制规则

- 双 Tab（`Tab` 切换）：**助手** 与 **带学** 共用同一会话上下文与输入框，切 Tab 不丢进度。
- 刷题页统一收敛为单一入口：`[t]`（兼容 `T`）打开常驻助手「带学」Tab 并直接驱动后端 `teach.get`/`teach.start`/`teach.answer`/`teach.skip`（`[S]`/`Ctrl+N` 跳过单步、`[X]` 展示剩余要点、`[M]` 切换模式）；`[F]` 打开费曼复述（`teach.retell`）；助手内显式进入 `stage=retell` 时复用同一 `submitRetellEvaluation` 并支持 `[S]` 跳过复述记录 `stage=retell, skipped=true`。
- 复制快捷键：`c` 复制当前条目、`C` 复制完整会话（含题目 / 我的作答 / AI 讲解 / `[阶段: ...]` 标记）、`y` 复制最后一条回答、`P` 复制兜底提示词。优先走 OSC 52（含 tmux DCS 透传），失败原子落盘至 `<library>/backups/copy-<time>.md` 并提示字数/路径。

---

## 5. 失败与边界兜底

| 异常场景 | 面板表现 | 兜底出口 |
| --- | --- | --- |
| 超出能力范围（如发邮件/系统命令/外部联网） | 中文短句说明边界（不复述原话） | `[A]` 执行最近替代动作 + `[P]` 复制带上下文提示词 |
| 未配置模型 / 模型超时不可用 | 提示本地导航与导出仍可用 | `[A]` 跳设置配模型 + `[P]` 复制提示词 / 复述阶段 `[S]` 跳过 |
| 动作执行失败（读/写动作返回 `succeeded: false` 或写盘失败） | 经 `reportFailure` 输出 `执行失败：<动作>` / `Failed: <label>` + 可读原因（绝不显示「已完成」） | `[A]` 重试这条指令 + `[P]` 复制带上下文提示词（多步工作流中止时经 `offerRetry` 同样保留 `[A]`） |
| 写操作 / 导出 | `ConfirmDialog` 展示「将执行：动作+参数」 | 取消则零副作用；执行后提供 `[z]` 撤销 |
| 执行超过 2 秒 | 显示「正在执行：xxx（耗时较长，请稍候，Esc 可中止）」 | `Esc` 立即中止并清理定时器 |

### 5.1 失败态与无副作用路径「已完成」文案防回退对照表（PR #1478 / #1354）

> 统一原则：**只在后端或磁盘真正产生副作用时，才允许使用完成态文案**。PR #1478（提交 `233ba903`）在面板侧引入统一失败出口（`AssistantPanel.tsx`：`offerRetry` L355–370、`reportFailure` L372–385、`executeConfirmedWrite` L578–590 / L603、`handleSubmitInput` `run_action` L844–854），并逐处核对助手链路 26 处「已完成 / 已执行 / 已保存」文案后，修正以下 **6 处**不诚实或无副作用却标完成的路径（行号均对应 PR #1478 `head`）：

| # | 位置（文件 + 符号/分支） | 触发场景 | 修复前误导文案 | 修复后真实文案（中 / 英）与恢复动作 | 防回退自动化覆盖（`packages/studyhub-tui/tests/assistant-intent-execution-coverage.test.mjs`） |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/shell/assistant-actions.ts:100-111`<br>`executeAssistantReadAction`（`review.similar` 且 `items.length === 0`） | 只读同类题查询成功返回，但题库无匹配结果（零数据改动） | `actionSummary`: `已完成：查找同类题` / `Done: similar lookup`<br>`text`: `当前题库中暂未找到与本题匹配的同类题。` | **中**：`未找到同类题（只读查询）`；正文说明「未改动任何数据；可以换个说法再试。」<br>**英**：`No similar questions found (read-only)` / `No matching similar questions in the library; nothing changed. Try rephrasing.`<br>**恢复**：提示换个说法再试（零副作用，不标「已完成」） | `失败结果一律不出现「已完成/已执行/已保存」，且给出可读原因`（子用例 2 覆盖 `review.similar` 无题目上下文失败态；`items.length === 0` 空命中分支当前尚未单独建测，改动需人工核对或补测） |
| 2 | `src/shell/AssistantPanel.tsx:963-980`<br>`handleSubmitInput`（`intent.kind === 'readonly_stats'`） | 查询本地学习统计（如「今天有多少题到期」），0 模型调用、零数据改动 | `actionSummary`: `已完成：只读统计（0 模型调用）`（无英文分支） | **中**：`只读统计（0 模型调用，无改动）`<br>**英**：`Read-only stats (0 model calls, nothing changed)`<br>**恢复**：纯只读展示统计数据，零副作用、无需撤销 | `只读统计与导航不再冒充「已完成」`（面板渲染断言不含 `已完成：只读统计` 且含 `无改动`/`0 模型调用`）；`意图「看统计」：今天有多少题到期 -> snapshot 且真实链路成立` |
| 3 | `src/shell/AssistantPanel.tsx:878-906`<br>`handleSubmitInput`（`intent.kind === 'navigate'`） | 自然语言切换 TUI 页面（如「跳到统计」），仅变更前端导航而非学习写操作 | `actionSummary`: `已完成：${intent.actionName}（${intent.paramsSummary}）`（滥用「已完成」且泄漏内部动作名 `navigate(...)`） | **中**：`已跳转：${intent.paramsSummary}`；正文 `已定位至 ${page}…。按 [z] 可撤销。`<br>**英**：`Navigated: ${intent.paramsSummary}`；正文 `Navigated to ${page}…. [z] undo.`<br>**恢复**：`[z]` 撤销返回原页面与 `navContext` | `意图「跳页」：跳到统计 -> navigate(dashboard) 且真实链路成立`（校验真实切页；注：面板测试 `只读统计与导航不再冒充「已完成」` 标题含导航但用例体目前仅执行统计指令，后续可补导航面板断言） |
| 4 | `src/shell/AssistantPanel.tsx:909-960`<br>`handleSubmitInput`（`intent.kind === 'set_preference'`，`persist` 写 `tui.json`） | 切换主题/紧凑模式/主动提示时，`saveTuiPreferences` 写盘失败（如只读目录、文件损坏）；以及写盘成功时的摘要 | 用 `void saveTuiPreferences(...).catch(() => {})` 吞错，照常输出 `已完成：${intent.actionName}（${intent.paramsSummary}）` 与「并持久化」 | **写盘失败（`!applied.ok`）**：走 `reportFailure`，标题 **中** `执行失败：保存偏好 ${paramsSummary}` / **英** `Failed: Saving preference ${paramsSummary}`；正文说明「偏好已在本次会话生效，但写入 tui.json 失败：…」/ `Applied for this session, but writing tui.json failed: ...` + warning toast `偏好未保存`/`Preference not saved`；**恢复**：`[A]` 重试 / `[P]` 复制提示词。<br>**写盘成功**：**中** `已应用并保存：${paramsSummary}` / **英** `Applied and saved: ${paramsSummary}`；**恢复**：`[z]` 撤销（撤销写盘失败亦抛错不静默） | `意图「换主题」：切换到护眼模式 -> preferences.set 且真实链路成立`（验证真实落盘并可重读）；通用失败态 `[A]` 重试由 `失败（无解答可存笔记）显示原因 + [A] 可重试，且绝不显示已完成` 覆盖（`!applied.ok` 写盘故障分支尚未单独模拟） |
| 5 | `src/shell/assistant-actions.ts:539-551`<br>`executeAssistantWriteAction`（`case 'export.wrongbook'` 且 `!wb.ok`） | 确认导出错题本后，后端 `wrongbook` 读取接口返回失败（`!wb.ok`） | 未校验 `wb.ok`，把 `wb.value?.items` 当空数组写出「当前暂无错题记录」空文件并报 `已完成：导出 0 道错题` | 返回 `succeeded: false`，**不写文件**。<br>**中**：`读取错题本失败`（面板包装为 `执行失败：读取错题本失败`），正文优先展示 `wb.error.message` 或 `读取错题本失败，未写出导出文件，请稍后重试。`<br>**英**：`Could not read the wrong-book`（面板包装为 `Failed: Could not read the wrong-book`），正文兜底 `Could not read the wrong-book; no file was written.`<br>**恢复**：`[A]` 重试这条指令 / `[P]` 复制带上下文提示词 | 面板 `reportFailure` + `[A]` 重试链路由 `失败（无解答可存笔记）显示原因 + [A] 可重试，且绝不显示已完成` 覆盖（`!wb.ok` 读接口异常分支尚未在覆盖测试中单独注入故障） |
| 6 | `src/shell/assistant-actions.ts:555-565`（附单题缺题干保护 `L520`）<br>`executeAssistantWriteAction`（`case 'export.wrongbook'` 且 `items.length === 0`） | 错题本读取成功但范围内无错题（`items.length === 0`）；或单题导出缺少 `promptText` | 写出仅含「当前暂无错题记录。」的空 Markdown 文件并报 `已完成：导出 0 道错题`（单题缺题干时写入占位文本 `当前题目` 并报完成） | 返回 `succeeded: false`，**不写任何文件**（与 `WrongBookView` 一致）。<br>**中**：`没有可导出的错题`（面板包装为 `执行失败：没有可导出的错题`），正文 `当前范围内没有错题，未写出导出文件；先做几道题再来导出。`<br>**英**：`No wrong cards to export`（面板包装为 `Failed: No wrong cards to export`），正文 `No wrong cards in this scope; no file was written. Try a few questions first.`（单题缺题干走 `needCardOutcome`）。<br>**恢复**：提示先做题再导出；面板保留 `[A]` 重试 / `[P]` 复制提示词 | `失败结果一律不出现「已完成/已执行/已保存」，且给出可读原因`（子用例 3：空错题本导出断言 `succeeded === false`、无完成字样且 `backups/` 不存在）；正向对照：`成功的写动作（导出错题本）才标完成，并且真的写了文件` |

### 5.2 防回退守则（禁止事项）

1. **严禁无副作用或失败路径冒用完成态**：任何 `succeeded === false`、`ok === false`、`!applied.ok`、空结果只读查询、能力边界拦截（`kind === 'boundary'`）或仅启动后台任务的动作（`assist.start` 只能标「已启动」，不得标「已完成」），一律禁止复用「已完成 / 已执行 / 已保存」或 `Done` 文案与成功提示。
2. **严禁吞错降级成假成功**：写盘、导出或后端调用异常禁止 `.catch(() => {})` 静默忽略，也禁止在读取失败或数据为空时落盘空文件/占位文件再汇报成功。
3. **严禁泄漏内部动作名**：`actionSummary` 与提示正文面向学习者，禁止直接拼接 `navigate(...)`、`preferences.set` 等内部动作标识符，必须使用双语人类可读短句。
4. **失败态必须带可读原因与明确恢复出口**：所有失败必须经 `reportFailure` / `offerRetry` 保留中/英可读错误原因并提供恢复动作（`[A]` 重试原指令、`[P]` 复制带上下文提示词；可逆操作配 `[z]` 撤销；慢任务配 `Esc` 中止），且复用现有快捷键路由，不得新增裸 `useInput`。
5. **新增意图或失败路径必须同步补测试**：每新增或改动助手意图、读/写动作或失败分支，必须同步更新 `packages/studyhub-tui/tests/assistant-intent-execution-coverage.test.mjs`，覆盖真实 `StudyService` 执行链路与负向文案断言（确保失败/边界/无副作用输出不匹配 `/已完成|已执行|已保存/`）。

---

## 6. 进阶能力（Round 88–98）

- **多步自然语言工作流（`src/shell/assistant-workflow.ts`）**：支持「先 X 再 Y」顺序分解与清单展示；遇到任意写操作/导出步骤自动暂停并弹出 `ConfirmDialog` 逐步确认，绝不静默越过边界。
- **自然语言直达设置与考期编排（`src/shell/assistant-intent.ts`）**：支持「帮我按考期倒推排备考计划」「切换夜间护眼主题 / 低对比度护眼浅绿」「开启紧凑模式 / 宽松模式」，零模型调用直达并支持 `[z]` 撤销。
- **结构化记忆压缩（`src/shell/assistant-memory.ts`）**：会话超过 32 轮时，自动将滑出窗口的早期轮次确定性压缩为单条结构化摘要头（含阶段/已执行动作/关键提问，≤ 220 字，零 token 消耗），避免上下文静默丢失或无限膨胀。
- **六类主动学习提示（严格三护栏）**：每日开场简报、单题卡壳 20s、连续答错 3 题、本轮结束下一步、临考 ≤ 14 天缺口提醒、连刷 25 题疲劳休息提示；全部受 `/proactive` 总开关控制、严格限频、非打断且零空闲轮询。

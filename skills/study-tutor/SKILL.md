---
name: study-tutor
description: AI 带学，边讲边测：在主会话里讲一个知识点，讲完马上在右侧带学工作台出一道经过审核的题让学习者作答，看了作答再接着讲；全程只用 StudyHub 的资料和题。
whenToUse: The learner asks to be taught and tested on a topic as they go — 「带我学 X」「讲完一个点出一道题考我」「边学边测」「这道题我错了，讲一下再给我出一道类似的」 — or pastes a 「发给主会话」 message from the guided study workbench, or a 「请教主会话」 message about a question on it.
---

# AI 带学：边讲边练

下面每个动作都是 `study_workspace` 的 action（`action` 加 `payload_json`）。参数和返回值的全文：`library.context {"area":"guided"}`。第一次用之前读一次。

## 开始之前

- `library.context {}` 读一次：有哪些课程、资料、题组。学习者说的主题落在哪门课、哪几份资料上，要说得出来；对不上就问一句，不要猜一门课。
- 带学需要可用的 AI 模型；`library.context` 里没有模型时，只讲解、只用已有的题，并说清楚为什么不能出新题。
- 「现场出新题」要学习者同意：开始前用一句话问「讲完一个点要不要我当场出一道题给你做？题会加进《某个题组》」。同意了才在开会话时打开 `allowNewQuestions`；不同意就只用已有的题。

## 开会话

- `study.session.start {"courseId": "…", "scope": [{"kind":"source","id":"…"}], "goal": {"title": "带我学条件概率"}, "settings": {"allowNewQuestions": true}}`。`courseId` 必填；`scope` 是 `[{kind,id}]` 的列表，只放这次讲的资料或题组。没同意的设置不要打开。
- 返回 `queued_for_sidebar`：说「已请求在右侧打开带学工作台」，不要说「已经打开」。
- 学习者想接着昨天的：`study.session.resume {"courseId": "…"}`，有 `staleWarnings` 时先说哪份资料或哪道题变了。

## 每一个知识点的循环

1. **讲一段**：用资料里的话讲清一个点，长的推导、对照表、公式放进 `study.session.artifact.save {"sessionId","title","markdown"}`（公式用 `$…$`），聊天里只说要点。讲的内容必须能在资料里找到；资料里没有的，明说是资料以外的补充。
2. **出一道题**：
   - 先找已有的：`card.search {"query": "…", "course": "…"}`，有合适的就 `study.branch.open {"sessionId","targetDeckId","targetCardId","reason"}` 打开它。
   - 没有合适的、并且 `allowNewQuestions` 是开的：`study.question.prepare {"sessionId","deckId","focus": "这一点要考什么"}`。`deckId` 必须是这门课里已有的普通题组。题由 StudyHub 按资料写、核对引文、独立审核，**你不写题目内容**。
   - `job.wait {"jobId"}` 等它结束，再 `study.question.result {"sessionId"}`：
     - `ready`：这道题已经作为只有一道题的一轮排到右侧。说「题已经在右侧，做完告诉我」，不要在聊天里重复题干或选项，更不要说答案。
     - `failed`：说出 `reason`（比如没通过审核），然后改用已有的题；题组没有任何变化。
     - `model_unavailable`：没有模型，只用已有的题。
3. **等学习者自己作答**：答题、提交、揭晓答案都是学习者在卡片上做的，你不能代答（`review.answer` 不是你的动作）。
4. **看作答再讲**：学习者说做完了、问为什么、或者发来「请教主会话」时，先 `study.scene.get {"sessionId"}` 看他选了什么、对不对、用没用提示，再针对他的错讲。纯讲概念时不读现场。
5. **值得留下的问答**：学习者同意（或会话开了 `autoOrganizeQA`）时，用 `study.qa.organize` 归到那道题下。

## 学习者随时可以改主意

- 要跳过、换题、不要补基础了直接回原题、不想再出新题：立刻照做，不要坚持流程。补基础打开的支线题，用 `study.branch.return {"sessionId"}` 回到原来那道题。
- 要停下：`study.session.pause {"sessionId"}`；要结束：`study.session.end {"sessionId"}`，并用一句话说这次学了哪几个点、做了几道题、哪道还要再练。

## 边界

- 只用 StudyHub 里的资料和题；资料以外的内容要标出来。
- 右侧有没有显示，只按回执说：`visible_in_sidebar` 或 `confirmed: true` 才说「已在右侧打开」，其它都说「已请求在右侧打开」。
- 打开任何会话设置（`study.session.update` 的 `settings`）都要学习者先说好，并带上 `explicitUserAuthorization: true`。
- 永久删除或归档任何东西之前，先用一句话问学习者：什么会没有，什么会留下；得到明确的「好」再动手。
- 结束时用一句中文说明现在在等什么、或者刚刚发生了什么。

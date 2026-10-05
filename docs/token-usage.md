# Token usage and estimates · token 用量与估算

StudyHub shows tokens, exactly the fields DSH's own session usage panel shows (Token 用量 / 缓存命中 / 未缓存输入 / 缓存读取 / 缓存写入 / 输出, with the `tok` unit). It never shows a price: take the numbers to your provider's price list. 本页回答「出一次题要用多少 token、该选什么模型和推理程度」。

## 中文

### 一次运行发给模型什么

| 功能 | 调用哪些阶段 | 每个阶段收到什么 | 典型输出 |
|---|---|---|---|
| 创建题组 | ① 提取证据：每组资料 1 次 ② 确定答案：每批 1 次 ③ 写题与自查：每批 1 次 ④ 独立审阅：每批 1 次 | ① 所选分组全文（每组最多 6 万字符）＋设置＋已有考点 ② 已核验的知识点及其选中资料 ③ 相同资料＋知识点＋具体答案方案 ④ 相同依据＋候选题及质量标准 | 按题型和实际批次估算各阶段输出；界面显示运行前的范围，任务结束后以实际用量为准 |
| 案例分析题 | ① 写案例和评分标准 1 次 ② 独立审阅 1 次（结构检查不过时再写 1 次） | ① 课程资料（合计最多 4 万字符，平均分给每份）＋真题模板（≤1.2 万字符）＋评分说明（≤6000 字符） ② 整套案例和题目 | 案例 600–1500 词（中文 900–2600 字）＋每题评分标准、参考答案，约 3–5 千 token |
| 案例批改 | 每次提交批改 1 次 | 案例原文＋所答题的评分标准＋你的回答（≤3 万字符） | 每个评分项约 50–100 token |
| 帮我想想 | 1 次轻量调用 | 资料标题和目录（≤3000 字符）、课程考试设置、≤6 个薄弱主题；不发送资料全文 | 几十到约 200 token |
| 学习流「生成完整讲解」 | ① 写讲解 1 次 ② 检查 1 次（没通过会重写，最多 4 次） | 主题、笔记、≤24 张卡片、≤1.2 万字符的原文依据、骨架 | 讲解 600–2500 字（补讲更短） |
| 音频文本步骤 | 校对：每 6000 字符 1 次；翻译：每 3500 字符 1 次；起标题 1 次 | 对应窗口的转写稿＋术语 | 校对很短；翻译约等于原文长度（换成另一种语言） |
| 陪学 | 每次提示、追问、改题、变式各 1 次轻量调用 | 一张卡片的摘要＋学习者画像（变式一次带多张卡和 ≤6000 字符依据） | 输出有上限：提示 450、追问 320、改题 1600 token |

转写本身（Gemini、Groq、SiliconFlow）不是 token，按音频分钟计，见「音频转写」页的「用量与额度」。

### 估算怎么来的

- 不调用模型、不联网。批次、分块用的是出题流程自己的函数；提示词用的是流程真正发送的那些字符串；DSH 有 `tokenMeter` 就用它估算，没有就用同一条规则（字符数 ÷ 4，加固定开销）。
- 范围的下限是 DSH 的固定估算，上限按 DeepSeek 公布的换算（中文每字约 0.6 token，英文每字符约 0.3）。DSH 自己也说它对中文偏低，所以中文资料的实际值通常更接近上限。
- 模型写出的内容无法预先构造，输出量按内置示例课程里的题目、案例和批改结果测得；案例长度取自提示词本身规定的字数。
- 缓存读取的下限永远是 0（第一次运行可能一点也不命中），上限是各次调用重复的系统提示词和说明。命中多少取决于服务商。
- 推理程度越高，推理 token 越多（计入输出）；推理 token 无法预先测量，所以只提示，不加数字。出错重试会让实际调用更多。

### 资料很多时

- 一次最多处理 60 万字符的资料（约 200 页普通 PDF）；超过会被拒绝，表单会直接告诉你「选了几份、最多能选前几份」，并给出最多能选的资料的用量。
- 提取证据会把每组资料完整读一遍（所以资料越多，这一步越贵）；之后每一批只带上考点选中的页。**缩小页码范围**是减少用量最有效的办法；题数少于页数时也不可能逐页考查。
- 单次调用的输入最大约 1.6–2.4 万 token（一个 6 万字符的分块加提示词），应按界面显示的最大单次输入选择有足够上下文容量的模型。

### 选什么模型和推理程度

StudyHub 使用你在 DSH 里选定的模型，不绑定某个模型。批量的记忆类题目用低档推理即可（更快、更省）；应用分析和案例题用高档（更慢、更耗额度，推理更严谨）。在「设置 › 学习库与模型」的「生成模型」旁的推理程度里调整。

### 实际用量记在哪

- 直接调用：读取服务商返回的用量；DSH 子代理（出题的每个阶段）：读取该子会话 DSH 自己的 `tokenUsage` 投影，读不到就按同一规则重放它的事件。四个桶互不重叠，推理 token 已包含在输出里，重试的那次调用另外累加。
- 每个任务的详情里有「实际用量」（并与出发前的估算对照）；「学习统计 › 模型用量」按功能（出题、改题与复核、陪学、学习流、案例、音频文本）列出近 7 / 30 天。数据只存数量，放在学习库里的 `model-usage.json`（保留 90 天，不含内容）。
- 记录失败不会影响任何任务。

## English

### What one run sends to the model

| Feature | Stages | What each stage receives | Typical output |
|---|---|---|---|
| Create question set | 1 evidence extraction per source group; 1 answer preparation, 1 write-and-self-check and 1 independent review per batch | Extraction: the full group (at most 60,000 characters), settings and existing objectives. Later stages: selected source text, verified targets and answer blueprints; review also receives candidate questions and quality criteria | Output is estimated by question type and actual batching. The UI shows a range before running; use recorded usage after the job |
| Case paper | 1 write the case and criteria; 2 independent review (one more write when the structure check fails) | 1 course materials (at most 40,000 characters in total, shared equally), a past-paper template (up to 12,000) and examiner guidance (up to 6,000); 2 the whole case and its questions | case 600-1,500 words (900-2,600 Chinese characters) plus criteria and model answers, about 3-5K tokens |
| Case grading | 1 call per submission | the case, the rubric of the answered questions and your answer (up to 30,000 characters) | about 50-100 tokens per criterion |
| Suggest a focus | 1 light call | material titles and headings (up to 3,000 characters), the course exam profile, up to 6 weak topics; never the full text | tens to about 200 tokens |
| Learning flow lesson | 1 write the article; 2 check it (a failed check rewrites: up to 4 calls) | the topic, notes, up to 24 cards, up to 12,000 characters of source evidence, the skeleton | 600-2,500 characters (a remedy is shorter) |
| Audio text steps | proofreading: 1 per 6,000 characters; translation: 1 per 3,500; 1 title call | the transcript window plus terms | proofreading is tiny; translation is about the source's length in the other language |
| Study coach | 1 light call per nudge, follow-up, rewrite or variant | a summary of one card plus the learner profile (variants: several cards and up to 6,000 characters of evidence) | output capped: 450 tokens for a nudge, 320 for a follow-up, 1,600 for a rewrite |

Transcription itself (Gemini, Groq, SiliconFlow) is not tokens; it is counted in audio minutes under Usage and limits on the Audio transcription page.

### How the estimate is made

- No model call, no network. Batching and chunking are the pipeline's own functions; the prompts are the strings the pipeline really sends; DSH's `tokenMeter` prices them when the host has it, otherwise the same rule (characters / 4 plus fixed framing).
- The low end of every range is DSH's fixed estimate; the high end uses DeepSeek's published conversion (about 0.6 token per Chinese character, 0.3 per English character). DSH itself says its heuristic underprices Chinese, so for Chinese material the real number is usually near the high end.
- What a model writes cannot be built in advance: output sizes are measured from the bundled sample course (questions, cases, gradings); case length is the length the prompt itself asks for.
- Cache read starts at 0 (a first run may hit nothing); its high end is the system prompt and instructions repeated between calls. How much hits depends on the provider. In practice every plan, writing and review step runs as its own one-off DSH session, and those did not share a cache: a measured 20-question run wrote 720,802 tokens to the cache and read none across 14 calls. The estimate does not count on a cache for its total, and a finished job says so when no call hit it.
- A finished job whose actual usage passes the upper end of its estimate says by how much; the estimate counts the prompts, not the model's own tokenization, reasoning or retries.
- A higher reasoning level means more reasoning tokens (counted in the output); they cannot be measured beforehand, so only a note is shown. Retries after an error add calls.

### What "already covered" costs

Plans and writing steps are told which learning targets already exist so they do not repeat them. They used to be sent the whole library: one measured library held 2,911 targets (about 55K tokens), repeated in 8 of the 14 calls of a 20-question run, more than half of the 765,472 tokens it used. A call now carries the targets of the deck or draft being added to or continued, plus up to 120 others that share wording with the chosen materials (a local comparison, no model call). The estimate prices exactly that list.

### Short drafts and top-ups

When review and the local checks drop questions, the draft keeps each dropped question's text and the reasons (`editorial.omitted`), shown on the job card, the draft card and the draft page as counts per reason and one line per question. There is ONE top-up, **Add questions for the uncovered parts** (为没覆盖的部分补题; on the draft page, the home card and the 任务 console's header). It is asked for the sections of the material that have no question (`lib/coverage.js`), not for a number of questions: it first covers what was planned and failed (writing those targets again as they were, no planning call), then plans the never-planned sections from their own text, up to the 30-question limit of one round, and it says before it starts how many sections that is, how many more rounds the rest needs, and the estimate of exactly that request. Because only the chosen sections are sent, it costs about what it covers. Measured with the estimator on the audited 530,000-character, 80-part transcript and a draft with 10 questions in 7 sections and 3 planned-and-failed sections: a round of 30 sections (3 written again, 27 planned from the text) 33–93 calls, 392K–572K tokens; a round of 5 sections 7–20 calls, 42K–74K tokens; the 3 failed sections alone 3–9 calls, 22K–39K tokens. The old **Continue generation** for the 5 missing questions of the same draft planned the whole material again: 20–55 calls, 350K–507K tokens, for 5 questions.

**Coverage strength** (覆盖强度, described in `docs/coverage.md`): creating a deck from sources is priced by the plan of the chosen level, before it runs, from the same prompts the pipeline sends (every round of the plan, the importance calls of the light model, and at the high end of the calls the planner's re-asks for sections it left short). On the audited 572,000-character, 81-section merged transcript: 精简 172 questions, 48 sections, 6 rounds, 1.2M–1.7M tokens, 149–474 calls; 标准 343 questions, 81 sections, 12 rounds, 2.2M–3.1M tokens, 285–896 calls; 完整 500 questions (the sanity bound), 81 sections, 18 rounds, 3.2M–4.4M tokens, 565–1,696 calls; a custom 100 questions in 4 rounds 825K–2M tokens, 82–316 calls. A planning, writing or review call is given only the sections assigned to it (at most 60,000 characters, usually two sections), so a question costs less than it did when every call re-sent a whole group of pages. The importance of the sections costs one light call per 20 sections (about 3K tokens each); without a light model the weights are the lengths and that cost is zero. This job makes the first round (at most 30 questions); the line under the choice prices the whole plan, the job's own estimate prices the round it makes.

### With a lot of material

- One run takes at most 600,000 characters of material (about 200 ordinary PDF pages). More is refused; the form says how many sources you picked, how many fit, and prices the largest selection that fits.
- Planning reads every chunk in full (more material costs more there); after that each batch carries only the pages the plan picked. **Narrowing the page range** is the most effective way to use fewer tokens; fewer questions than pages cannot cover every page anyway.
- One call's input tops out around 16-24K tokens (a 60,000-character chunk plus prompts), so check the largest estimated input against your model’s context capacity.

### Which model and reasoning level

StudyHub uses the model you chose in DSH; it is not tied to one. Low reasoning is enough for batches of recall questions (faster, cheaper); use a high level for application questions and case papers (slower, more tokens, more careful reasoning). Change it next to **Generation model** in **Settings › Library & model**.

### Where actual usage is recorded

- Direct calls read the usage the provider reports; DSH sub-agent phases read DSH's own `tokenUsage` projection of the child session, or replay its events with the same fold. The four buckets are disjoint, reasoning tokens are already inside the output, and a retried attempt is added on top.
- A job's details show Actual usage next to its estimate; Study statistics, Model usage lists the last 7 / 30 days per feature (question writing, repair and review, coach, learning flows, case papers, audio text). Only counts are stored, in `model-usage.json` in the library (90 days, no content).
- A failure to record never affects a job.

[中文](voice-and-tone.zh-CN.md)

# How StudyHub talks

Every sentence in the interface answers two questions for the learner: what just happened, and what to do next. This handbook is for anyone who edits interface text: errors, empty states, hints, setup steps, status words, receipts, banners and toasts. It does not rename features or buttons; it covers sentences only. The Chinese interface is the source text, so the examples below are quoted in Chinese with a gloss.

The overall voice is plain and warm. No cutesy filler, no lecturing. Think of a reliable classmate sitting next to you: say what is true, then give one next step.

## Eight rules

### 1. Say what happened, then give the one next step

A learner should know two things after one read: what the situation is, and where to click next. Give one next step. If the cause is unknown, say that it is unknown.

- Before: 出了点问题，请重试。 (Something went wrong, please retry.)
- After: 这次没有成功，也没有拿到具体原因。可以再试一次。 (That did not work, and no reason came back. You can try again.)
- Before: 已重新检查，目前还没有连上。 (Checked again; not connected yet.)
- After: 已重新检查，还没有读到可用的模型。在 DSH 里配好后，再点一次「重新检查」。 (Checked again, but no usable model was found. Set one up in DSH, then press "Check again" once more.)

### 2. "Later" and "for now" need a reason or an exit

"Try again later" does not say when or what to do. Name how long to wait, name something to click, or give the real cause. If the page does not retry by itself, do not say it will.

- Before: 另一个操作还在进行，请稍后重试。 (Another action is still running, please retry later.)
- After: 上一个操作还没结束，这次点击没有生效。等它结束后再点一次。 (The previous action has not finished, so this click did nothing. Click again once it finishes.)
- Before: 稍后再试。 (Try later; shown when the model service is unavailable.)
- After: 这是模型服务那边的问题。等一两分钟再试一次，或在设置里换一个模型。 (This is a problem on the model service's side. Wait a minute or two and try again, or pick another model in Settings.)

### 3. A status word must be true wherever it can appear

One status word shows on many pages. Before writing it, look up the condition that shows it, and do not let it speak at the wrong moment.

- Before: 正在生成… (Generating…; in the top bar, which also shows while PDF conversion, audio, translation or an index build runs.)
- After: 后台任务进行中 (Background tasks running)
- Before: 今天已经清空 (Today is cleared; but this scope simply had no questions.)
- After: 这里还没有可以学的题 (No questions to study here yet)

### 4. When something is blocked, say why and how to unblock it

A disabled button or a refused action gets its reason and its way out next to it, not just a grey look.

- Before: 还没有可用的 AI 模型，先完成第 1 步。 (No AI model yet, finish step 1 first.)
- After: 还没有可用的 AI 模型。完成第 1 步后，这个按钮就能点了。 (No AI model is available yet. Once step 1 is done, this button will work.)
- Before: 请先归档这份资料，再永久删除。 (Please archive this material first, then delete it permanently.)
- After: 这份资料需要先归档，才能永久删除。 (This material has to be archived before it can be deleted permanently.)

### 5. Use the plain voice, not the command voice

No 请勿, no 必须, no 您; always 你. State the fact and leave the choice to the learner.

- Before: 必须填写，才能生成。 (This must be filled in to generate.)
- After: 填写主题后才能生成。 (Fill in the topic before generating.)
- Before: 请手动复制 (Please copy it manually)
- After: 需要手动复制 (Copy it by hand)

### 6. An empty state says what is empty and how it fills

An empty state is not an apology and not a nudge. Say what this place is and when something will show up.

- Before: 暂无消息 (No messages)
- After: 信箱是空的 (The mailbox is empty)
- Before: 还没出题 (shown after pressing "练 5 道" on a knowledge point with no questions)
- After: 这个知识点还没有题。先到「创建题组」从资料出题。 (This knowledge point has no questions yet. Go to "Create deck" to make some from your material.)

### 7. Do not promise what the page does not do

Before writing "will retry automatically" or "available later", check that the code really does it. A promise that is not kept is worse than no hint.

- Before: 学习插件暂时没有连上，稍等一下会自动重试。 (The study plugin is not connected for now; it will retry by itself shortly.) The page only retries when you press Retry.
- After: StudyHub 暂时没有连上。点「重试」再试一次。 (StudyHub is not connected right now. Press Retry to try again.)
- Before: 读取详情失败，稍后再试 (Could not read the details, try later.)
- After: 没能读取这道题的详情。点页面上的「刷新」后再展开一次。 (Could not read this question's details. Press Refresh on the page, then expand it again.)

### 8. Use the learner's words, not the system's

Interface sentences do not contain developer or operations words such as 宿主 (host), 插件 (plugin), 渲染 (render), 拉取 (pull) or 缓存 (cache). The main chat window has one name only: 主会话.

- Before: 学习工作台渲染出错 (The study workspace had a render error.)
- After: 学习工作台没能显示 (The study workspace could not be shown.)
- Before: 在对话输入框的模型选择器里选 (Choose in the model picker of the conversation input.)
- After: 用主会话输入框里的模型选择器 (Use the model picker in the main chat input.)

## Vocabulary

Each of these words means one thing across the whole interface. Reuse it; do not swap in a synonym.

| Word | Meaning |
| --- | --- |
| 主会话 (main chat) | The main chat window in DSH that you talk to. It has no other name in the interface. 在新对话中打开 really opens a new chat; it is not the main chat. |
| 学习库 (library) | A folder on your computer that holds your materials, question bank and review records. |
| 题组 (deck) | A set of questions. |
| 草稿 (draft) | Only a deck waiting to be published. Text you typed into an input box, and variants prepared for you to practise, are not drafts. |
| 归档 (archive) | Put a material or deck away so it stays out of practice. It can be restored. A permanent delete needs an archive first. |
| 斩 (slay) | Move a question into the 斩题组: it leaves review, its answer history and progress are kept, and it can go back to its deck at any time. |
| 删除 (delete) | Permanent deletion that cannot be undone. Archive first, then delete. |
| 为你定制 (Personalised) | The deck the system builds for you, holding custom questions rewritten from your mistakes and feedback. |

Names that stay as they are: 创建题组, 错题与待巩固, 发给主会话, 复习全书, 斩, 归档, 为你定制.

## Checklist for new copy

- [ ] Does it say what happened? Does it give the one next step?
- [ ] Any 稍后, 暂时, 请, 必须 or 您? If so, replace it with a reason, an exit, or a plain statement.
- [ ] Is it true in every case that can show it? Read the code that triggers it.
- [ ] Does the page really do what the sentence promises (auto-retry, save, keep)?
- [ ] For a blocked action, does it give the reason and the way to unblock?
- [ ] Is the main chat called 主会话? Is 草稿 used only for a deck waiting to be published?
- [ ] Any developer word (宿主, 插件, 渲染, 拉取, 缓存)?
- [ ] Are all `{0}` `{1}` placeholders kept?
- [ ] Is the English line updated: the Chinese text is the key in every `ui/locales/en*.json` that holds it, and tests that pin the old sentence move to the new one.
- [ ] Read aloud, does it sound like a person, neither cutesy nor scolding?

[中文](voice-and-tone.zh-CN.md)

# How StudyHub talks

Every sentence in the interface answers two questions for the learner: what just happened, and what to do next. This handbook is for anyone who edits interface text: errors, empty states, hints, setup steps, status words, receipts, banners and toasts. It does not rename features or buttons; it covers sentences only. The Chinese interface is the source text, so the examples are quoted in Chinese with a gloss.

The overall voice is plain and warm. No cutesy filler, no lecturing. Think of a reliable older classmate: say what is true, give one next step, no jokes, nothing alarming.

The eight rules below are the ones the product owner approved. Examples without a note are real sentences that were changed in the product; an example marked "illustrative" was written to show the rule and is not in the product.

## Eight rules

### 1. Say what happened, then give the one next step

A learner should know two things after one read: what the situation is, and where to click next. Give one next step. If the cause is unknown, say that it is unknown.

- Before: 出了点问题，请重试。 (Something went wrong, please retry.)
- After: 这次没有成功，也没有拿到具体原因。可以再试一次。 (That did not work, and no reason came back. You can try again.)
- Before: 已重新检查，目前还没有连上。 (Checked again; not connected yet.)
- After: 已重新检查，还没有读到可用的模型。在 DSH 里配好后，再点一次「重新检查」。 (Checked again, but no usable model was found. Set one up in DSH, then press "Check again" once more.)

This rule also covers empty states and blocked actions. An empty state says what this place is and when something will show up (暂无消息 → 信箱是空的, "No messages" → "The inbox is empty"). A control that cannot be used gets its reason and its way out next to it (请先归档这份资料，再永久删除 → 这份资料需要先归档，才能永久删除, "Please archive this first, then delete" → "This has to be archived before it can be deleted permanently").

### 2. No bare "later" or "for now"

"Try again later" without a reason or an exit does not belong. Name how long to wait, name something to click, or give the real cause.

- Before: 另一个操作还在进行，请稍后重试。 (Another action is still running, please retry later.)
- After: 上一个操作还没结束，这次点击没有生效。等它结束后再点一次。 (The previous action has not finished, so this click did nothing. Click again once it finishes.)
- Before: 稍后再试。 (Try later; shown when the background service did not answer.)
- After: 后台服务这次没有回应。等一两分钟再试一次。 (The background service did not respond this time. Wait a minute or two and try again.)

Do not promise what the page does not do. Before writing "will retry automatically", check that the code really retries.

- Before: 学习插件暂时没有连上，稍等一下会自动重试。 (The study plugin is not connected for now; it will retry by itself shortly.)
- After: StudyHub 暂时没有连上。点「重试」再试一次。 (StudyHub is not connected right now. Press Retry to try again.)

### 3. Say what was done and on what basis, so the learner can check

Numbers, states and results name their basis. One status word shows on many pages: before writing it, look up the condition that shows it, and do not let it speak at the wrong moment.

- Illustrative: 已备好 3 道变式 → 照你刚错的那道出了 3 道变式 ("3 variants ready" → "3 variants made from the question you just missed")
- Before: 正在生成… (Generating…; in the top bar, which also shows while PDF conversion, transcription, translation or an index build runs.)
- After: 后台处理中 (In background; hovering lists which kinds of task)
- Before: 今天已经清空 (Today is cleared; but this scope simply had no questions.)
- After: 这里还没有可以学的题 (No questions to study here yet)

### 4. Buttons use a concrete verb; an action with a cost states the cost

A button says what it does. An action that loses something or cannot be undone says so before it is pressed.

- Before: 请手动复制 / 剪贴板不让用 (Please copy manually / The clipboard refused.)
- After: 需要手动复制 / 浏览器没让复制，点「打开全文」 (Copy it by hand / The browser blocked copying; press "Open the full text".)
- Before: 请先归档这份资料，再永久删除。 (Please archive this material first, then delete it permanently.)
- After: 这份资料需要先归档，才能永久删除。 (This has to be archived before it can be deleted permanently.) The delete dialog itself already says 无法撤销 (cannot be undone).

### 5. "你", never "您"; no commands, no blame

No 请勿, no 必须. State the fact and leave the choice to the learner.

- Before: 必须填写，才能生成。 (This must be filled in to generate.)
- After: 填写主题后才能生成。 (Fill in the topic before generating.)
- Illustrative: 请勿重复导入 → 这份已经导入过了 ("Do not import twice" → "This one was already imported")

### 6. No cutesy filler, no padding

No 哎呀, no 啦; an exclamation mark only for real good news; no padded words such as 暂无. The interface does not use developer or operations words (宿主 host, 插件 plugin, 渲染 render, 拉取 pull, 缓存 cache), and the main chat window has one name only: 主会话. The exception is the name of one of DSH's own screens, quoted as a name, such as 「DSH 插件管理器」, because the learner has to find it there.

- Before: 暂无卡片 (No cards)
- After: 这一列没有卡片 (No cards in this column)
- Before: 学习工作台渲染出错 (The study workspace had a render error.)
- After: 学习工作台没能显示 (The study workspace could not be shown.)
- Before: 在对话输入框的模型选择器里选 (Choose in the model picker of the conversation input.)
- After: 用主会话输入框里的模型选择器 (Use the model picker in the main chat input.)

### 7. The tone follows the learner's state

After a long break there is no guilt and no pressure: only the fact and the next step. The product already does this: an overdue item says 已逾期 N 天 (N days overdue) and nothing else.

- Illustrative: 又断了一天，快补上！ → 今天有 12 题到期 ("Another day missed, catch up!" → "12 questions are due today")
- Illustrative: 你已经 5 天没学了 → 上次学习是 5 天前，今天有 12 题到期 ("You have not studied for 5 days" → "Last session was 5 days ago; 12 questions are due today")

### 8. Say the behaviour, not a verdict on the learner

Say what happened and what the result was, not what kind of person the learner is.

- Illustrative: 你好像很吃力 → 这章最近 10 题错了 6 道 ("You seem to be struggling" → "You missed 6 of the last 10 questions in this chapter")
- Illustrative: 你太粗心了 → 这 3 道都是最后一步算错了 ("You are careless" → "All 3 went wrong in the last step")

## Vocabulary

Each of these words means one thing across the whole interface. Reuse it; do not swap in a synonym.

| Word | Meaning |
| --- | --- |
| 主会话 (main chat) | The main chat window in DSH that you talk to. It has no other name in interface sentences. 在新对话中打开 really opens a new chat; it is not the main chat. |
| 学习库 (library) | A folder on your computer that holds your materials, question bank and review records. |
| 题组 (deck) | A set of questions. |
| 草稿 (draft) | Only a deck waiting to be published. Text you typed into an input box, and variants prepared for you to practise, are not drafts. |
| 归档 (archive) | Put a material or deck away so it stays out of practice. It can be restored. A permanent delete needs an archive first. |
| 斩 (Retire) | Move a question into the 斩题组 (the retired deck): it leaves review, its answer history and progress are kept, and it can go back to its deck at any time. |
| 删除 (delete) | Permanent deletion that cannot be undone. Archive first, then delete. |
| 为你定制 (Personalised) | The deck the system builds for you, holding custom questions rewritten from your mistakes and feedback. |

Names that stay as they are: 创建题组, 错题与待巩固, 发给主会话, 复习全书, 斩, 归档, 为你定制.

## Checklist for new copy

- [ ] Does it say what happened? Does it give the one next step? (Rule 1)
- [ ] Any 稍后 or 暂时? If so, replace it with a reason, an exit, or a plain statement. Does the page really do what the sentence promises (auto-retry, save, keep)? (Rule 2)
- [ ] Do numbers and states name their basis? Is the status word true in every case that can show it? Read the code that triggers it. (Rule 3)
- [ ] Is each button a concrete verb? Does an action with a cost state the cost? Does a blocked action give the reason and the way out? (Rule 4)
- [ ] Any 您, 请勿 or 必须? (Rule 5)
- [ ] Any 哎呀, 啦 or 暂无, any developer word (宿主, 插件, 渲染, 拉取, 缓存)? Is the main chat called 主会话? Is 草稿 used only for a deck waiting to be published? (Rule 6)
- [ ] Could it make someone who has been away feel guilty? (Rule 7)
- [ ] Does it describe behaviour rather than judge the learner? (Rule 8)
- [ ] Are all `{0}` `{1}` placeholders kept?
- [ ] Is the English line updated: the Chinese text is the key in every `ui/locales/en*.json` that holds it, and tests that pin the old sentence move to the new one.
- [ ] Does it fit a narrow pane? Status words and button text stay short; the long sentence goes into the hover text.

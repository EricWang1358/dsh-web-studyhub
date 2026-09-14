# JSON 题组导入

在「创建题组 → JSON 导入」选择题型，复制提示词并追加资料，让外部 AI 输出 JSON。也可展开格式示例自行编写。将结果粘贴到内容框，或选择 UTF-8 `.json` / `.txt` 文件，再点击「校验并导入草稿」。TXT 内必须是 JSON，普通题目文本使用「导入已有题目」的对话录题。

支持 `quiz` 单选、`multi` 多选、`flashcard` 闪卡、`open` 开放问答和 `cloze` 填空，同一题组可以混合题型。顶层为 `{ "title": "题组名称", "folder": "可选目录", "cards": [...] }`。每组 1–100 题，最多 500,000 字符，文件最多 2 MB。允许 UTF-8 BOM 和包裹整个 JSON 的 Markdown 代码围栏。

各题型完整示例由 `ui/json-prompts.js` 提供，界面可查看。每题需要 `kind`、`topic`、`objective`、`prompt`、`answer`、`hint`、`explanation`、`misconception`。单选与多选需要 3–6 个选项，每项含 `id`、`text`、`correct`、`explanation`；开放问答需要 `rubric`；填空需要 `cloze.text` 和 `cloze.answers`。

服务接口 `draft.import { text }` 在同一事务内保存导入内容资料和新草稿。任何一道题校验失败都不保存。外部 ID、复习进度、暂停状态和编辑关联不被继承。引用用于追溯导入内容，不代表独立事实核验；本流程不调用模型，使用者需在发布前审阅答案和解析。

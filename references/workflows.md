# Learning flows (retired)

**Learning flows (学习流) and their custom templates are retired.** Do not create, edit, start, advance or delete one, and do not look for the old steps, Portal or the five-template limit: that behaviour is gone.

- **Writing calls are refused.** Every call that would change a flow (`workflow.save`, `workflow.delete`, `workflow.session.start`, `workflow.session.record`, `workflow.session.material`, `workflow.session.material.restore`, `workflow.session.advance`, `workflow.session.goto`, `workflow.session.status`, `workflow.session.delete`, `workflow.practice.start`) fails with the code `WORKFLOW_RETIRED`.
- **Old records stay readable.** `workflow.list`, `workflow.context` and `workflow.session.get` still read the sessions a library already holds. They are history, not a way to teach.
- **What replaced it.**
  - Each course owns a **Learning method** (学法): its stages, gates and optional stage activities. Read and change it with `course.method.get` and `course.method.save`.
  - Guided teaching in the main chat is **AI-guided study** (AI 带学): `study.session.start`, `study.session.update`, `study.session.artifact.save`, `study.session.pause`, `study.session.end`, and `study.session.get`, `study.session.list`, `study.session.resume` to read and resume.
  - Custom flow templates were not converted into course methods.

See [docs/study-workflows.md](../docs/study-workflows.md#archived-learning-flows-retired-read-only) for what the learner sees and the full list of refused calls.

---

**学习流（含自定义模板）已退役。** 不要再创建、编辑、开始、推进或删除学习流；写入类调用一律返回 `WORKFLOW_RETIRED`，已有的历史记录只读保留。替代方式：每门课自己的「学法」（`course.method.get` / `course.method.save`）和主会话里的「AI 带学」（`study.session.*`）。详见 [docs/study-workflows.zh-CN.md](../docs/study-workflows.zh-CN.md)。

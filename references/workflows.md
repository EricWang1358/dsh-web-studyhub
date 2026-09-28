# 可选学习流与 Portal

**默认入口是 AI 带学：** 在「学习流」首页写一句想学什么，点「开始学」。`workflow.quickstart {goal,requestId}` 选材料与骨架并建立本次学习；讲解与练习到达即开始；复述后 `workflow.feedback {id,version,stepId}` 给出讲到了/还缺/引导问题与建议，只写入该步的 `records[stepId].feedback`，不推进、不判分。范围没有现成骨架时，`quickstart` 传 `skeleton:true` 或之后调用 `workflow.skeleton.generate {id}` 会在后台按本次范围起草骨架，状态记在 `session.skeletonJob`（running / done / failed），`resources.skeletonActive` 表示本进程是否仍在生成；完成后保存为普通骨架并写入 `session.skeletonId`，不改变已开始的步骤路线。带学会话记录选材方式 `session.pickedBy`（ai / match / course / none）；`resources.scopeTopics` / `scopeTopicCount` 用文字列出本次范围（主题名，整组时为题组名）；`workflow.list` 的会话带 `stepIndex` / `stepCount`，供首页「上次学到一半」使用。以下自定义模板说明适用于「高级」入口。

独立闪卡、主题、知识骨架继续可用，不要求用户采用流程。学习流只是组件的一种组合方式。

工作台最多五条保存的流程；默认模板为目标→骨架→概念与例子→复述→练习→总结。可删除任意不需要的环节，也可从空白或主会话建议开始。流程模板和运行中的副本分开保存，修改模板不会覆盖当前学习记录。

在侧栏打开「学习流」，编辑默认建议或点「自己拼一条」。添加组件后可拖动或用上下按钮排序，展开步骤设置材料、题数和完成/巩固后的去向。保存后点「使用」，选择学习主题及可选题目范围、知识骨架，进入 Portal。只保留一个练习组件也有效；学习库仍然是默认首页。

Portal 中的回答先暂存在当前设备，点保存、暂停或返回工作台会写入学习库。刷新页面后，从学习记录继续即可恢复。主对话和工作台同时修改时会提示版本冲突，保留本地输入供核对。完成、需巩固和跳过分别记入学习足迹；回到练习步骤会开始新一轮，旧轮次的作答历史仍保留。

「概念与例子」以连贯文章为主，支持公式、表格和逐步推演。无材料时点「生成完整讲解」；阅读后可直接点「换个例子」「拆开讲」「补前置」「改进讲解」。生成在后台执行，结合所选材料与知识骨架，核对引文后再进行独立质量检查；未通过时尝试一次修复，仍不通过则保留原文并显示失败。改写可以撤销，补讲解追加保存，笔记、原文引用和足迹默认收起。只有明确点击才调用模型；未连接模型会如实提示。

目标和总结可点选自己的重点或感受；复述可以写下来，也可以在实际口头复述后点击记录。口头记录只是学习者自报，不是机器判分。复述步骤中的参考材料需主动展开，默认不提前展示。

## 主 session

用户要求编排时先调用 `workflow.context`，读取已有模板、组件类型与接口。先用当前模板 version，再调用 `workflow.save` 保存完整结构；不能凭空猜测模板或步骤 ID。遇到版本冲突应重读，与用户的最新编辑合并。五条限制同样适用于 AI，不得删除其他流程腾名额，除非用户要求。

宿主中的按钮把请求填入主对话输入框，用户发送后再由模型执行；独立浏览器预览会复制请求文本。创建新模板可带稳定的 `requestId`，避免网络重试重复占用名额。

用户交接某次学习时调用 `workflow.context {sessionId}`，先看当前步骤已有的材料。只针对当前步骤提供指导；用 `workflow.session.material {id,version,stepId,mode?,content?|edits?}` 保存材料供 Portal 阅读：`mode` 默认 `append`（追加在已有材料之后，不要重复已有内容）；修改已有段落用 `mode:"edit"` 与 `edits:[{find,replace}]`（`find` 必须在原文中唯一）；只有学习者要求重写时才用 `mode:"replace"`。每次变更前的版本都保存在 `records[stepId].materialHistory`（最多 10 版，含 `by: chat|ai` 与时间），学习者可在 Portal 用 `workflow.session.material.restore {id,version,stepId,index}` 恢复。称呼步骤用标题，不要用内部 ID。引用现有证据，补充例子/知识要标明；证据不足时明确指出。不得通过 record/advance 代替学习者回答、自评或宣布掌握。

数据与步骤完成不自动证明能力掌握。流程推进是活动记录，题目作答仍由原复习引擎判分和调度。练习轮次属于该 Portal，暂停或离开后能继续；不会占用普通闪卡的“继续练习”入口。

## 后台讲解接口

后台教学接口：workflow.teaching.start {id,version,stepId,mode,request?}，mode 为 lesson / example / steps / prerequisite / improve / remedy，request 为可选的具体疑问（最多 1000 字）；remedy 用于复述后「回到讲解补一补」，request 是复述里缺的点，结果作为补充讲解保存（`help[].kind = "remedy"`，并保留 `request`），不改写原讲解。仅用于当前 lesson 步骤。返回 {session,resources}；workflow.session.get 返回同样结构，records[stepId].teaching 记录 running / done / failed。resources.modelReady 表示模型是否可用，teachingActive 表示当前步骤的任务在本进程是否仍运行。持久化的 running 配合 false 表示上次已中断，可显式重试。workflow.teaching.undo {id,version,stepId} 恢复上次改写前的正文。后台任务只写回原步骤，用户离开后不改变当前步骤或学习者输出；若正文已被其他地方改动，会保留新正文。

## 存储

学习库格式升级到 v3，流程模板和 Portal 学习记录各自存储为分片。第一次写入 v2 学习库前保存完整旧版备份。新版本库应由支持 v3 的插件打开，避免旧程序忽略新字段。完整学习库导出/恢复包含这两类记录。

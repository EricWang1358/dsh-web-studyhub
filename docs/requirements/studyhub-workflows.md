# StudyHub 可选学习流（2026-09-27）

本文件记录本任务最新用户约定。较早的 evidence-based learning 方案是另一份范围更大的提案，不作为本次实现清单；不把系统学习设为强制模式。

## 产品边界

- 保留学习库、闪卡复习、主题及知识骨架的独立入口和行为。
- 新增学习流工作台，用户手动或通过主 session 使用同一接口编排，最多保存五条。
- 提供一条可复制/编辑的默认模板，不自动占用用户名额，不修改默认首页。
- 步骤组件可添加、移除、排序、设置标题、要求、材料和后续分支。首批：目标、骨架、讲解、复述、练习、总结。
- 用户选择流程、主题及可选题目范围/骨架，进入 Portal。没有题目也可开始阅读、复述和笔记。
- Portal 显示当前位置、组件内容、回答和历史；支持保存、暂停、继续。模板版本与运行副本分离。
- 默认手动推进；可配置完成/需巩固时的分支。跳过会如实记录，不当作完成证据。
- 步骤完成仅表示本次活动完成；闪卡调度、题目判分与能力认定不由流程自评替代。
- 主 session 可读取组件规范、修改流程、补充当前步骤讲解；不代替用户回答或评定自己掌握。

## 实现接口

组件目录：lib/workflow-contract.js。领域：lib/workflows.js。通过 StudyService 与主 session 共用。

| action | 输入 / 输出 |
| --- | --- |
| workflow.list | 返回 limit, components, suggested, templates, sessions, topics, groups, skeletons |
| workflow.context | {sessionId?}；返回编排规范及可用流程/材料 |
| workflow.save | 完整模板 {id?,version?,title,description,steps} → 模板；更新需要当前 version |
| workflow.delete | {id,version}；保留已开始的学习副本 |
| workflow.session.start | {templateId,topic,scope?:[{deckId,topic?,cardId?}],skeletonId?,requestId} → session |
| workflow.session.get | {id} → {session,resources:{skeleton,cardCount,readings,sources}} |
| workflow.session.record | {id,version,output} → session；只保存当前步骤笔记 |
| workflow.session.material | {id,version,stepId,content} → session；主 session 补讲解 |
| workflow.session.advance | {id,version,requestId,outcome:done\|needs_work\|skipped,output?} → session |
| workflow.session.status | {id,version,status:active\|paused} → session |
| workflow.session.delete | {id,version}；删除学习副本，保留练习历史 |
| workflow.practice.start | {id,version} → {session,run}；独立练习轮次，复用 review.get/reveal/answer/move |

session 包含 id, version, template(快照), topic, scope, skeletonId, currentStepId, status, records(按步骤 ID), history。
steps 包含 id,kind,title,instructions,content,next,retry,count。分支取 $next/$stay/$finish 或有效步骤 ID。

## 验收

1. UI 与主 session 保存使用相同校验，六条并发创建最多成功五条；陈旧版本不能覆盖新版本。
2. 编辑/删除模板不会破坏旧 Portal；刷新后回答、步骤和练习均可恢复。
3. 练习启动不能结束普通闪卡会话，也不抢占旧页面的继续学习入口。
4. 跳过、需巩固、完成各自记录；复述/总结须有产出；练习启动本身不能完成步骤。
5. 升级前备份旧库；新字段导出/恢复往返不丢，旧题和调度保持不变。
6. 浏览器验证完整手动编排、AI 交接、学习与暂停恢复；检查 360px 与桌面布局。
7. 实际主 session 模型生成质量与模型可用性须单独说明，不用测试桩证明教学效果。

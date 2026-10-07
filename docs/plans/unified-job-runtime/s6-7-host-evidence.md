# S6-7：真实宿主证据（DSH 0.2.0-rc.2，23 个迁移开关全开）

核验日期：2026-10-07。分支 `codex/runtime-s67-host-evidence`，基于 main `82478c27`。本文是 S6-7 验收文档（C 的 #359）第 9 节要引用的宿主证据；它只记录**实际运行过的**东西和**没有运行的**东西，不替任何一条补充推断。

## 1. 隔离规则（一次都没有破）

| 规则 | 做法 |
|---|---|
| 不碰 `~/.dsh`、`~/.mineru`、所有者的学习库 | `DSH_HOME`、`TEMP`、`TMP`、工作区、学习库全在 `output/qa/s67/` 下；运行前后各列一次 `~/.dsh` 与 `~/.mineru` 的目录项，**没有变化**（`touched.dotDshUnchanged`、`mineruUnchanged` 均为 true） |
| 没有密钥 | 外层包装脚本与 harness 各删一遍名字含 `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`BASE_URL` 等的环境变量（本机 shell 里原有 7 个；harness 自己看到时只剩 1 个）；宿主里只有本地的假模型（`scripts/qa/fake-openai.mjs`，环回端口），假 key 是 `STUDYHUB_QA_FAKE_KEY`，不是任何真实服务的 |
| `SSH_TTY=audit` | 设置（宿主用页面内的文件夹选择器，不会弹原生对话框） |
| 没有网络安装 | 插件用 `npm pack` 的本地 tgz，`dsh plugin add` 在 `npm_config_offline=true` 下运行，依赖来自本机 pnpm 仓库（手动试过两次，第二次输出 "downloaded 0"） |
| 没有真实模型、没有发布 | 所有"问模型"的路径只对本地假模型跑；真实模型路径写"没有运行" |

## 2. 版本与组成

| 项 | 值 |
|---|---|
| DSH | **0.2.0-rc.2**（本机全局安装，`@deepseek-ai/dsh/lib/bin.js --version`；harness 钉死此版本，不符就退出） |
| 插件 | `@ericwang1358/dsh-daily-flashcard` **2.7.1**（本分支 `npm run build` + `npm pack --ignore-scripts` 的 tgz，695 个文件） |
| 配置 | 插件配置 `runtime.pilot` 的 **23 个开关全部为 true**（`lib/runtime-config.js` 的 `MIGRATION_SWITCHES` 全集；清单见 `evidence/s6-7-host-summary.json` 的 `switchesOn`），经 `--patch` 覆盖写进 `daily-flashcard` 的 `config` |
| 组成（`cordis.patch.yml`） | `daily-flashcard`（`modular: true`）与六个子插件：`plugins/runtime`、`plugins/materials`、`plugins/bank`、`plugins/study`（`independent: true`）、`plugins/generation`、`plugins/audio`（及其后的其余套件项，原样见 `cordis.patch.yml`）；运行时提供者在 `plugins/runtime`，每个任务家族的定义由它按开关登记 |
| 宿主的作业执行器 | 运行中的运行时任务卡上读到：`executor = { service: "dsh-jobs", handleId: "audio-subtitles-N", ownerAgentId: "session-…" }`——就是 DSH 自己的 `jobs` 服务与会话里的子代理；卡片上的槽位文字是「DSH 子代理 · 槽 1」 |
| 浏览器 | Playwright 的 Chromium（本机已装的版本，`scripts/qa/browser.mjs` 选择），`zh-CN` |
| 系统 | Windows 11 Home China 10.0.26200，Node v22.22.3，pnpm 11.19.0 |
| 模型 | 本地假模型 `fake-tutor`（环回端口 4194），**不是真实模型**；答案由 `scripts/fake-model.mjs` 的各条提示族处理器生成 |

## 3. 命令

```
# 一次性：宿主里的冒烟（建档、装插件、开机、驱动、停机、检查）
npm run qa:dsh-runtime -- --dsh-bin "<全局 dsh>/lib/bin.js"        # 输出：output/qa/s67-smoke/summary.json 与截图
# 任务控制台的浏览器测试及与它配对的边界测试，开关关与开
node --import ./scripts/qa/test-network.mjs --test tests/task-console-browser.test.mjs tests/task-console-ui.test.mjs tests/task-console-nav.test.mjs tests/task-console-panels.test.mjs tests/unified-runtime-boundaries.test.mjs tests/architecture-boundaries.test.mjs tests/backend-boundaries.test.mjs tests/client-boundaries.test.mjs
STUDY_RUNTIME_MATRIX=all node --import ./scripts/qa/test-network.mjs --import ./tests/helpers/runtime-matrix-preload.mjs --test <同上八个文件>
```

`STUDY_RUNTIME_MATRIX=all` 是本 PR 给 `tests/helpers/runtime-matrix-preload.mjs` 加的一个家族：23 个开关一起打开（原来只有 `generation`、`audio` 等单个家族）。

## 4. 宿主里的结果（`npm run qa:dsh-runtime`，18 步全部通过）

| 步骤 | 结果 |
|---|---|
| 打包、建档、`dsh plugin add`（离线）、开机 | 通过；DSH 打印地址即视为就绪（约 7 秒） |
| 文字模型设为宿主自己的（`audio.settings.set`） | `textProvider: host` |
| 新库里列任务 | 0 个 |
| 字幕导入，假模型被挂住：**运行时任务在真实宿主上运行** | `contractVersion: 2`，`kind: audio-subtitles`，状态 running，执行器 `dsh-jobs`；动作：取消可用，暂停 `capability-unsupported`，重试 `not-ended`（还在进行），设置 `capability-unsupported` |
| `job.status`、`job.wait`，用卡片 id 与契约 id | 两个名字都认 |
| 运行中被拒绝的操作用大白话 | 暂停："这类任务不支持这个操作。"；重试："任务还在进行，结束后才能重试。"；`job.message`："音频任务不接收补充说明：要调整并发或推理强度，请在任务控制台的即时控制里改；要让它停下，请点停止。" |
| 停止运行中的任务 | 回复 `cancel/cancelling`，随后 `cancelled`，卡片动作：取消 `job-ended`，重试可用 |
| 对已结束的任务再停止 | 拒绝："这个任务已经结束，不能再这样操作。"（与卡片一致） |
| 清除（dismiss）已停止的任务 | `dismissed`，列表回到 0 个 |
| 字幕导入，假模型放行：**完成** | `complete`，调用 `proofread:ok`、`translate:ok`、`title:ok`，用量 4778 token（假模型回报的），资料 1 份 |
| 归档 → 取回 → 列表 | 归档后不在列表、在归档里（1 条）；取回成功 |
| 检索索引（宿主没有检索扩展） | `retrieval.status`：`hostCanSearch: false`、扩展 `installed: false`；`retrieval.index.start` 被拒绝："检索扩展还没有运行。请先在「设置 › 检索扩展」安装检索扩展；刚安装完请稍等几秒再试。"——**索引构建本身没有运行** |
| PDF 本地路线是否已装 | Marker：`not-installed`。MinerU：本机有 `mineru` 4.0.10（所有者自己的安装），状态 `server-stopped`；**没有做任何本地转换**（见 §7） |
| 没有转写服务时导入录音 | 拒绝："还没有配置转写服务：请在「设置 › 音频转写」里填一个密钥（推荐硅基流动：免费、国内直连）。不要把密钥贴到对话里"，没有发出任何请求 |
| **任务控制台里的真实点击** | 在 1280 宽的真实宿主页面里：选中运行中的运行时任务，点「停止」，任务变为已取消；再勾选它，点「删除」，点「确认删除」，记录消失（`cardGoneAfterDelete: true`） |
| 1280 与 420 宽的控制台截图 | 见 §6；两个宽度都没有横向溢出（`overflowX: 0`）；页面与控制台没有 console error、没有 page error |
| 停机 | 关浏览器、结束宿主进程树、关假模型；之后没有残留进程、端口 3190/4194 不再监听；`~/.dsh`、`~/.mineru` 目录项不变 |

## 5. 任务控制台的浏览器测试（开关关 / 开）

| 运行 | 文件 | 结果 |
|---|---|---|
| 开关**关** | `task-console-browser`、`-ui`、`-nav`、`-panels`，`unified-runtime-boundaries`，`architecture-boundaries`，`backend-boundaries`，`client-boundaries` | **54 项，54 通过，0 失败，0 跳过**（约 186 秒；浏览器测试没有被跳过） |
| 23 个开关**全开**（`STUDY_RUNTIME_MATRIX=all`） | 同上八个文件 | **54 项，54 通过，0 失败，0 跳过**（约 307 秒） |

怎么知道"开"真的开了：用同一个预览服务（`scripts/qa/task-console.mjs` 的 `startConsole` + `startJobs`）在两种设置下各列一次任务——关：音频批次是 v1 记录（`type: audio-import`，`contractVersion: 1`）、出题是 v1；开：音频批次是 `audio-batch`、出题是 `generation`，都是 `contractVersion: 2`（为你定制的日记录 `coach-daily` 是固定的 v1 记录，不分开关）。这是**预览服务里的假执行器**，不是 DSH 宿主；宿主一侧的证据是 §4。

## 6. 截图（`evidence/`）

| 文件 | 内容 |
|---|---|
| `s6-7-host-tasks-1280.png` | 真实宿主，1280 宽：一个运行中的运行时任务（「DSH 子代理 · 槽 1」、实时输出面板、停止按钮）与一个已完成的 |
| `s6-7-host-tasks-420.png` | 同一页，420 宽：列与详情叠起来，页面纵向滚动，没有横向溢出 |
| `s6-7-host-before-stop-1280.png`、`s6-7-host-after-stop-1280.png` | 点「停止」前后的同一个任务 |

## 7. 没有运行的（原因）

| 项 | 状态 | 原因 |
|---|---|---|
| 真实模型的所有路径：转写、字幕/复核/课堂保存/课堂校正对真实文字模型、出题等 | **没有运行（没有授权的模型）** | 宿主里只有本地假模型；假模型证明的是宿主集成（执行器、会话、控制、控制台），不证明任何真实模型的行为 |
| 复核任务 | 没有运行 | 需要带"存疑修正"的逐字稿；只有真实转写才会产生 |
| 检索索引构建 | 没有运行 | 宿主没有检索扩展，安装要联网；宿主的拒绝话已记录（§4） |
| PDF 本地转换（MinerU） | **没有运行** | 本机已有所有者自己的 `mineru` 4.0.10，但转换要起它的服务、读写它的模型目录（`~/.mineru` 一类）；按"不碰所有者的环境"的规则不做。`mineru.local.status` 会执行一次已装的 `mineru` 取版本（只读，没有转换），`~/.mineru` 目录项前后相同 |
| Marker 安装、MinerU 配置、云端 PDF 转换 | 没有运行 | 要联网安装或调用云服务，不在授权内 |
| 真实 DSH 里"重启后恢复一个中断的任务" | 没有运行 | 本文只有一次宿主进程；恢复由 S2-7、S2-7b 与恢复测试覆盖，不是宿主证据 |

## 8. 发现

| # | 发现 | 严重度 | 去向 |
|---|---|---|---|
| F-1 | 控制台里**所有音频家族的卡片**都写「音频批量转写」：宿主截图里的**字幕导入**任务也是这样（列表行与详情头都是）。同样会发生在复核、课堂保存、课堂校正、单文件转写上。原因：`ui/tasks/task-summary.js` 的 `KIND_LABEL` 只有家族一级（`audio`），不看契约里的 `kind` | 低（文案不准，不影响功能） | 单独 PR（先红的测试 + 每种任务一个名字，带英文），见协调者的 S6-7b |
| F-2 | `scripts/qa/fake-openai.mjs` 在宿主里回不了插件的提示：DSH 对**子代理的调用**把插件的指令放在用户那一轮里，并在末尾追加一份"运行时上下文"快照；假服务原来取最后一轮、又在 system 里找指令，所以字幕的翻译步骤收到的是"收到：You translate…"。已改假服务：取最后一个不是运行时上下文的用户轮，并把它同时当作 system 与 prompt 给处理器（并去掉 `<system-reminder>`），另加一个 `beforeReply` 钩子让一次运行能"挂住"模型 | 测试工具（非产品） | 本 PR |
| F-3 | `mineru.local.status` 会执行本机已装的 `mineru` 取版本（只读）。这对"插件不碰所有者的 MinerU"来说是预期的检测，但在隔离的冒烟里它确实运行了所有者安装的程序一次 | 说明 | 记录在 §7，不改 |

没有失败的步骤：F-1 是在通过的运行里看到的文案问题，F-2 是工具问题。

## 9. 复现

`npm run qa:dsh-runtime -- --dsh-bin <DSH 0.2.0-rc.2 的 lib/bin.js>`（需要本机已有该版本的 DSH、pnpm 仓库里有插件的依赖、Playwright 的 Chromium；会重建 `output/qa/s67/` 与 `output/qa/s67-smoke/`）。证据原件：`evidence/s6-7-host-summary.json`（已把本机路径换成 `<repo>`、`<home>`，去掉含令牌的地址）。

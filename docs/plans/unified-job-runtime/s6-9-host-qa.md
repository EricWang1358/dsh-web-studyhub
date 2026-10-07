# S6-9：3.0.0 发布前隔离宿主 QA

## 接手范围

- 负责人：Codex `host_300_smoke`；分支：`codex/studyhub-3.0.0-host-qa`。
- 基线：`4d04f751112d30387f295d1e590771931fe557d1`；日期：2026-10-07。
- 实际打包版本仍为 `@ericwang1358/dsh-daily-flashcard@2.7.1`。这是 3.0.0 发布准备基线的验证，不是最终 3.0.0 包验收。
- 宿主：已安装的 DSH `0.2.0-rc.2`，通过 `--dsh-bin` 指定；没有重装全局宿主。
- DSH 能力对照表：[DSH-01/03/04/07/08](s1-0-dsh-capabilities.md#固定行-id-能力对照)，沿用 rc.2 宿主插件、`ctx.llm`、工作区与公共 RPC 边界；本工作沿用既有 QA 与公共接口，另修复插件侧栏高度约束，没有实现宿主替代层。
- 用户本轮授权正常隔离宿主与依赖安装验收；本工作单元不调用真实 provider。全部模型为本机假 OpenAI 服务。

## 隔离与边界

`output/verification/300-host-run.mjs` 使用既有 `scrubSecrets` 清理继承凭据环境，设置私有 `TEMP`、`TMP`、`DSH_HOME`、`SSH_TTY=audit`、`DSH_TELEMETRY_DISABLED=1`，以及 `npm_config_offline=true`。真实宿主脚本又清理一次环境。所有安装、生成包、库、profile 和截图位于此工作树的 `output/qa/`。运行前逐一核验脚本会重建的绝对目录在该范围内。

没有读取密钥、修改所有者学习库、运行真实 Marker/MinerU 安装或网络 PDF 转换。runtime 脚本只比较 `~/.dsh` 与 `~/.mineru` 的目录项名称；前后相同不等于对其中每个文件做过内容审计。

## 已完成的原始结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `qa:dsh --lang zh` | 8/8 通过，页面错误 0，控制台错误 0；假模型请求 0 | `output/qa/3.0.0-dsh-zh/summary.json`；8 张截图；`output/verification/300-host-zh.log` |
| `qa:dsh --lang en` 首跑 | 7/8 通过，选择器陈旧导致 1 项失败；页面错误 0、控制台错误 0 | `output/qa/3.0.0-dsh-en-first-run/summary.json`；`output/verification/300-host-en.log` |
| `qa:dsh-runtime` | 19/19 通过，页面错误 0、控制台错误 0，宿主停止确认 | `output/qa/3.0.0-runtime/summary.json`；`output/verification/300-host-runtime.log` |

英文失败的原因是 QA 脚本硬编码 `Generation preferences`，现有正式英文翻译为 `Question defaults`。根代理将选择器改为 `.settings-nav [data-category="generation"]`，沿用产品现有稳定标识；不改用户文案或产品行为。原始失败保留，随后修复 onboarding 重复点击保存中按钮的竞态；最终英文 8/8 通过，页面与控制台错误均为 0。

runtime 检查通过真实 DSH 的 `study-workspace/call`：任务列出、status/wait、暂停/重试/消息拒绝、取消、完成、归档/取消归档、删除、宿主缺少扩展时的回复，以及 1280/420 控制台操作。测试 overlay 将全部 23 个迁移开关打开；产品默认值未改变。字幕调用通过宿主模型入口连接本机 fake。不能据此证明真实模型质量、计费或服务商行为。

## 命令与可重放入口

以下命令在本工作树执行；环境由私有包装器或既有脚本清理。

```powershell
node output/verification/300-host-run.mjs
node scripts/qa/dsh-runtime-smoke.mjs --dsh-bin 'D:\Program Files\nodejs\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js' --port 3297 --model-port 4297 --out output/qa/3.0.0-runtime
```

第一条依次运行中文、英文；英文首跑失败后包装器停止，第二条单独续跑 runtime。没有并行重建同一 QA home/pack/dist。

## 尚未证明的发布门禁

- 最终 3.0.0 commit、发行包及远端资产哈希；最终包需要重新验收。
- 真实订阅模型路径、质量、耗时、请求数与用量，以及服务商限额行为。
- 真实转写、多文件音频中途重启、Marker/MinerU 安装、云转换、搜索扩展构建和真实书籍显示。
- Experience channel 一天真实使用、用户真实学习库流程与桌面稳定渠道更新。
- 此处既有脚本不测浏览器或 DSH 外壳 150% 缩放。额外产品界面缩放与 CLS 探针结果另附，不能把 CSS 或产品设置缩放写成浏览器缩放。

## 私有探针准备与失败保留

额外矩阵首轮未先完成 DSH onboarding；点击 StudyHub 导航未切页，属于探针初始化遗漏。第二轮照既有脚本每 800 ms 再找“继续”，遇到宿主尚在保存确认状态时误等同名 disabled 按钮，随后该节点卸载造成超时；0 个矩阵格完成，不能报矩阵通过。两次记录分别保留在 `output/qa/3.0.0-host-ui/probe-onboarding-failure.json` 与 `probe-saving-failure.json`。

只读核实宿主 `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`：`WelcomeNotice` 的 disabled 条件仅是 `state.status === "saving"`；保存的是宿主设置 `welcomeNoticeVersion=2026-09-28.1`，没有同意复选框或倒计时。私有探针现改为首击之后等待该具体 DOM 节点卸载再继续，不绕过保存、不改产品、不简单放宽超时。后续低负载复跑越过该初始化问题，发现下述产品侧栏高度缺陷。

另备 `output/qa/3.0.0-package-probe.mjs`，语法检查通过但**未执行**。接受显式旧/新包路径与可选 SHA256，校验包内真实版本，安排同一隔离库的 `2.7.1 → 3.0.0 → 2.7.1 → 3.0.0`：UI 更新由 loopback release feed 提供真实候选包字节，降级用宿主 plugin add；每次字幕完成后先显式归档，核对 archivedJobs；每轮验证版本、资料和题卡内容、旧/新归档任务契约与字幕产物文本 hash。未归档字幕 recoveryMode:none，原始 Call output 也不要求持久化，探针不再错误要求它们跨重启存在。此准备不算升级或回退验收结果，也不使用 `dsh-upgrade.mjs` 的重标当前包方案冒充旧版。

## 失败保留与侧栏修复

- 英文第二次尝试在 onboarding 保存中重复点击而失败（4 项通过、1 项失败），保留 `output/qa/3.0.0-dsh-en-onboarding-failure/`。根代理将等待改为首击后等待确切 DOM 节点卸载，不放宽超时。
- 英文最终 `qa:dsh --lang en` **8/8 通过**，页面错误 0、控制台错误 0、真实模型调用 0，见 `output/qa/3.0.0-dsh-en-fixed/summary.json` 与 `output/verification/300-host-en-final.log`。
- 修复前额外布局矩阵只完成 **2/16 格**：中文、浅色、1280、产品界面 100% 与 150%，两格均无横向溢出并通过 CLS 0.05 上限。该次其余格未通过；修复后结果单独记录如下。

### 产品界面 150% 时设置入口不可达

在真实 DSH rc.2、1280×900 视口，用产品“设置 › 界面 › 150%”设置后，`.study-app` 的可用内部高度为 600，实际高度 900；`.sidebar` 却因 `ui/shell.css` 的 `min-height: min(700px, 100dvh)` 保持内部高度 700，实际高度 1050。侧栏滚动到约 187 后，“设置”仍位于 y=955..1018，超出宿主 900 像素视口；外层宿主容器裁切溢出。切为窄窗及先保持宽窗配置两条探针都失败，DOM bounds 与滚动链已保存。

这项是真实产品可达性问题，不能靠直接注入 CSS、放宽超时或只截图掩盖。经授权先补失败回归，再将侧栏 `min-height` 改为 `0`，保留 `height:100%` 与自身 `overflow-y:auto`，让高度服从缩放后的宿主空间；不改导航布局设计。现有 `nav-groups-browser.test.mjs` 加入 1280/420 宽度、900/480 高度、100%/150%/200% 产品界面字号的 12 格回归，每格真实点击“资料库”和“设置”，并核对入口在视口内。红灯为 4 格通过、8 格失败；修复后全文件 14/14 通过（包含原导航测试和父测试），无跳过。日志分别为 `output/verification/300-host-nav-red.log`、`300-host-nav-green.log`。真实宿主需使用重新构建并安装的包复验，结果单独记录。当前包升级回退探针仍未执行。

### 任务历史边界

第一次额外探针重启了原 runtime smoke 宿主，发现未归档字幕任务列表为空、资料仍可读。只读核对 `lib/contexts/audio/jobs/subtitles.js` 与 `docs/job-contract.md` 后确认：字幕 `recoveryMode:none`，只有显式归档记录承诺跨重启保留，原始调用输出为内存保留。这是原探针前提错误，不是任务丢失缺陷。后续布局探针通过公共 `audio.subtitles.import` 新建 fake 字幕任务；真实包升级回退探针已改为先归档再测。

### 可提交的脱敏证据

- [基线与中英文 QA 的每次结果](evidence/s6-9-host-baseline.json)：基线 SHA、实际版本、日期、步骤、错误，以及截图 SHA256/相对本地路径索引；保留英文两次红灯和最终绿灯。
- [额外布局矩阵、150% 缺陷与修复](evidence/s6-9-host-ui.json)：初始化失败、历史前提纠正、原 2 格通过与侧栏失败、修复后的 16/16、红绿回归、实际 DOM bounds、截图哈希与限制。

图片和完整运行日志留在私有 `output/qa/3.0.0-*` 与 `output/verification/300-host-*`，不提交巨量图片。证据 JSON 不包含 host token 或所有者绝对路径。上述结果仍对应包内版本 2.7.1 的准备基线，不替最终 3.0.0 发行包背书。

## 侧栏修复后的真实宿主验收（2026-10-07）

- `ui/shell.css` 仅将侧栏最小高度改为 `0`；`tests/nav-groups-browser.test.mjs` 增加上述 12 格回归。两个文件保留 CRLF。`scripts/qa/dsh-e2e.mjs` 保留根代理的类别选择器与 onboarding 等待修复。
- 使用修复后的源码重新 `build`、`pack`，通过既有 `qa:dsh-runtime` 安装到私有 `output/qa/s67/home`；新一轮 **19/19 通过**，页面与控制台错误 0。证据为 `output/qa/3.0.0-runtime-fixed/summary.json`；实际包版本仍是 2.7.1，包 hash 与三个修改文件的 hash 已入证据。
- 同一重新安装的宿主，**16/16 格通过**：zh/en × light/dark × 1280/420 × 产品界面 100%/150%。移除私有探针的 `force:true`，每格真实点击进入任务页，随后真实点击设置，校验设置入口落在视口内、侧栏不高于宿主。每格横向文档溢出为 0，CLS 为 0，页面与控制台错误 0。仅 loopback fake，真实模型请求 0。
- `output/qa/3.0.0-host-ui/summary.json` 与 16 张任务页截图保存本次结果；原失败另存 `sidebar-height-red-summary.json`、`sidebar-height-red-diagnostic.png` 与 `red-tasks-*.png`，不会用绿灯覆盖旧结论。截图索引与 hash 均在证据 JSON。
- `ce-code-review` focused 本地审查完成，0 findings，receipt 为 `output/verification/300-host-review/review.json`；审查结果及范围也写入可提交证据。根代理在独立上下文复核，但曾共享诊断并编写两处 QA 修复，因此明确不是盲审或跨模型审查。既有外部审查拒绝没有重试。
- 两个修改 JS 文件的定向 ESLint、`git diff --check` 通过。没有另开全量 verify。宿主停止后 3297/4297 均返回 ECONNREFUSED，见 `output/verification/300-host-fixed-port-cleanup.json`。

重放本轮修复检查：

```powershell
node scripts/test.mjs --test-concurrency=1 tests/nav-groups-browser.test.mjs
node scripts/qa/dsh-runtime-smoke.mjs --dsh-bin 'D:\Program Files\nodejs\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js' --port 3297 --model-port 4297 --out output/qa/3.0.0-runtime-fixed
node output/verification/300-host-ui.mjs
```

环境隔离同上。界面 200% 与 480 像素短窗由新增浏览器回归覆盖；16 格宿主矩阵只覆盖 100%/150% 与 900 像素高度。这里没有测试浏览器或 DSH 外壳缩放，也没有执行真实 2.7.1/3.0.0 包升级回退；这些边界不因侧栏修复通过而消失。
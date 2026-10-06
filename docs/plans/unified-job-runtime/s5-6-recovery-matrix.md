# S5-6：未知副作用与停止/恢复集成矩阵

核验日期：2026-10-07。分支 `codex/runtime-s56-recovery-matrix`，基于 S5-2（#315）的分支。工作包文本见 [U33](sprints-2-6.md#u33-s5-6)；前序：[S5-1 契约](s5-1-nonmodel-contract.md)、[S5-2](s5-2-pdf-convert.md)、[S5-3](s5-3-marker-install.md)、[S5-4](s5-4-mineru-setup.md)、[S5-5](s5-5-retrieval-index.md)。

本步是**矩阵**：每条非模型路径 × 三个失败点，每一格有一条用真实 fake（fake MinerU 服务器、fake python/mineru/Marker 命令、fake 搜索扩展）的测试；格子里已经成立的只固定，不成立的修，修不了的写明原因。主文件 `tests/unified-runtime-nonmodel-recovery.test.mjs`（新格子），其余格子由前序步骤的测试覆盖，下表给出位置。

三个失败点：**A 副作用之前**（停止/崩溃发生在任何外部改动之前）、**B 已提交未记录**（外部改动做了，本地记录还没写）、**C 停止未确认**（停止请求发出，但外部操作是否已结束/是否已生效不知道）。

## 1. 矩阵

状态：**成立**＝前序步骤已有测试；**新增**＝本步新增的格子测试且当时已成立；**修复**＝本步发现缺口并修；**限制**＝未覆盖并说明。

| 路径 | A 副作用之前 | B 已提交未记录 | C 停止未确认 |
|---|---|---|---|
| **PDF 云端**（P1） | 新增：停止在第一次创建之前，MinerU 零请求，manifest 没有 batch 引用（`PDF cloud · before the side effect`）；排队中取消从等待线移除、兄弟继续——成立（`pdf-convert`） | 创建回复丢失：不自动重发，`create-unknown`，意图先落盘——成立（`pdf-create`、`pdf-convert`）；已创建未上传：按已存 batchId 先查询——成立（`pdf-create`）；**导入已完成而终态/回执没保存**：重复恢复只导入一次（同一合并字节哈希得同一文档）——新增（`PDF cloud · committed, terminal not saved`，关闭 V-5 对云端路径的待核验）；信件再写一次仍是同一封（折叠）——新增（`PDF · terminal and notice after the checkpoint`）；**保存的 PDF 不是当初计划的那份**：恢复被拒绝——**修复**（`assertSameInput`，见 §2） | 上传途中停止：不向 MinerU 发任何取消/删除，批次引用保留在 manifest，不被写成"已停止"——新增（`PDF cloud · stop not confirmed`）；创建回复不知——`create-unknown`/`create-unverified` 明确拒绝不盲发——成立 |
| **PDF 本地 / Marker 转换**（P2/P3） | 排队取消、窗口之前取消——成立（`pdf-convert`、`mineru-local-service`） | 窗口结果已写入 `results/` 缓存但 manifest 没保存：按页范围从缓存恢复该窗口——成立（`mineru-adaptive-service`、`nonmodel-baseline-cache`） | 取消后窗口进程还在：Job 保持 `cancelling`，同一本书不能再开始（"已经在转换"），进程退出后才 `cancelled`、才可再开始——新增（`PDF local · stop not confirmed`）；取消在进程退出与目录清理之后才结算——成立（S5-2/D-9） |
| **Marker 安装**（P4） | 未确认/计划有问题/助手调用：Job、文件夹、进程都不存在——成立（`marker-install`、`assistant-settings-boundary`） | 崩溃留下"运行中"状态但没有运行：显示 `interrupted`（不是运行中也不是已安装），文件夹因 sentinel 仍归安装器，新的开始在其中继续、卸载可清除——新增（`Marker install · committed, state not saved`） | 取消：回执仍是运行中，进程退出后才 `cancelled`；期间再次开始/卸载都是 `busy`；半成品文件夹与 sentinel 保留、不自动卸载、程序路径设置不动——新增（`Marker install · stop not confirmed`） |
| **MinerU 本地 setup**（P5） | 未确认/档位不存在/没有 mineru：先于任何 Job 与进程——成立（`mineru-setup`） | 模型已下载但模式没打开（中间崩溃的状态）：再次 setup 不重复下载，只补写配置——新增（`MinerU setup · committed, not recorded`） | 下载中取消：不写任何配置，`mineru.local.status` 不被说成 ready，期间再次开始是 `setup-busy`，进程退出后才 `cancelled`——新增（`MinerU setup · stop not confirmed`） |
| **检索索引**（P6） | 扩展没运行/没有会话：先于 Job——成立（`retrieval-index`） | 写入已被扩展收下但 manifest 没保存：任务失败并说明，下次按同一 sourceKey 替换而不重复——成立（`retrieval-index`） | 在途写入未回答时取消：仍是 `running`（cancelling 不是 cancelled），第二次开始并入同一个构建、不再发写入，被打断的页列为 `unconfirmed`，不被说成已写或未写——新增（`Index · stop not confirmed`）；取消后无新写入——成立 |

## 2. 本步修的缺口

**恢复时输入不一致（U33"输入…不匹配拒绝恢复"）**：`convertPdf` 恢复（`manifest.splitDone`）时直接信任任务文件夹里的 `source.pdf`。若这份副本和 manifest 记录的 `sourceHash` 不同（被替换、损坏），后续分段会按**别的 PDF**转换并导入。现在恢复时先对 `source.pdf` 取 SHA-256 与 `sourceHash` 比较，不同则以 `input-changed`（永久错误，保留已解析结果缓存、清掉任务文件夹）拒绝，提示重新导入，**先于任何请求**（测试：零请求）。首次运行不做此检查（还没有切分），所以只在恢复时多读一遍文件。该检查对原路径也生效（同一份 `convertPdf`）：对一个已损坏/被替换的输入拒绝继续是严格更好的行为，已列入 PR 说明；英文文案已补。

## 3. 没有加 pdf-convert 的持久化适配器——为什么

U33 提示"导入完成、终态没保存、恢复不得重复资料"可能需要家族持久化端口。核对后**不需要**：转换的"提交"是文档导入，导入层以合并字节的哈希作文档 id，重复导入同一份合并结果是幂等的（测试直接固定：导入后崩溃再恢复，来源页数不翻倍、只有一个文档）；信箱信按（类型，任务 id）折叠为一封。manifest 在导入后、清理前仍在，所以崩溃后的恢复仍是原有的"已中断，可接着做"，不需要新的记录文件。因此 pdf-convert Job 继续不持久化（`recoveryMode: none`），重启恢复沿用 `recoverConvertJobs`。若将来要让**Job 记录**本身跨重启存在（控制台里保留历史），那是 S6 的统一记录问题，不是正确性缺口。

## 4. 限制（未覆盖）

- **进程树在取消后超过 10 s 仍不退出**：`runLocalCommand` 到时放行调用方（`KILL_WAIT_MS`），此后该 Job 被标成已取消而进程可能仍在运行，这一格不能证明"进程已停"。需要进程见证（pid + 启动时间）才能让新 attempt 拒绝启动；V-4（Windows `taskkill` 的真实退出时机）未在真机上验证。
- **MinerU 云端的空批次/额度**：V-1 未验证，所有云端格子只证明"我们没有盲发、没有删除、保留了引用"。
- **Marker 安装/MinerU setup 的"进程仍活但宿主已丢失 owner"**（重启后孤儿进程）：这两个 Job 无持久化，重启后不会知道旧进程是否存活；安装靠 sentinel 与 `marker-install.json` 的 `interrupted` 显示，setup 靠 mineru 自己的状态检测，均不会把"未知"说成"已停止/已就绪"（上表 B 列测试），但不会主动查找孤儿进程。
- 本步不改控制台 UI，用各步已有的 `taskSummary` 读真实快照验证。

## 5. 测试

`tests/unified-runtime-nonmodel-recovery.test.mjs`（11 条新格子）；顺带把各步测试里重复的服务夹具抽到 `tests/helpers/{marker-install,mineru-setup,pdf-convert,index-library}-harness.mjs`（对应测试文件改为引用，断言未改）。

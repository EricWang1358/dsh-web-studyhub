# StudyHub Spring

> **实验性 beta，不供日常学习使用。** StudyHub Spring 是开发中的实验分支，不是 StudyHub 的推荐安装方式，也不在发布说明或下载页中提供给学习者。日常学习请使用 DSH 插件或 StudyHub 桌面版（Tauri）。这里的安装包和同步服务只用于开发与验证，数据格式和功能可能随时变化。
>
> **Experimental beta, not for regular use.** StudyHub Spring is an in-development experiment, not a recommended way to install StudyHub, and it is not offered to learners in release notes or download pages. For everyday study use the DSH plugin or the StudyHub desktop app (Tauri). The installers and sync relay described here are for development and verification only; data formats and features may change at any time.

Track S 提供 Windows 和 Linux 桌面程序，以及可以单独部署的 Java 加密同步服务。桌面程序把主仓的 React 界面、Java 21 运行时和兼容引擎一起打包。同步服务只需 Java 或 Docker。

## 启动桌面版

从源码运行需 JDK **21**、Maven 3.9、Node 22.22.3 和主仓的 npm 依赖。DPAPI 与结构化并发使用 Java 21 的预览 API。请让 `JAVA_HOME`、`java` 和 Maven 使用同一套 JDK。首次安装 npm 依赖时设置环境变量 `STUDYHUB_SKIP_PREPARE=1`，即可跳过 DSH 插件构建。以下命令从仓库根目录运行。

```sh
npm ci
mvn -f packages/studyhub-spring/pom.xml -pl studyhub-sync-api -am package -DskipTests
java --enable-preview --enable-native-access=ALL-UNNAMED -jar packages/studyhub-spring/studyhub-sync-api/target/studyhub-sync-api-0.1.1-SNAPSHOT-exec.jar --server.port=8176 --studyhub.ai.enabled=true
```

浏览器打开 [本机 StudyHub](http://127.0.0.1:8176)。安装版会自动打开 Windows WebView2 窗口或 Linux 默认浏览器。Windows 托盘菜单的 Exit 会关闭后台服务。指定 `--headless` 可以只启动本机学习服务。指定 `--studyhub.data-dir=<目录>` 可以使用独立的数据目录。

Maven 调用主仓 `scripts/build.mjs` 中的 `buildPreview`，将 `npm run build` 使用的同一 React 入口和 CSS 直接输出到 JAR。主仓 `lib/`、`ui/` 和三个现有桌面、检索、终端包都是只读输入。ESLint 10 通过本包的配置跳过 Maven 构建树。根 npm 发布清单排除了整个 Track S。

## 两种后端怎样配合

| 使用场景 | 执行入口与数据位置 |
| --- | --- |
| 既有 UI 操作 | Spring 在回环地址托管静态资源，验证 Host、Origin 和会话令牌，为 `POST /api/call` 与 `GET /api/events` 接入主仓 Node sidecar。题库仍由原有分片 JSON Store 管理，位于数据目录下的 `library/`。发布的桌面安装包内含 Node。 |
| 原生出题和异家族审题 | `POST /api/ai/jobs` 提交纯文本任务。用 `POST /api/ai/reviewed-drafts` 从题库来源建立可发布草稿，桌面与 API 共用审题决定、来源和版本检查。任务的 `/events` 端点推送阶段进展，现有任务控制台可查看、取消与继续原生任务。SQLite 保存请求意图、回执和完成的结果。远端是否已处理无法判定时，任务进入对账状态。常规 UI 的 `generate` 调用继续由兼容引擎处理。[AI 模块](studyhub-ai-engine/README.md) |
| 原生检索 | 配置 `--studyhub.retrieval.model-dir=<已校验模型目录>` 后，用 `/api/retrieval/source` 按学习库、课程和来源建索引，用 `/api/retrieval/search` 查询。下载命令、索引规格和评测数据见 [检索模块](studyhub-retrieval/README.md)。 |
| FSRS 与 SQLite | Java FSRS-6 实现主仓调度策略，局部 L-BFGS 依据真实作答结果拟合初始稳定度与衰减参数。SQLite WAL、Flyway、版本检查、乐观锁与 SHA-256 Blob 仓由存储模块提供。[互读与数学等价测试](studyhub-storage/WP-S2.md) |
| 多端同步 | Java 客户端离线追加作答，按 HLC 合并并重放 FSRS。中继只保存 AES-256-GCM 密文和路由所需的元数据。启用桌面作答同步后，Java 加密传输 Node 已提交的原值、改分及撤销记录。整库仍可显式备份和恢复。[同步服务和客户端命令](studyhub-sync-api/SYNC.md) |

三个用例划清了写入责任。[`ReviewedDraftPublisher`](studyhub-sync-api/src/main/java/io/studyhub/gateway/ReviewedDraftPublisher.java) 将 Java 审题回执与 Node 保存的来源、草稿版本及发布回执关联起来。[`RecordReviewAttempt`](studyhub-sync-api/src/main/java/io/studyhub/sync/RecordReviewAttempt.java) 管理原生作答的首次写入、改分和撤销。[`DesktopReviewHistory`](studyhub-sync-api/src/main/java/io/studyhub/sync/DesktopReviewHistory.java) 采集和读取桌面历史修订。FSRS 和操作合并规则位于纯 Java 领域模块。当前发布用例直接调用 Node HTTP 适配器，原生作答用例直接使用 SQLite 副本的事务。

本机 API 读取页面提供的 `X-Study-Token`。AI Provider 优先读取已配置的环境变量，也支持通过受认证的 `PUT /api/ai/credentials/{变量名}` 写入密钥，正文为 `text/plain`。Windows 根据当前登录账户调用 DPAPI。Linux 图形会话可用 `secret-tool` 连接 libsecret。无桌面或没有该工具时，用 `STUDYHUB_KEYSTORE_PASSWORD` 派生密钥，将凭据以 AES-GCM 加密保存。Windows 数据默认位于 `%LOCALAPPDATA%\StudyHub`，Linux 使用 XDG 的数据和配置目录。

上述密钥接口用于 Java 原生工作流。兼容引擎的 `desktop.config.save` 沿用 Node 的 `desktop.json` 配置存储。Windows 原生凭据的保护范围由 DPAPI 和当前用户账户决定。[Microsoft DPAPI 文档](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

网关按主仓限制拒绝超大请求，返回 HTTP 413。检查 RPC 类型时，请求体在 64 KiB 以内存入内存，更大的请求体暂存到磁盘，转发结束后删除临时文件。

## 同步桌面已提交的作答

在两端配置同一中继、令牌、客户端 AES 密钥和 vault。每端使用独立的设备标识和 SQLite 文件。启动桌面程序时增加以下参数。两端使用相同的逻辑学习库 ID，并分别指定各自的 Node 学习库绝对路径。

```text
--studyhub.desktop-history.enabled=true
--studyhub.desktop-history.library=my-course-library
--studyhub.desktop-history.root=<该设备上的 Node 学习库绝对路径>
```

默认每 5 秒扫描一次，保留扫描时可见的完整已提交作答，包括实际调度结果、改分前的等级、撤销标记和扩展字段。若在两次扫描之间作答又撤销，采集到的第一版可能已经带有撤销标记。断网时继续收集，重连后发送。另一设备用本机会话令牌访问 `GET /api/sync/desktop-history` 分页查看版本，访问 `GET /api/sync/desktop-history/{revision}` 读取原值。远端记录供查看，桌面当前课程、答题轮次和复习日期仍由本机 Node 库管理。还原整库使用显式备份。启用前请先将同一 vault 的客户端升级到 0.1.1。[连接变量与读取方式](studyhub-sync-api/SYNC.md)

## 部署私有同步服务

将随机生成的至少 32 字符令牌放入 `STUDYHUB_SYNC_TOKEN`，在 Track S 目录运行以下命令。Compose 会从仓库源码构建中继。

```sh
docker compose -f docker/compose.yaml up --build -d
curl --fail http://127.0.0.1:8080/actuator/health
```

Linux x86-64 上，0.1.1 从源码构建的镜像为 **119,032,253 字节**（119.03 MB），使用已验证的 Maven AOT 中继 JAR 构建的镜像为 119,363,557 字节。两种镜像均以 UID 10001 运行，健康检查返回 `UP`，无令牌的同步请求返回 HTTP 401。

默认 Compose 只发布本机端口，数据保存在命名卷中。需要远程桌面访问时，使用 TLS 反向代理。客户端的 32 字节 AES 密钥只在客户端之间传递。中继令牌用于整个私有实例。systemd 模板从 `/etc/studyhub/sync.env` 加载令牌，运行 `/opt/studyhub/relay.jar`，并将状态保存在 `/var/lib/studyhub-sync`。[systemd unit](studyhub-platform-shell/linux/studyhub-sync.service)

## 构建、验证和打包

在仓库根目录执行以下命令。模型下载器检查固定 revision、文件长度和 SHA-256，复用已校验文件。普通 `mvn test` 会跳过单独启用的真实模型与性能基准。

```sh
npx playwright install chromium
node packages/studyhub-spring/studyhub-retrieval/fetch-model.mjs packages/studyhub-spring/studyhub-retrieval/target/model
mvn -f packages/studyhub-spring/pom.xml -Prelay-aot "-Dstudyhub.real-model=true" verify
node packages/studyhub-spring/studyhub-platform-shell/pack.mjs app-image
```

`pack.mjs` 会输出本次 app-image 的目录。在同一操作系统再次调用该脚本，指定 `msi`、`exe`、`deb` 或 `rpm`，再传入 `"--app-image=<完整应用镜像目录>"`。Windows 使用 WiX 3、.NET Framework 编译器和 WebView2 Runtime，`WIX_BIN` 可以指向已有的 WiX 工具目录。Linux 的安装包构建需要 `fakeroot` 或 RPM 构建工具。

跨语言套件会运行真实 Node 和 Spring 服务、用两个浏览器配置导航材料库，并核对错误响应、状态写入及 SSE。ArchUnit 检查领域、平台适配器和应用用例的依赖方向。在 Track S 目录运行 `node studyhub-platform-shell/verification/desktop-lifecycle.mjs "<启动器或可执行 JAR>" --editor` 可验证打包后的 PDF → 出题 → 刷卡 → 重启流程，并在 Chromium 中打开编辑器检查拒审提示。模型响应由回环 HTTP 测试服务提供。路径触发的 CI 在 PR 上使用 Ubuntu，手动或发布时增加 Windows 安装包构建。

### 0.1.1 本地验收

- 在中文 React 草稿编辑器实际点击「发布并开始练」，独立审题通过的草稿打开了对应练习，拒绝的草稿停在编辑器并显示英文原因。普通、快捷、后台和发布计划四种入口都受同一决定约束。同一版本并发发布只生成一份题组。修改题目或来源后须重新审题。
- 编辑器中的「未自动审阅」读取 Node 的逐题审阅标记。Java 的独立审题结果保存在草稿的 `editorial.nativeReview` 和任务详情中，两种审阅分别记录。查看 Java 批准或拒绝的理由，可用草稿的 `workflowId` 读取任务的最后一个审题阶段。
- 在 Windows 和 Linux 分别运行两台独立桌面和一个真实中继。模拟断网、改分、撤销和重启后，两端都能读到相同的六条历史修订。逐项核对了 Node 作答扩展字段与原始调度值。接收端的本地题库和到期日保持原值。
- 用最终桌面 JAR 在 UTC 时区提交原生作答，再在新的 JVM 进程中切到 Asia/Shanghai，使用同一操作 ID 重试，两次都省略时间和时区。前后的完整复习状态相同，历史中只有一条作答。
- Debian 12 和 Amazon Linux 2023 使用各自的包管理器从 0.1.0 升到 0.1.1，保留了已有课程和作答。另用缺少 XDG 菜单目录的最小 Debian 12 验证了全新安装，安装后通过双桌面离线同步测试。
- Windows 11 使用实际的 0.1.0 MSI 建库，再用 0.1.1 MSI 升级。安装后的 WebView2 能打开资料页，关闭窗口后托盘和服务可用。随后单独用 0.1.1 EXE 安装，启动器读回了同一门课程。两种安装方式的 JAR 都与 Maven 产物哈希一致，安装包均未签名。
- 完整 Maven 构建包含真实 ONNX 推理、FSRS 对照、跨语言契约和 ArchUnit。39 项在完整构建中通过，第 40 项检索基准随后独立通过。1,000 个段落的混合检索 Recall@10 为 0.7500，热查询 p95 为 13.19 ms。用实际 0.1.0 可执行 JAR 验证了旧客户端收到新格式时会回滚整页，升级后可以继续接收。

### 0.1.0 本地验收

- 在 Windows 11 用 JDK 21 运行完整八模块 Maven 构建，共 34 个测试用例，33 个通过，单独启用的检索基准随后独立跑完。真实 Chromium 覆盖中文浅色桌面宽度及英文深色窄屏。FSRS 对照主仓 `ts-fsrs` 的 1,000 条轨迹、14,000 次作答，稳定性和难度的最大绝对误差均为 0。
- Debian 12 的 DEB、Amazon Linux 2023 的 RPM 和 Windows 11 的 MSI 均通过原生包管理器从本地构造的 0.0.9 升级到 0.1.0。Linux 保留了升级前记录的作答，Windows 保留了升级前创建的课程。Windows 安装后的 JAR 与 Maven 验证产物的 SHA-256 一致，WebView2 能打开材料库，关闭窗口后托盘图标和后台服务可用。
- 卸载 MSI 后，使用独立 EXE 安装包重新安装。安装后的启动器打开了同一份隔离测试数据，课程仍可读取。两个 Windows 安装渠道均核对了实际安装的产品标识和 JAR 哈希。最终卸载清除了测试产品注册、安装目录和快捷方式，本地生成的 MSI、EXE 均未签名。
- Windows、Linux 客户端通过 Docker 中继双向交换加密作答。独立的分区测试设置了五分钟的时钟偏差，让两个副本各自离线作答 100 次。恢复连接后，两端得到相同的作答集合和 FSRS 状态。systemd 模板通过 Ubuntu 的 `systemd-analyze verify`。

## 检索基准

Windows x64 使用量化多语 MiniLM，在同一课程中检索项目的真实文档段落。12 个中英文查询各有一个指定目标。热查询包含编码、检索、RRF 和取回正文。

| 段落 | BM25 Recall@10 | 混合 Recall@10 | 混合 MRR@10 | 热查询 p95 | 重建后首查 | 进程 RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.4167 | 0.7500 | 0.3497 | 12.95 ms | 0.70 s | 843.4 MiB |
| 10,000 | 0.2500 | 0.2500 | 0.2500 | 75.68 ms | 21.39 s | 1,349.1 MiB |

万段落时两种方法都找回 3 个指定目标，混合检索将这 3 个目标全部排到第一。Windows 和 Linux x86-64 已用真实模型推理。在 Docker 模拟的 Linux ARM64 环境中，最终 JAR 也通过了离线推理、跨语言检索、课程隔离和 SQLite 重开测试。Windows ARM64 原生 JVM 还需要相应 JNI 二进制。[语料与复现方法](studyhub-retrieval/README.md)

## JVM 实测

`studyhub-platform-shell/verification/benchmark.py` 对同一份使用 `-Prelay-aot` 构建的同步中继比较普通 JVM 与 Spring AOT + AppCDS。每次从新进程启动到健康接口首次返回 UP。每种配置运行三次，交替顺序，记录中位数。每次用同一条 HTTP 连接发 100 次健康请求，再读操作系统 RSS。操作系统文件缓存保留。模型推理、UI、Node 子进程与网络模型时延都不在这组中继数据内。

```sh
python studyhub-platform-shell/verification/benchmark.py studyhub-sync-api/target/studyhub-sync-api-0.1.1-SNAPSHOT-relay.jar --runs 3
```

下表为 0.1.0 在 2026-11-26 的实测值，使用同一台 Ryzen 9 7945HX。Windows 11 x64 使用 Oracle JDK 21.0.4，Ubuntu 22.04 x64 运行于 WSL2，使用 Temurin 21.0.13.1。两个模式的 JAR 都先复制到被测系统的临时文件系统。每轮的 RSS 在健康请求结束后采样。

| 系统 | JVM 模式 | 启动至健康 | RSS | 健康请求 p99 | 串行请求/秒 |
| --- | --- | ---: | ---: | ---: | ---: |
| Windows 11 | 标准 | 6.875 s | 290.32 MiB | 15.114 ms | 89.50 |
| Windows 11 | AOT + AppCDS | 3.625 s | 250.33 MiB | 16.398 ms | 100.37 |
| Ubuntu 22.04（WSL2） | 标准 | 4.968 s | 352.33 MiB | 16.110 ms | 145.91 |
| Ubuntu 22.04（WSL2） | AOT + AppCDS | 2.806 s | 229.07 MiB | 13.816 ms | 140.69 |

这台机器上，两端启动时间分别缩短 47.3% 和 43.5%。Windows 的 p99 增加 1.284 ms，Linux 的串行请求速率下降 3.6%。表中数值是单机三轮样本，服务容量需用实际同步负载另行测量。

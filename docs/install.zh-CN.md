# 安装 StudyHub 并配置模型

[English](install.md) · 中文

StudyHub 是 DeepSeek Harness（DSH）的学习插件。DSH 可以装成桌面应用，也可以在浏览器里以网页版运行。先装好 DSH，再在 DSH 的插件管理里添加 StudyHub，最后配一个模型用来出题。想在浏览器里对照着装，可以下载[浏览器安装引导](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.2.0/StudyHub-3.2.0-Setup.zh-CN.html)。

| 你的情况 | 从这里开始 |
| --- | --- |
| 还没有 DSH | 先[安装 DSH](#安装-dsh)，再[在 DSH 中安装 StudyHub](#在-dsh-中安装-studyhub) |
| 已经在用 DSH 桌面版或网页版 | 直接[在 DSH 中安装 StudyHub](#在-dsh-中安装-studyhub)，原有模型、工作区和配置都不用动 |
| 已装旧版 StudyHub | [更新 StudyHub](#更新-studyhub) |

**需要准备**

- **DSH 0.2**：StudyHub 3.2.0 要求 DSH `>=0.2.0-rc.2 <0.3`。DSH 和 StudyHub 的版本号各自独立。
- **能装 DSH 的电脑**：本文提供的桌面安装器适用于 Windows x64 和 Apple 芯片（M 系列）的 Mac。其他电脑先查看 DSH 官网，或用 DSH 网页版（需要 Node.js 22.19 或以上）。
- **模型，只在用 AI 功能时需要**：出题和讲解要用模型，见[配置模型服务商](#配置模型服务商)。安装、示例导览、浏览资料和练习已有题组都不需要模型。

## 安装 DSH

已经装好 DSH 的话，跳过这一节。

| 电脑 | 安装方式 |
| --- | --- |
| Windows 64 位 | [下载 .exe 安装器](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe)，安装后启动 DeepSeek Harness。 |
| macOS，Apple 芯片（M 系列） | [下载 .dmg 安装器](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg)，打开磁盘映像，按提示把 DSH 放进「应用程序」，然后启动。 |
| Linux，或任何电脑只想用网页版 | 安装 Node.js 22.19 或以上，再运行下方命令启动网页版。 |

两个安装器都来自 [DSH 官网](https://www.deepseek.com/en/harness/)，自带运行时，不用另装 Node.js。本文只列出这两个核实过的安装器，不提供 `.deb`、AppImage 等其他安装包。Intel 芯片的 Mac 或 Windows ARM 电脑，请先查看官网的最新支持情况，或改用网页版。

启动网页版，在终端运行：

```sh
npx @deepseek-ai/dsh web
```

DSH 默认在 `http://127.0.0.1:3080` 打开。使用期间保持这个进程运行。已经在用网页版的话，跳过这一步。详见 [DSH 官方启动说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md#run)。

## 在 DSH 中安装 StudyHub

以下步骤桌面版和网页版通用。网页版不用下载客户端，也不用新建配置。

1. 在 DSH 打开「插件」页，点「添加插件」。
2. 粘贴完整安装包地址：

   ```text
   https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.2.0/ericwang1358-dsh-daily-flashcard-3.2.0.tgz
   ```

3. 安装完成后，确认包名是 `@ericwang1358/dsh-daily-flashcard`，版本是 3.2.0。
4. 为 StudyHub 和你需要的组件点「启用」。如果 DSH 提示重新加载，先等后台任务完成或取消它们。
5. 第一次启用后，StudyHub 会自动打开。之后从 DSH 左栏的「StudyHub」进入，不用先发消息。每个会话里和 DSH 右侧栏也有「StudyHub」标签。

学习库为空时，欢迎页的主按钮是「添加资料」。想先看看效果，点「载入示例并开始导览」：会载入一门示例课程（一份讲义、九道带出处的题和三周练习记录），并开始一个短导览（8 步，一两分钟）。两者都不需要模型。示例数据随时可以用「移除示例数据」清掉。

StudyHub 的学习库放在当前 DSH 会话的工作区文件夹里。如果看到「先打开一个会话」，在 DSH 新建或打开一个会话即可。

### DSH 无法从 GitHub 下载时

1. 从 [3.2.0 发布页](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v3.2.0)下载 `ericwang1358-dsh-daily-flashcard-3.2.0.tgz`。同一页的 `SHA256SUMS-3.2.0.txt` 列有校验值。
2. 在「添加插件」里填这个文件的绝对路径，代替上面的地址。

文件必须放在**运行 DSH 的电脑或服务器上**。访问远程网页版时，你自己电脑上的下载路径在服务器上并不存在：先把文件传到服务器，或者直接用上面的 HTTPS 地址。

<a id="配置模型-provider"></a>

## 配置模型服务商

出题、讲解、「帮我弄懂」、校对和翻译要调用模型；安装、示例导览、浏览资料和练习已有题组不需要。模型和密钥由 DSH 保存，StudyHub 使用你在 DSH 里配好的模型。模型用量按服务商计费。

### 先用 DeepSeek 官方 API

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/)创建 API Key，确认账户可以调用模型。请确认服务商当前的地区和账户要求。
2. 在 DSH 打开「设置 › 模型」，在 DeepSeek 卡片填入 API Key 并保存。
3. 回到会话，在模型选择器里选一个模型。

内置的 DeepSeek 卡片不用填写接口地址。自定义接入时，按[官方 API 文档](https://api-docs.deepseek.com/zh-cn/)使用 `https://api.deepseek.com` 和当前支持的模型 ID。

StudyHub 默认用对话输入框里选的模型出题（「跟随当前会话」）。想让出题和讲解单独用另一个已配置的模型，打开 StudyHub「设置 › 学习库与模型」，在「生成模型」里选择。对话用的模型不受影响。

StudyHub 里没有填密钥的地方，密钥只保存在 DSH。想知道模型有没有配好，打开 StudyHub「设置 › 学习库与模型」：页面顶部显示「模型已连接：模型名」，或「模型未连接」、原因和上面的步骤。「模型已连接」表示 DSH 里有这个模型的密钥；密钥是否有效，要到真正用的时候才会知道。在 DSH 里保存之后回到 StudyHub，状态会自动更新，点「重新检查」可以马上刷新。需要模型的地方会先提示「还没有可用的 AI 模型」，并带一个「前往设置」链接，不会让你点了再等着失败。

### 用量大时，先核对 Coding Plan

用量较大时可以考虑 Coding Plan，但前提是套餐提供 API Key，并且条款允许在 DSH 里用于学习。购买前确认：

- 套餐允许哪些工具和用途；
- 专用的 Base URL 和模型 ID；
- 并发限制和额度重置规则。

能创建 Key，不等于套餐允许任意应用调用。有些套餐只支持指定的编程工具，例如 [GLM Coding Plan FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq) 就明确限制了适用环境。StudyHub 不承诺任何套餐适用于学习、批量出题或音频校对。

接入获准的套餐或其他服务商：

1. 在 DSH「设置 › 模型」选择「添加模型提供商」。
2. DSH 已列出的服务商，选中后填入 Key 并保存。其他接口选「自定义模型 API」，填写服务商给出的 Base URL、API 协议、Key 和模型 ID。
3. API 协议要选接口实际支持的那一种。

套餐的专用接口和普通 API 接口可能扣不同的额度。各字段的含义见 [DSH 模型配置指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md)。

### Claude、ChatGPT 订阅不是 API Key

DSH 目前的模型设置不支持 Codex 这类 OAuth 订阅登录。Claude Pro／Max、ChatGPT／Codex 的订阅额度，也不是可以粘贴到 DSH 的通用 API Key。Anthropic 和 OpenAI 单独付费的 API 可以作为第三方服务商添加，费用与订阅分开计算。参见 [Claude 订阅与 API 计费说明](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)和 [OpenAI API 单独计费说明](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)。

### 为录音配置转写服务

把录音转成文字要另配一个转写服务，在 StudyHub「设置 › 音频转写」里填密钥：

- **硅基流动 SenseVoice**：支持录音转写。
- **Gemini**、**Groq**：也受支持；可用地区、额度和收费以各服务商的当前说明为准。

「课堂实录」的实时转写只支持 Gemini。转写之后的校对和翻译，默认使用你在 DSH 会话里选的模型，按服务商计费。详见[音频导入](audio-import.zh-CN.md)和[课堂实录](live-class.zh-CN.md)。

### 不要把密钥放进学习文件

- 模型的 API Key 只保存在 DSH「设置 › 模型」。
- 转写服务的密钥只保存在 StudyHub「设置 › 音频转写」。StudyHub 把它们存在学习库之外，导出和备份里都不会出现。
- 不要把密钥贴到对话、资料、题组或安装引导里。本文和安装引导都不收集密钥。

## 选择中文或英文界面

- 第一次打开时，StudyHub 跟随浏览器：首选语言是中文就显示中文，否则显示英文。
- 在 StudyHub 侧栏底部的「语言」切换。这个浏览器会记住你的选择。
- 切换界面语言不会翻译已保存的资料、题目、笔记或文件名。之后新生成的讲解和反馈会使用当前界面语言。
- 新建题组时，在「创建题组」的「语言」里设定题目语言。练习时想在中文题目下方看到英文，点练习工具栏的「EN」（[详细说明](translate-en.zh-CN.md)）。

## 更新 StudyHub

DSH 插件不会自动更新，只重启 DSH 也不会换成新版本。每次更新都会保留学习库和设置。

### 一键升级（2.1.2 及以后）

自动检查通常使用 6 小时缓存，失败后会更早重试。手动点「检查更新」会立即查询，不受缓存间隔或自动检查开关限制。检查不发送学习数据，也不自动安装。发布版本高于已安装版本时，StudyHub 侧栏会出现「有新版本 x.y.z」提示（x.y.z 是新版本号）。

「设置 › 关于与更新」分别显示当前运行版本、已安装版本和最新已知版本。例如，当前仍运行 2.5.8、已安装 2.5.10 等待重启时，如果发布了 3.2.0，可以直接安装 3.2.0，最后重启一次；待重启提示不会遮住更高版本的升级入口。相同或更旧版本不会重复安装。检查失败会保留上次获知的版本，并单独提示连接状态。

1. 点这个提示，再点「一键升级到 x.y.z」和「确认升级」。
2. 如果有后台任务在运行，StudyHub 会提示有几个。点「停止任务并升级」会先停止这些任务，已完成的部分会保留；也可以等任务结束后再升级。
3. StudyHub 从 GitHub 发布页下载安装包，按 `SHA256SUMS-x.y.z.txt` 核对 SHA-256，再交给 DSH 插件管理安装。重启之前可以继续学习。
4. 重启 DSH：
   - **桌面版**：完全退出 DSH（包括托盘图标），再重新打开。
   - **网页版**：停止 DSH 服务，按原来的方式（同一个配置）重新启动，再刷新页面。

只刷新浏览器不会加载新的插件代码。

点「稍后提醒」会隐藏这个版本的提示，之后仍可在「设置 › 关于与更新」里升级。那里的「检查更新」会立即检查，「自动检查更新」可以关掉每 6 小时的查询。连不上 GitHub 时，StudyHub 会稍后自动重试。

### 手动升级

2.1.2 之前的版本、不支持在应用内安装插件的 DSH，或一键升级失败时（对话框会出现「改用手动升级」），按下面的步骤操作。开始前先等后台任务完成或取消它们。

1. 从升级对话框或发布页复制新版本的安装包地址。
2. 打开 DSH 的「插件」页，找到 StudyHub，点「卸载」。
3. 在同一页点「添加插件」，粘贴地址，安装完成后点「启用」。
4. 按上面的方法重启 DSH。

装过检索扩展的话，「设置 › 关于与更新」也会在它需要更新时提示，并提供「更新检索扩展」按钮。更新检索扩展后同样要重启 DSH。

<a id="高级自定义与后续启停"></a>

## 自定义组件

完整安装包包含 7 个组件，在 **DSH 自带的插件管理**里启用或停用。StudyHub 没有另外的组件管理器。

| DSH 插件管理里的组件 | 提供的功能 |
| --- | --- |
| StudyHub | 主包：StudyHub 页面和各页面共用的功能 |
| StudyHub · 核心 | 所有组件共用的学习库运行时 |
| StudyHub · 资料 | 「资料」页：把 PDF、笔记和网页导入为可引用的资料 |
| StudyHub · 题库 | 题组和题目，以及它们的修改记录 |
| StudyHub · 出题 | 用你的资料生成带出处、经过审阅的题目 |
| StudyHub · 练习与复习 | 间隔复习、模拟考试和「错题与待巩固」 |
| StudyHub · 音频转写 | 「音频转写」和「课堂实录」 |

- 「创建题组」需要资料、题库和出题三个组件。
- 练习、「错题与待巩固」「模拟考试」和「统计」需要题库和练习与复习两个组件。
- 页面所需的组件停用后，StudyHub 会隐藏这个页面，或提示功能已停用。已保存的资料、题组和学习进度都会保留，重新启用后恢复。
- 停用组件前，先结束相关的后台任务。
- 删除资料前，先启用题库和练习与复习，StudyHub 才能检查引用了这份资料的题目、草稿和学习记录。
- 如果同一组件由多个已安装的包提供，要在所有包里都停用才算关闭。旧版完整包仍会提供全部功能，先升级再自定义。

发布页也提供每个组件的独立安装包，同样在插件管理里添加。

### 用命令行安装

在终端管理 DSH 网页版配置时，沿用原来的配置名。`dsh web` 使用的配置名是 `web`：

```sh
dsh plugin --profile web add <安装包地址或绝对路径>
```

用的是自定义配置的话，把 `web` 换成你的配置名。桌面版请用插件管理安装；命令行安装必须先完全退出桌面版（包括托盘图标）。

下载入口、模型和账户要求以所链接的官方说明为准。

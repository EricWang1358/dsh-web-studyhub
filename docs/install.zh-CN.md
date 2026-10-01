# 新用户安装与模型配置

[English](install.md) · 中文

StudyHub 是 DSH 的学习插件。[下载浏览器安装引导](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.0.3/StudyHub-2.0.3-Setup.zh-CN.html)，选择符合当前环境的路径：

- **已有 DSH 桌面版或网页版：仅安装学习插件。** 在正在使用的 DSH 中打开「插件」页，按下方步骤安装全套插件。网页版无需安装客户端，也无需另建配置或迁移已有模型、资料。
- **尚未安装 DSH：** Windows、Mac 可选择官方桌面安装器；Linux 或不希望安装客户端的用户可选择 DSH 网页版。

## 已有 DSH：仅安装全套插件

1. 在现有 DSH 桌面版或网页版中打开「插件」页，选择「添加插件」。
2. 在安装地址中粘贴下方完整工作台包地址，完成安装后确认包名为 `@ericwang1358/dsh-daily-flashcard`、版本为 `2.0.3`。
3. 启用工作台及所需子插件；若提示重新加载，先等当前后台任务完成或取消，再重新加载配置。
4. 选择存放课程资料的工作区，新建会话后进入「学习」页。

更新已有插件包后，结束后台任务并重启 DSH 进程，以加载新版本代码。桌面版退出后重新打开；网页版重启原来的 DSH 服务并保留原 profile。仅刷新浏览器不够。

```text
https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.0.3/ericwang1358-dsh-daily-flashcard-2.0.3.tgz
```

无法直接从 GitHub 安装时，可从 [2.0.3 发布页](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.0.3)下载 `.tgz`，再填写安装包的绝对路径。路径必须在 **DSH 运行的电脑或服务器上**：访问远程网页版时，自己电脑的下载路径不等于服务器路径，可优先使用上述 HTTPS 地址。浏览器刷新不会替换已安装的插件。

### 高级自定义与后续启停

完整包默认安装工作台、运行时、资料、题库、学习、生成和音频组件。使用 **DSH 自带插件管理器**查看包内各组件，按需启用或停用；不另设学习插件管理器。

- 工作台保留界面与共享基础能力；音频、资料、题库、学习、生成使用独立组件开关。
- 生题需要资料、题库和生成组件；答题、错题与考试需要题库和学习组件。停用所需组件时，对应入口会隐藏或提示功能已停用。
- 删除资料前须启用题库和学习组件，完整检查题目、草稿与学习记录的引用，避免误删来源。
- 停用前先结束相关后台任务。停用不删除已保存的资料、题组与学习进度，重新启用后可继续使用。
- 发布页也提供独立子插件安装包，可在同一插件管理器中添加。组件有多个安装来源时，须停用所有提供该能力的来源才会完全关闭；旧版完整工作台仍会提供整套能力，升级后再进行自定义。

通过 CLI 管理现有配置时，请使用原配置名，例如 `dsh plugin --profile web add <安装包地址或绝对路径>`；若正在使用自定义 profile，请将 `web` 换成原配置名。桌面版请优先使用随附的插件管理器。

## 安装 DSH

| 电脑 | 官方安装器 | 安装方式 |
| --- | --- | --- |
| Windows 64 位 | [下载 .exe](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe) | 打开安装器，完成安装后启动 DeepSeek Harness。 |
| macOS，Apple silicon（M 系列） | [下载 .dmg](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg) | 打开磁盘映像，按提示把 DSH 放入「应用程序」，然后启动。 |
| Linux，或任何平台希望仅用网页版 | [官方 npm 启动说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md#run) | 安装 Node.js 22.19 或以上，运行下方命令，再在网页版中安装学习插件。 |

以上复用 [DSH 官方下载入口](https://www.deepseek.com/en/harness/)；安装器随官方版本更新，DSH 的版本号与学习插件的 2.0.3 不同。桌面版自带运行时，无需另装 Node.js。

Windows、Mac 也可以使用以下网页版路径。这里只提供已核实的 Windows x64 与 Mac arm64 桌面安装器；Intel Mac、Windows ARM 用户请查看官方最新支持情况，或使用网页版。

```sh
npx @deepseek-ai/dsh web
```

默认打开本机 `http://127.0.0.1:3080`。保持 DSH 进程运行，在该网页的插件管理器安装学习插件。Linux 当前使用这条官方路径，不提供未经核实的 `.deb` 或 AppImage。已有 DSH 网页版的用户不需要重新运行此首次启动步骤。

## 配置模型 Provider

生成题目、讲解、校对和翻译需要可用的模型提供方；安装插件、查看资料及复习已有题目无需模型。模型和凭据由 DSH 管理。

**日常使用建议 DeepSeek 官方 API。** 在 [DeepSeek 开放平台](https://platform.deepseek.com/)创建 API Key，确认账户可调用模型。打开 DSH「设置 → 模型」，在 DeepSeek 卡片保存密钥，再回到会话选择可用模型。内置 DeepSeek 配置不要求手工填写地址；自定义接入可按[官方 API 文档](https://api-docs.deepseek.com/zh-cn/)使用 `https://api.deepseek.com` 与当前支持的模型 ID。

**用量较大时可考虑兼容的 Coding Plan。** 只选提供 API Key、允许 DSH 及实际学习用途的套餐。购买前检查适用工具、用途、专用 Base URL、模型 ID、并发限制和额度重置规则。某些套餐只支持指定编程工具或编程任务；例如 [GLM Coding Plan FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq)明确限制适用环境，不能因为能创建 Key 就默认它支持本插件。本项目不承诺某个 Coding Plan 适用于学习、批量出题或音频校对。

接入获准的套餐时，在「设置 → 模型 → 添加模型提供商」选择对应提供方；自定义端点选择「自定义模型 API」，填写提供方给出的地址、协议、Key 和模型 ID。按[DSH 模型配置指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md)选择端点真实支持的协议；套餐专用端点与普通 API 端点可能使用不同的计费额度。

**Claude／Codex 订阅不作为本安装流程的 Provider。** DSH 当前模型配置不支持 Codex 等 OAuth 订阅接入；Claude Pro／Max、ChatGPT／Codex 的订阅额度也不是可粘贴到 DSH 的通用 API Key。Anthropic 与 OpenAI 的独立付费 API 可以作为第三方提供方配置，费用与订阅分开。参见 [Claude 订阅与 API 计费说明](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)、[OpenAI API 独立计费说明](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)。

不要把 API Key 填入安装引导、课程资料或题组文件；只在 DSH 的模型设置中保存。音频原始转写另需在学习插件的「设置 → 音频转写」配置 Gemini 或 Groq 密钥，模型 Provider 用于后续校对、翻译与学习帮助。

核实日期：2026-10-01。下载入口、模型和套餐规则以各提供方当前官方说明为准。

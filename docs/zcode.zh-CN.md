# StudyHub for ZCode

[English](zcode.md)

StudyHub 也能装进 [ZCode](https://zcode.z.ai)（Windows 桌面版的 AI 助手）：右侧栏里是完整的 StudyHub 面板，对话里的 AI 能用 StudyHub 的工具帮你导入资料、出题、改复习全书。它和 DSH 插件用的是同一份 StudyHub 代码，每次发布都会附带一个 ZCode 安装包。

思路和第一版移植来自社区用户 BAXUIE 的 StudyHub for ZCode，谢谢！

## 需要什么

| 需要 | 说明 |
|---|---|
| Windows 10 / 11 | 安装脚本是 Windows 的 `install.bat` |
| ZCode 桌面版 | 装在哪个盘都可以（例如 `E:\Program Files\ZCode`） |
| Node.js 22 或更新 | 没有的话到 [nodejs.org](https://nodejs.org) 装 LTS 版 |
| 一个模型的 API Key | 智谱、硅基流动、DeepSeek 都能国内直连；任何 OpenAI 兼容接口都行 |

安装包里已经带好全部依赖和构建好的面板，电脑上**不需要 npm，也不需要联网下载依赖**。

## 安装

1. 在 [GitHub 发布页](https://github.com/EricWang1358/dsh-web-studyhub/releases/latest) 下载 `StudyHub-ZCode-<版本>.zip`。
2. 右键 zip →「属性」→ 勾选「解除锁定」→ 确定。不这样做，Windows 可能拦下 `install.bat`。
3. 解压到一个固定的文件夹，例如 `D:\Apps\StudyHub-ZCode`。不要放进 Program Files；装好后也不要移动它，ZCode 记住的是这个位置。
4. 双击文件夹里的 `install.bat`。它会自己找到 ZCode（按顺序看：正在运行的 ZCode、注册表里的安装位置、每个盘上常见的安装文件夹），检查 Node 版本，然后把这个文件夹登记为 ZCode 的本地插件市场并安装 StudyHub。
   找不到 ZCode 时，把 ZCode 的安装文件夹告诉它：在这个文件夹里打开命令提示符，运行
   ```
   install.bat "E:\Program Files\ZCode"
   ```
5. 完全退出 ZCode（包括托盘图标），再打开。新开一个对话，输入 `/studyhub`，面板就在右侧栏打开。也可以在右侧栏右上角的「添加标签页」菜单里找 StudyHub 学习中枢；`Ctrl+Shift+F` 把侧栏切到主区域全视图。

每次新开对话，StudyHub 会在开头告诉 AI 今天有多少题到期待复习（和面板「统计」页的「到期待复习」是同一个数）。

## 接入模型

ZCode 不把自己的模型借给插件，所以出题、讲解、批改、复习全书这些后台工作，StudyHub 用你自己填的一个 OpenAI 兼容接口。不用改任何文件：

1. 在面板里打开「设置 › 学习库与模型」（需要模型的按钮旁边也会直接出现这张表）。
2. 在「服务商」里选智谱 GLM、硅基流动或 DeepSeek（都能国内直连），或者选「其他」自己填接口地址。
3. 按卡片上的两步注册并复制 API Key，粘贴进去，点「保存并测试」。看到「可用：接口、模型和密钥都通了」就好了。

模型名可以改成你想用的，以服务商页面为准。已经保存的密钥只显示末四位。设置了环境变量 `STUDYHUB_API_KEY` 时，它优先于这里保存的密钥。

## 学习库在哪里

- 默认是「文档」文件夹里的 `StudyHub`（Windows 把「文档」挪到别的盘或 OneDrive 时，用的是挪过去的那个位置）。第一次打开时自动创建。
- 想换位置：「设置 › 学习库与模型」→「学习库」→「更换目录…」，填一个完整路径；「改回默认位置」回到默认。
- 设置了环境变量 `STUDYHUB_LIBRARY` 时，用它指定的文件夹。
- 从 BAXUIE 的 0.4.8 整合包升级过来：学习库还在原来的位置，在「更换目录…」里填回那个文件夹即可。

StudyHub 自己的设置（任务看板、音频转写、更新检查、ZCode 的模型配置）放在 StudyHub 主目录：装过 DSH（有 `%USERPROFILE%\.dsh`）就用它，和 DSH 共用；没有就用 `%USERPROFILE%\.zcode\studyhub`；设置了 `DSH_HOME` 时用它。模型配置在主目录的 `study\zcode.json`。

### DSH 和 ZCode 同时打开同一个学习库

可以。每次写学习库都要先拿到文件锁，锁在两个程序之间生效；一边写完，另一边下次读取就是新内容，不会互相覆盖。要知道的是：后台任务只在启动它的那个程序里运行；另一个程序的「任务」里能看到它的记录，但不能控制它。

## 和 DSH 插件有什么不同

| | DSH 插件 | ZCode 版 |
|---|---|---|
| 模型 | 用 DSH 里配好的模型，可以跟随当前会话 | 用你在面板里填的接口、模型和 Key |
| 后台任务 | 由 DSH 运行 | 在 ZCode 打开时运行；**退出 ZCode 会结束它们**，已完成的部分都保留，重开后在「任务」里点「接着做」继续 |
| 发给主会话 | 填进 DSH 的输入框 | 复制到剪贴板（复制不了时显示全文让你复制），再粘贴进 ZCode 的对话 |
| 升级 | 应用内一键升级 | 下载新的 ZCode 安装包，再运行一次 `install.bat`（面板的升级窗口会给出下载地址和步骤） |
| 选择文件夹 | 系统的文件夹选择窗口 | 输入完整路径 |
| 主会话打开题目（`panel.open`） | 可以 | 不可以；在面板里点开 |

## 隐私

- 学习库、复习记录、ZCode 的模型配置都只存在这台电脑上。API Key 以明文保存在 `study\zcode.json`（和音频转写的密钥一样），不会进学习库、备份或快照，面板也只显示末四位。
- 出题、讲解、批改时，所选资料会发送到你填的接口；复习不调用模型。用音频转写时，录音会发送到你配置的转写服务。
- 检查更新时会访问 GitHub 的发布页（只读版本号，不发送学习数据）；可以在「设置 › 关于与更新」关掉自动检查。
- 面板里的外部链接交给系统浏览器打开。只打开普通的 http(s) 网址，不经过命令行解释。

## 升级与卸载

- **升级**：在面板的升级窗口（或发布页）下载新的 `StudyHub-ZCode-<版本>.zip`，解除锁定后解压（可以覆盖旧版所在的文件夹），再双击 `install.bat`，然后完全退出并重开 ZCode。学习库、模型和设置都会保留。
- **卸载**：在命令提示符里运行下面两行（`install.bat` 结束时也会显示这两行，带着你电脑上 ZCode 的实际路径）：
  ```
  node "E:\Program Files\ZCode\resources\glm\zcode.cjs" plugins uninstall studyhub --force
  node "E:\Program Files\ZCode\resources\glm\zcode.cjs" plugins marketplace remove studyhub-bundle
  ```
  学习库和 StudyHub 主目录不会被删除；不需要了可以自己删掉这两个文件夹。

## 给维护者

- ZCode 版在长期分支 `zcode` 上：它定期合并 `main`，拿到 StudyHub 的每一个改动；ZCode 专用的代码只在 `packages/studyhub-zcode/`、`ui/zcode.jsx`、`ui/zcode/` 里，共享文件里只有一行的挂钩（`ui/host-parts.js`）。
- `npm run build:zcode` 构建面板（`packages/studyhub-zcode/dist/ui`，分片，每个资源不超过 ZCode 的 8 MiB）；`node scripts/build-zcode.mjs --test` 另外生成一个浏览器测试页，配合 `packages/studyhub-zcode/scripts/test-panel-server.mjs` 在真实浏览器里跑生产面板。
- 发布：`main` 发布后，`zcode` 合并那次发布提交，再运行 `npm run release:zcode` 和 `npm run release:zcode:check`，把 `StudyHub-ZCode-<版本>.zip` 和 `SHA256SUMS-ZCode-<版本>.txt` 上传到同一个 GitHub 发布 `v<版本>`。插件版本就是 StudyHub 的版本。

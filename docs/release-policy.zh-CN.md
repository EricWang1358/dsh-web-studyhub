# 发布规则与两条通道

[English](release-policy.md) · 简体中文

维护者的电脑上用两个 DSH 配置来使用 StudyHub，它们故意跟随不同的版本。

| 通道 | DSH 配置 | 运行的是 | 什么时候更新 |
| --- | --- | --- | --- |
| **稳定** | desktop（客户端） | 发布的 `.tgz`（在 StudyHub **设置 › 关于与更新** 里一键升级） | 发布新版本时 |
| **体验** | web（网页端） | 跟随 `main` 的检出（`link:` 指向一个工作树） | `main` 有更新、并运行 `node scripts/sync-main.mjs` 时 |

一个改动合并后，马上就能在体验通道里测；要到稳定通道，只能通过发布。

## 搭建体验通道（一次）

1. 建一个只跟随 `main` 的工作树。不要用你平时开发的那个检出；`sync-main` 会拒绝有未提交改动的检出。

   ```sh
   git worktree add --detach <目录> origin/main
   cd <目录>
   npm ci --legacy-peer-deps
   node scripts/build.mjs
   ```

2. 在网页端配置（`~/.dsh/profiles/web/package.json`）里，把插件指向这个工作树：`"@ericwang1358/dsh-daily-flashcard": "link:<目录>"`，并把配置的 `node_modules/@ericwang1358/` 下的链接指向同一处。重启 DSH 网页端。
3. 每当 `main` 有更新：在 `<目录>` 里运行 `npm run sync:main`，然后重新加载插件或重启 DSH 网页端。它会拉取、移到最新的 `main`、只在依赖变了时重装、构建，并打印现在是哪个版本和提交。

`lib/client.js` 和 `dist/` 是构建产物。切换了分支却没有构建，运行的就是旧的前端代码。

## 什么时候发布

发布是给用稳定通道的人的，不是每合并一个 PR 就做一次存档。

- **攒着发。** 修复和功能做好就合并到 `main`；有一批值得安装的内容时再发，小版本最多一周一次。
- **热修。** 只用于已发布版本里妨碍使用或会丢数据的问题，且修复小、测过。热修是上一个版本的补丁版。
- **不构成发布理由的：** 合并了一个 PR、一次 CI 跑完了、演示想要某个改动。

## 两次发布之间的更新日志

PR 不直接改 `CHANGELOG.md` 和 `CHANGELOG.zh-CN.md`，而是在 `changes/unreleased/` 下每种语言加一条（`<名字>.en.md` 和 `<名字>.zh-CN.md`，写法见 [changes/README.md](../changes/README.md)）。这样 PR 之间不会改到同一行，合并一个不会让其他的冲突。`npm run changelog:check` 检查这些片段；片段格式不对、更新日志最上面一节不是 `package.json` 里已发布的版本，或者更新日志和发版时记下的校验值（`changes/released.json`）对不上（在发版之外被改过）时，`tests/changelog-fragments.test.mjs` 会失败。

## 发布之前

下面全部做到，按顺序。做不到的一项，要在发布说明里写成「未验证」。

1. `main` 在体验通道上至少经过一整天的真实使用，发现的问题已修复或已列出。
2. `main` 的 CI 全绿（ubuntu 和 windows 分片 `verify`），并且要发布的那个提交上本地 `npm run verify:fast`（`lint`、`typecheck`、基于核心护栏 + 变更依赖图的 `test:smart` 以及 `build`）通过；全量历史套件 `npm run test:fast` 或 `npm test` 仅在排查额外跨模块缺陷或改动底层存储/调度器时按需选跑。
3. 更新日志（英文和简体中文）写的是用户能感知到的变化，也写明哪些还没修。用 `npm run changelog:preview -- <版本>`（中文加 `--lang=zh-CN`）看这次要加的内容，措辞在片段里改。发布提交把 `package.json` 改成新版本，并运行 `npm run changelog:release -- <版本> <YYYY-MM-DD>`：它把 `## <版本> — <日期>` 和所有片段（按加入的先后）写进两份更新日志，再删掉片段，并给两份更新日志记下校验值。升级说明、已知问题写成 note 片段（`<名字>.note.en.md`、`<名字>.note.zh-CN.md`），或在同一个提交里直接写进那一节，再运行 `npm run changelog:seal`。
4. 在体验通道上，用真实资料库和真实模型做真实环境检查。勾选与这次改动相关的项：
   - [ ] 一次出题、一次补题、一份草稿发布；「资料」页的行和阅读器里的数字一致。
   - [ ] 一次录音导入（多个文件），中途重启，任务仍在控制台里，归档的任务仍可查看。
   - [ ] 「看原页」里的一页扫描书，以及长书里的脚注和公式。
   - [ ] 改动涉及的模型路径：正在用的模型的推理档位，「实时输出」里已结束的调用。
   - [ ] 任务控制台在窄窗口和宽窗口、浅色和深色下的样子。
5. 在停在 `origin/main` 的工作树里构建和打包（`node scripts/build.mjs`、`npm run release:pack`），把资源清单和上一个版本对比（11 个插件资源；桌面版流程补上 8 个后共 19 个），用更新日志对应的一节作为发布说明（`npm run -s changelog:preview -- <版本>` 会打印出来），并确认远端的 `SHA256SUMS` 和主包的哈希与本地一致。
   推送 `v<版本>` 标签会同时启动 `release.yml`（11 个插件资源，几分钟）和 `release-desktop.yml`（8 个桌面版资源：`Setup.exe` 及其 `.sig`、`.msi`、`.zip`、桌面检索 `.zip`、两份 `SHA256SUMS-Desktop-*` 和更新清单 `latest.json`，约 20 分钟）。两个流程都把发布页建成或补成**草稿**，然后运行 `node scripts/release-publish.mjs --tag v<版本>`：19 个资源全部到齐才发布并标为 latest，后完成的那个流程负责发布。草稿不是 GitHub 的「latest」发布，所以桌面安装包和 `latest.json` 上传之前，任何 StudyHub 都不会提示这个版本（5.4.2 提早约 20 分钟提示了桌面版升级，一键更新因为缺 `latest.json` 失败）。某个流程失败时，发布页停在草稿：重跑它（`release-desktop.yml` 用 `workflow_dispatch`，填标签并打开 `publish_release`），或者手动补传缺的资源后自己运行 `node scripts/release-publish.mjs --tag v<版本>`；还缺资源时它会拒绝发布。只有确实要不带桌面版资源发布时才用 `gh release edit v<版本> --draft=false --latest`，并在发布说明里写明：在 `latest.json` 补上之前，桌面版一键更新会失败。
6. 三个名字和会落后的渠道：查一下 `npm view @ericwang1358/dsh-daily-flashcard version`。这条发布流程只发布 GitHub 发布页，npm 要手动更新，所以 npm 的 `latest` 还停在上一个版本是正常的，不算发布失败；安装说明和两份 README 都以发布页为准。如果这次顺手也更新了 npm，在发布说明里写一句。

## 发布之后

- 在客户端配置里用一键升级，重启 DSH，看这次发布涉及的每个页面的第一屏。
- 关闭这次发布包含的 PR，评论里指向这次发布。

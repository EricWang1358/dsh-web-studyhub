# Changelog fragments

English · [简体中文](#简体中文)

A pull request does not edit `CHANGELOG.md` or `CHANGELOG.zh-CN.md`. It adds its own files under `changes/unreleased/`, and the release writes them into both changelogs. Two pull requests never touch the same lines, so merging one does not make the others conflict. A test fails if the top section of a changelog is not a released version.

## One change, two files

```
changes/unreleased/install-pause.en.md
changes/unreleased/install-pause.zh-CN.md
```

The name is a short slug (a-z, 0-9 and `-`) that says what changed. Each file holds one bullet:

```md
- **Pausing an install stops it before the next step.** What a learner notices, in plain words. Not verified: what you could not check.
```

- Start with `- **` and a bold first sentence that says what changed for a learner.
- Then what they notice: what they see, click or no longer run into. Not how the code does it.
- Say honestly what was not checked: `Not verified: ...` in English, `未验证：...` in Chinese.
- Plain words. The Chinese text uses the words of the interface, not internal API, file or function names.
- One bullet. Sub-bullets are allowed (indent them: `  - ...`); blank lines and headings are not.

## Notes after the bullets

For a paragraph that belongs after the list (an upgrade step, a known issue, what a set of changes did not verify), add a note pair:

```
changes/unreleased/<slug>.note.en.md      Upgrading: ...
changes/unreleased/<slug>.note.zh-CN.md   升级：...
```

A note is a paragraph, not a bullet.

## Commands

```sh
npm run changelog:check                      # every fragment is well formed, in both languages
npm run changelog:preview -- 3.6.0           # the section the release will add (add --lang=zh-CN for Chinese)
npm run changelog:release -- 3.6.0 2026-10-23  # the release commit only: writes both changelogs, deletes the fragments
```

Changes are listed in the order they were added (the commit that added each fragment); changes added in the same commit by name.

## 简体中文

拉取请求不直接改 `CHANGELOG.md` 和 `CHANGELOG.zh-CN.md`，而是在 `changes/unreleased/` 下加自己的两份文件，发版时再一起写进两份更新日志。这样两个拉取请求不会改到同一行，合并一个不会让其他的冲突。更新日志最上面一节不是已发布的版本时，测试会失败。

- 一项改动两份文件：`<名字>.en.md` 和 `<名字>.zh-CN.md`，名字只用小写字母、数字和 `-`。
- 每份文件一条，以 `- **` 开头，先用一句加粗的话说清改了什么，再写学习者能注意到的变化。
- 老实写没验证的部分：英文写 `Not verified: ...`，中文写 `未验证：...`。
- 用平常的话。中文用界面上的叫法，不写内部 API、文件名或函数名。
- 升级说明、已知问题这类放在列表后面的段落，写成 `<名字>.note.en.md` 和 `<名字>.note.zh-CN.md`。
- `npm run changelog:check` 检查格式；`npm run changelog:preview -- 3.6.0` 预览要加的一节。

# 公式、图片与计算工具 / Science settings

在「设置 › 常用 › 公式、图片与计算工具」调整公式大小（75%–200%）、块公式对齐、图片最大高度、图片说明和题卡图片放大。修改立即生效，保存在当前浏览器，独立于阅读字号；可以一键恢复默认。

本地图片插入、化学配平和代数恒等式证明各有独立开关。关闭入口不会删除已有内容。

- **本地图片**：题目草稿的问题、答案、讲解和笔记编辑器提供插入按钮。支持 PNG、JPEG、WebP、GIF，每张最多 2 MiB。图片嵌入 Markdown，随学习库和备份保存，重新打开不依赖原始路径。笔记保留 20 万字符文字额度，总 Markdown 上限为 3 MiB。
- **化学自动配平**：在此设置页输入中性分子反应，自动求最简正整数系数。支持括号下标及物态，只证明元素守恒；离子、半反应、多解或超出资源限制的输入明确显示无法可靠配平。不会自动改写题目或证明反应能发生。
- **代数恒等式证明**：输入两侧表达式，用精确分数展开比较多项式，并显示规范形式、步骤和适用条件。支持有限整数幂及常数除法；变量分母、函数、一般定理不在此证明器范围内。不同多项式可能在个别取值相等，但不是恒等式。

配平和证明不调用模型。图片用于本地展示；当前文字模型不会自动识图，直连和后台助教发送文本时会省略嵌入图片字节，保留周围文字。模型辅助学习不应被当作这些本地工具已经验证的结论。

In **Settings › Formulas, images and calculation tools**, customize formula scale/alignment, image height/captions and card image enlargement. Choices apply immediately, persist per browser, and can be reset independently of reading preferences.

Local-image insertion, exact chemical balancing and algebraic identity proofs have separate switches. Supported editors embed bounded raster Markdown in the library; note prose remains limited to 200,000 characters and total Markdown to 3 MiB. Text-only model calls omit embedded image bytes and do not infer image contents.

The local tools have bounded grammars. Chemical balancing checks neutral-species element conservation, not feasibility or ionic/redox chemistry. The identity prover compares exact polynomial expansions under explicit assumptions, not arbitrary mathematical theorems. Unsupported or oversized input remains unchecked.

See [local images](local-study-images.md), [chemical balancing](chemistry-balance.md), and [symbolic proofs](symbolic-proof.md) for syntax and limits.

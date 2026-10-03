# Images math and chemistry in study cards

Study cards render Markdown images and LaTeX in questions, answers, choices, hints and explanations. A formula displays locally; it does not prove that the answer or chemical reaction is correct.

## Write a formula

Use `$x_i^2$` or `\(x_i^2\)` within a sentence. Use `$$...$$` or `\[...\]` for a formula on its own line. Display formulas may span several lines, including an `aligned` environment.

```text
Find $x$ when $2 x + 1 = 5$.

\[
\frac{x_i^2}{\sqrt{2}}
\]
```

Code spans and fenced code blocks keep their literal text. Ordinary prices such as `$5 and $10` remain text. For expressions that resemble a price, use `\(...\)` to avoid an ambiguous dollar delimiter. Invalid or unsupported LaTeX stays visible as its original text.

## Write a chemical equation

Put `\ce{...}` inside math delimiters. Coefficients, subscripts, charges, states of matter and reaction arrows use the locally installed mhchem notation. `\pu{...}` formats physical units. The note preview supports these chemistry commands too; its existing math delimiters are `$...$` and `$$...$$`.

```text
$\ce{2H2(g) + O2(g) -> 2H2O(l)}$
$\ce{Fe^{3+} + SCN- <=> FeSCN^{2+}}$
$\pu{1.5 mol L-1}$
```

Rendering does not balance reactions, check charge conservation or validate stoichiometry. Compare those facts with the source material.

## Include an image

Use an absolute HTTP or HTTPS image URL and a useful description:

```text
![Reaction energy diagram](https://example.org/reaction-energy.png)
```

Images fit the available card width. On a flashcard, activate an image to enlarge it; press Escape or Close to return. This does not flip the card, and keyboard focus returns to the image control. Images inside answer choices display without an extra control so selecting a choice still has one clear action. An unavailable image shows its description and an unavailable message.

The browser retrieves web images from their URL. Choose an image you can access and share with the intended learners. Filesystem paths, relative paths, `file:`, `data:` and script URLs are not supported: cards do not currently have a trusted local image attachment base.

Math and chemistry use bundled MathML rendering, with no CDN or font download. Image loading remains subject to the URL host's availability and the browser's network rules.

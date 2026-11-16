# Science settings: formulas, images and calculation tools

[中文](science-settings.zh-CN.md)

In **Settings › Formulas, images and calculation tools**, adjust formula scale (75%–200%), display-formula alignment, maximum image height, image captions and card-image enlargement. Changes take effect immediately, stay saved per browser independently of your reading font size, and can be reset to defaults in one click.

Local image insertion, automatic chemical balancing and algebraic identity proving each have their own switch. Turning a tool off hides its entry without deleting content you already saved.

- **Local images:** Question drafts (stems, answers, explanations) and note editors provide an insert button supporting PNG, JPEG, WebP and GIF up to 2 MiB per image. Images are embedded in Markdown, travel with your library and backups, and reopen without depending on the original file path. Notes retain a 200,000-character prose quota within a 3 MiB total Markdown limit.
- **Automatic chemical balancing:** Enter a neutral molecular reaction on this settings page to solve for the lowest positive integer coefficients. Parenthesised subscripts and state symbols are supported, checking element conservation only; ions, half-reactions, underdetermined systems or inputs beyond resource bounds report explicitly that they cannot be balanced reliably. It never rewrites questions automatically or proves thermodynamic feasibility.
- **Algebraic identity prover:** Enter expressions on both sides to compare exact rational polynomial expansions, displaying canonical forms, steps and explicit domain assumptions. Finite integer powers and constant denominators are supported; variable denominators, transcendental functions and general mathematical theorems are outside its scope. Distinct polynomials may coincide at isolated values without being an identity.

Chemical balancing and identity proving make zero model calls. Embedded images are for local display only; text-only model calls (both direct and background tutor requests) omit embedded image bytes while preserving surrounding text, and do not infer image contents. Model-assisted explanations should never be treated as conclusions verified by these deterministic local tools.

See [local images](local-study-images.md), [chemical balancing](chemistry-balance.md) and [symbolic proofs](symbolic-proof.md) for syntax and limits.

# Exact symbolic polynomial identities

`lib/symbolic-proof.js` exports a synchronous, browser-safe `proveIdentity(left, right)` function. It uses only JavaScript and BigInt, with no provider call, dependency, `eval`, filesystem access, or numerical sampling.

```js
proveIdentity('(x+1)^2', 'x^2+2x+1');
// { status: 'proved', left: 'x^2 + 2*x + 1',
//   right: 'x^2 + 2*x + 1', steps: [...], assumptions: [...] }

proveIdentity('(x+1)^2', 'x^2+1').status; // 'disproved'
proveIdentity('x/x', '1').status;        // 'not_checked'
```

Results contain JSON-safe strings and arrays. `left` and `right` are canonical polynomial strings, not the original input. `steps` explain exact rational conversion, expansion, collection of like monomials, and comparison. `assumptions` explain the variable and coefficient interpretation, including any domain condition. For an unchecked expression the function returns only `status: 'not_checked'` and a reason, without a claimed proof.

`proved` means the two canonical polynomials have exactly matching coefficients under the returned assumptions. `disproved` means they are not a polynomial identity; it does **not** mean they differ at every possible value. This engine does not prove arbitrary mathematics, calculus, transcendental identities, chemical statements, or a model's reasoning.

## Supported syntax

- Integers and finite decimals, including `.25`, `1.`, `0.1`, and scientific decimal notation such as `1e-3`. Coefficients are exact reduced rational numbers, so `0.1+0.2=0.3` is exact. Measurement precision and rounding are outside this contract.
- Case-sensitive variables matching `[A-Za-z][A-Za-z0-9_]*`. Names such as `mass`, `rate`, `x2`, and `xy` each denote one independent commuting real variable. `xy` is different from `x*y`. Names such as `pi` or `e` are variables, not built-in mathematical constants.
- `+`, `-`, `*`, `/`, parentheses, and `^` with a constant integer exponent between -8 and 8. Variable expressions may use nonnegative powers. Negative powers are supported only for nonzero constant bases. Powers associate to the right, and bind more tightly than unary minus: `-x^2` means `-(x^2)`, while `(-x)^2` squares the signed base.
- Division only by an expression that reduces to a nonzero constant polynomial. For example, `x/3`, `x/(y-y+2)`, and `2^-3` are exact. Variable-dependent denominators such as `x/x` or `1/(x+1)` are explicitly unchecked; the engine does not cancel them or infer denominator assumptions.
- Implicit multiplication such as `2x`, `2(x+1)`, `x(y+1)`, and `(x+1)(y+1)`. Use explicit `*` for a multi-letter variable before parentheses: `mass*(x+1)`. `mass(x+1)`, `sin(x)`, and `sqrt(x)` are unchecked function-like syntax. A single-letter name before parentheses means multiplication, not a function. Adjacent numeric literals require an explicit `*`.

Literal `0^0`, a polynomial that reduces to zero raised to zero, and all division by zero are unchecked. For a nonconstant zero power such as `(x+1)^0`, the result records `(x + 1) != 0`; this condition survives outer cancellation or multiplication by zero. Parsing evaluates all operands, so `0*(1/0)` cannot become a proof of zero. Malformed expressions, unsupported symbols, non-string input, and nonfinite numeric names are unchecked.

## Bounded computation

Limits are deliberately conservative; an expression can be mathematically valid and still be unchecked. There is no approximate fallback. Each side has at most 4,096 characters, 256 tokens, 32 nested parentheses/unary signs/power operands, 32 characters per variable name, and 64 mantissa digits per numeric literal. Scientific exponents range from -24 to 24. Across both sides there are at most 16 distinct variables and 20,000 counted arithmetic/collection/GCD operations. Each intermediate polynomial has total degree at most 16 and at most 128 terms. Exact rational numerator and denominator intermediates are capped at 1,024 bits; a large intermediate can be rejected even when later reduction would make it smaller. Powers are capped at absolute exponent 8.

The output orders terms by descending total degree, then by a deterministic variable/exponent key. Constant and zero polynomials normalize to a rational string or `0`. No BigInt escapes through the public result.

Run focused verification with the repository's isolated wrapper:

```sh
npm test -- tests/symbolic-proof.test.mjs
```

Coverage includes positive and negative identities, exact decimals and scientific notation, multi-letter variables, precedence, explicit domain conditions, malformed and undefined operands, and bounded adversarial expansions.

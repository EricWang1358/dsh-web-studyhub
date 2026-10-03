# Bounded calculation checks

Answer preparation can include optional structured calculation evidence. StudyHub
recomputes that evidence locally before authoring, alongside its existing shape
and source checks. A supported mismatch receives the existing single answer
correction round. If it still fails, the target is omitted (when other targets
remain) or preparation fails. A correction cannot erase a known mismatch by
removing the evidence or replacing it with unsupported syntax.

The independent reviewer receives a freshly computed `calculationChecks` entry
per blueprint target:

| Status | Meaning |
| --- | --- |
| `agreement` | Supported arithmetic, supplied steps, dimensions and the actual numeric answer agree within the numerical policy. |
| `mismatch` | A supported numerical or dimensional contradiction was found. |
| `not_checked` | Evidence is absent, malformed, outside the grammar, or otherwise unsupported. It is **not** mathematical approval. |

Arithmetic agreement does not establish that a formula answers the question, that
its variables match the scenario, or that its interpretation follows from the
source. An invented but self-consistent formula can agree arithmetically. Exact
target/answer/source binding and independent semantic review remain required.
The checker does not read a model-provided success flag or tolerance. It does
not call a model, execute JavaScript, or start an interpreter.

## Evidence format

This is a **constructed** constant-speed example. Its course source must support
the distance rule, and its stem must supply the hypothetical speed and duration.

```json
{
  "targetId": "target-1",
  "answer": "12 m",
  "calculation": {
    "variables": {
      "speed": { "value": 3, "unit": "m/s" },
      "time": { "value": 4, "unit": "s" }
    },
    "steps": [
      { "name": "distance", "expression": "speed*time", "value": 12, "unit": "m" }
    ],
    "expression": "distance",
    "result": { "value": 12, "unit": "m" }
  }
}
```

`calculation` is optional blueprint metadata, not a new card kind. `variables`
and `steps` can be omitted. Each step introduces a unique variable and can use
original variables and previous steps. Every supplied step claim is checked;
later expressions use the computed unrounded value, never the claimed value.
The final result is also checked against the blueprint's actual answer and every
correct option when present. Answers/options must be standalone numbers with
optional supported units, such as `12 m`, `0.5`, or `2e3 kg`. Prose answers,
cloze sentences and multiple distinct numerical answers fall outside this
bounded subset.

## Grammar, units and numerical policy

Expressions accept decimal and scientific literals, ASCII variable names,
`+`, `-`, `*`, `/`, `^`, unary signs and parentheses. Multiplication/division
precede addition/subtraction; powers associate right and precede unary signs:
`-2^2 = -4`, `2^-2 = 0.25`, `2^3^2 = 512`. Exponents must be dimensionless
integers in `[-12, 12]`. There are no functions, implicit multiplication,
properties, arrays, strings, assignments or executable statements.

Supported units are `m`, `cm`, `mm`, `km`, `kg`, `g`, `s`, `min`, `h`, `%`
and unit products/quotients with integer powers, such as `kg*m/s^2`. Empty unit
or `1` means dimensionless. Products/quotients associate left; parentheses in
unit strings are unsupported. Quantities normalize to metre/kilogram/second
dimensions and scales, allowing e.g. `36 km/h * 2 min = 1.2 km`. Addition
and subtraction require matching dimensions; the result must match the stated
unit's dimensions. Unknown units are unverified, even if their labels match.

Comparisons use a fixed absolute tolerance of `1e-12` plus a relative tolerance
of `1e-9`, measured after normalization to SI scales. A generated composite unit
cannot enlarge the absolute tolerance. Optional `decimalPlaces`
must be an integer from 0 through 10; it rounds only the final result in each
stated result/answer unit, with midpoint ties away from zero. Steps must remain
unrounded. Decimal rounding is unsupported when the scaled magnitude exceeds
`Number.MAX_SAFE_INTEGER`. This uses floating-point arithmetic, not arbitrary
precision, interval arithmetic or symbolic proof.

Limits: 512 expression characters, 128 tokens, nesting depth 32, 32 input
variables, 16 sequential steps, 32-character ASCII names, 64 unit characters,
16 unit factors, unit powers `[-8, 8]`, combined dimension exponents
`[-16, 16]`. Every numerical input/intermediate/scale must be finite, with
nonzero magnitude between `1e-100` and `1e100`. Division by zero, undefined
zero powers, complex/fractional powers, overflow, nonzero-base power underflow
to zero, and exhausted budgets are
`not_checked`. Chemistry equation balance, reaction validity, symbolic
identities, proofs and subject-matter correctness are unsupported.

## Compatibility and privacy

Legacy and nonnumeric blueprints need no new fields and cause no additional
model call. Unsupported evidence goes to the usual independent correctness
review. The existing private editorial evidence workflow retains the supplied
blueprint metadata; computed diagnostics are transient reviewer input, not a
stored mathematical approval badge. Learner card projections continue to
withhold answers, explanations, citations and calculation evidence until reveal.
No provider routing, quote matching, snapshots or learner UI are changed.

Verification uses deterministic fake-model generation, temporary service data
and the isolated `npm test` runner. Parser tests cover dimensional conversion,
answer linkage, steps, rounding, precedence, malicious syntax and resource
limits. Integration tests cover bounded correction, evidence-removal evasion,
legacy/unsupported compatibility, semantic rejection despite arithmetic
agreement, source binding, and answer privacy.

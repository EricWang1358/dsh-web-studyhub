# Exact bounded chemistry balancing

`balanceEquation(input)` balances **atom counts** for the listed neutral ASCII
formulas. It uses exact rational row reduction and accepts a result only when
there is one unique coefficient ratio and every coefficient is positive. The
returned integers are reduced to their smallest common ratio.

```js
balanceEquation('H2 + O2 -> H2O')
// {
//   status: 'balanced',
//   equation: '2 H2 + O2 -> 2 H2O',
//   coefficients: [2, 1, 2],
//   conservation: [
//     { element: 'H', reactants: 4, products: 4 },
//     { element: 'O', reactants: 2, products: 2 }
//   ],
//   reason: 'Atom counts conserved ... feasibility and charge/redox chemistry were not checked'
// }
```

Coefficients follow the original species order: reactants first, then products.
Conservation rows contain exact integer totals in the returned equation. No
`BigInt` value escapes the API; results are JSON-serializable.

| Status | Meaning |
| --- | --- |
| `balanced` | A unique, minimal, positive integer atom-conserving equation was produced. This describes the returned equation, even if the input coefficients were wrong. |
| `not_balanced` | Exact supported constraints prove that no nonzero all-positive balance exists for the listed species as written. |
| `not_checked` | Syntax is unsupported, the coefficient ratio is ambiguous, or a resource limit was reached. No approximate balance is offered. |

`balanced` does **not** establish that the compounds exist, that the reaction
occurs, that it is thermodynamically feasible, or that charge and redox rules are
satisfied. Source grounding and subject-matter review remain necessary. This is
not an ionic/redox equation solver or a general chemical correctness proof.

## Input grammar

Use one `->` arrow, with one or more formulas on each side separated by `+`.
Formulas contain case-sensitive current element symbols, positive integer
subscripts and nested parentheses, such as `Al2(SO4)3`. Optional `(s)`, `(l)`,
`(g)` and `(aq)` suffixes are retained. Whitespace can surround terms/arrows;
whitespace inside a formula is unsupported.

A single outer mhchem wrapper is accepted:

```text
\ce{Mg(OH)2(s) + HCl(aq) -> MgCl2(aq) + H2O(l)}
```

Positive leading integer coefficients may be supplied with or without a space;
the solver recomputes and minimizes them. Leading digits are coefficients,
never isotope mass numbers. It preserves species rather than
adding, removing or merging terms. Duplicate or spectator species that leave
multiple independent coefficient ratios are conservatively `not_checked`.
For example, `C + O2 -> CO + CO2` has ambiguous atom-conserving ratios, so the
engine does not choose one by sampling or guessing.

Charges, electrons, isotope labels, hydrate dots, square-bracket complexes,
symbolic/fractional coefficients, nested mhchem braces, TeX commands and other
arrow forms are unsupported. `+` always separates neutral species; the engine
never infers an ionic charge from it. No input is evaluated or executed.

## Resource policy

Limits are fixed in the engine: 512 input characters; 12 total species; 16
distinct elements; 128 characters per formula; 128 element/group tokens across
the equation; parenthesis depth 8; subscripts at most 1000; at most 1,000,000
atoms of any element per species; entered and final minimal coefficients at
most 10000. Integers must be positive and have no leading zeroes.

Exact arithmetic uses at most 128 bits per integer intermediate and 20,000
rational/GCD operations. Every numerator, denominator and integer product is
bounded. A calculation can exceed this budget even if a less costly method
would find a balance; it then remains `not_checked`. Atom totals fit safely in
the returned JavaScript numbers under these bounds.

The module is browser-safe, uses no dependency, Node API, DOM, model, network,
JavaScript evaluation or interpreter. Unit tests use the isolated `npm test`
runner with deterministic inputs and no learner library or provider keys.

# Maintaining the taxonomy

The taxonomy is `docs/agent-lessons/taxonomy.md`. It is built by iterative coding: start from the seed classes, read a batch, revise, read the next. Only the main session edits it.

## Entry shape

```
## C07 <condition, as a short title>
- Layer: concept | logic | process · Moment: design | implement | verify | declare-done | release | communicate | delegate
- Condition: one or two sentences, no feature or file names.
- Catch: one yes/no question asked at that moment.
- Not this class: the nearest neighbour class and what tells them apart.
- Pairs: #a ↔ #b (one line each: why they look different, why it is the same mistake)
- Evidence: n cards, m surfaces, friction f (from cards.mjs stats)
- Home: check:<name> | hook:<name> | rule | record:<file> | skill:<name> | none
- Status: seed | candidate | recurring | costly | placed | retired
```

## Revising after each batch

Apply these tests in order, using `cards.mjs stats`:

1. **New class.** Two or more "new" cards share one condition and one catch question: create the class (status `candidate`). A single "new" card stays pending until a second appears.
2. **Merge.** Two classes would be stopped by the same catch question: merge them, keep the clearer condition, and move all evidence.
3. **Split.** The catch question of a class would not have stopped one of its members: move that card to another class, or split the class into two conditions with their own questions.
4. **Wording level.** The condition names a feature, page, file or provider: raise it. The catch question cannot be answered yes or no at the moment it names ("be careful", "test more"): make it concrete.
5. **Status.** A class becomes `recurring` at three or more cards across two or more surfaces (the cards' `area` values, or changed directories when a card has none), or `costly` after one item that was reverted, reopened, followed by a fix, or carries a `costly_reason`. `cards.mjs stats` computes both marks. The follow-up-fix signal is loose (any fix PR that mentions an earlier merged PR), so read the refs before trusting a `costly` mark on its own. Only `recurring` and `costly` classes get a home.
6. **Singleton proposals.** Card writers tend to propose one class per item. Treat their `proposed_class` as a hint: group the "new" cards by the question that would have caught them, and widen an existing class when its catch question also covers the card.
7. **Pairs.** Keep the two to four pairs that look most different. Pairs teach a model to recognise the class on a new surface; more of them add tokens without adding recognition.

## When to stop calibrating

Run batches of 50. Calibration is done when a batch creates at most two new classes and causes no merge or split. Show the owner the taxonomy after the first batch and again at that point, before any skill is written from it.

## Retiring

When a check, a hook or a consolidation makes the mistake impossible or always caught, set the status to `retired`, name what covers it under Home, and remove its question from any skill. Keep the entry, so that a later card in the same class shows the cover has a gap.

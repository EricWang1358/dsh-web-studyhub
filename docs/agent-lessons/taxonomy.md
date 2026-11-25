# Agent lessons: general-mistake taxonomy

Classes of mistakes that recur in this repo on different surfaces. Each class is a condition, a catch question asked at the moment the mistake is made, and evidence from PRs and issues. The `skill-forge` skill (`.claude/skills/skill-forge/`) maintains this file; read its `references/taxonomy-rules.md` before editing.

Status: `seed` came from owner feedback before mining and has no mined card yet; `candidate` has mined cards but is not yet recurring; `recurring` and `costly` follow the rules in `taxonomy-rules.md`. Evidence counts come from `cards.mjs stats`; a surface is a feature area.

Revision 1 (2026-11-25), after calibration batch 1: C02, C03, C06, C08, C09, C12 and C14 widened; C05 merged into C02; C16–C20 added. Revision 2, after review of b02: C13, C16, C17 and C19 widened; C21 and C22 added. Revision 3, after review of b03: C02 narrowed to components and mechanisms; C24 (facts and lists) split off; C23 (accessibility semantics) added. Revision 4, after review of b04: C25 (shared primitive shaped for one case) and C26 (replaced code left behind) split from C02. Revision 5, after reviews of b05 and b06: C17 widened to hand-offs that drop the target; C27 (late-arriving content), C28 (serialised independent work), C29 (quality gate without severity) and C30 (group information repeated per row) added. Revision 6, after review of b07: C31–C37 added (parity, leftover state, stop that did not stop, work outside the task surface, duplicate after restart, test timing, name lists); C19 narrowed. Revision 7, after review of b08: C21 widened to family members keyed by the family's common shape; C32 widened to resumes that trust their own record; C38 (format across a release boundary) and C39 (setting read at the wrong moment) added. Revision 8, after review of b09: C40 (control or warning shown without checking its condition) split from C17; C08 wording covers blocks. Revision 9, after review of b10: C18 widened to writes over input the user already filled; C36 widened to machine state; C41 (work counted as delivered without checking the shipping branch) and C42 (same item handed to parallel workers with no claim) added. Revision 10, after review of b11: C03 widened to code adopted from outside; C12 widened to call order that defeats provider reuse; C43 (failure kinds not told apart) added. Revision 11, after review of b12: C44 (bytes or work paid on the common path) and C45 (view checked only with data present) added. Revision 12, after review of b13: C46 (status taken from a signal that over-fires) split from C19; C23 widened to lists with no keyboard model. Revision 13, after review of b14: C47 (placement and weight follow build order, not the user's look and decision order) added; C26 widened to functions whose only users were removed. Revision 14, after review of b15: C29 widened to precondition checks that refuse an action; C38 widened to a stored key whose meaning changed; C26 widened to unreferenced definitions. Revision 15, after review of b16: C04 widened to checks outside CI; C12 widened to uncapped paid work; C41 widened to publishing channels; C46 widened to absent evidence; C48 (external resource unpinned, unbounded) added. Revision 16, after review of b17: C49 (proposal scoped to the ideal end state without weighing upkeep) added. Revision 17, after review of b18: C50 (decision ignored the system's own recorded signals) and C51 (change to stored work with no way back) added. Revision 18, after review of b19: C47 widened to default sequences; C46 and C50 separated; C49 covers reports closed as already covered. Revision 19, after review of b20: C52 (faithful original form unsupported or buried) added; C36 widened to cleanup only on the passing path; C44 widened to every release package. Revision 20, after review of b21: C53 (a step taken mid-job replaced or closed the view the user worked from) split from C17. Revision 21, after review of b22: C54 (parts of one unit set independently) added; C27 widened to worst-case reserved slots; C36 widened to held requests; C03 widened to input method; C44 widened to prompt text per turn. Revision 22, after review of b23: C54 widened to rows of one list that each decide how much to show. Revision 23, after review of b24: C55 (feature acts on the stored unit, not the user's unit) added; C35 widened to repeated requests. Revision 24, after review of b25: C56 (composite action fired single-item side effects per step) added; C53 widened to a selection switched by the step and not restored. Revision 25, after the C17 and new-card sweep: C57 (renderer lacks a rule for a form the producer emits) and C58 (identifier does not name the unit) added.

## C01 A fix reached one path, not every path that carries the same thing
- Layer: process · Moment: declare-done
- Condition: a change to how some content or action behaves was made on the path in the report, while sibling paths (other formats, other entry points, other callers of the same action) kept the old behaviour or got a separate copy of the fix.
- Catch: Which other paths carry this content or perform this action, and does each one now go through the one unit I changed?
- Not this class: C02 is how the second path came to exist; C01 is forgetting it when changing behaviour.
- Pairs: #62 (formula display fixed for text sources only) ↔ #341 (crash-safe publish added to the publish job but not to the supplement run's own publish)
- Evidence: 28 cards over 10 surfaces (cards.mjs stats at revision 25); first refs #13 #62 #209 #229 #231
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring, costly

## C02 A component or mechanism was rebuilt, copied or overridden per caller
- Layer: concept · Moment: design
- Condition: a component, pipeline, mechanism or shared resource that already had a usable owner, or that several callers each need, was rebuilt, copied or overridden per caller because the owner was not found or not used; the copies drifted apart.
- Catch: Does something in the repo already own this, and am I going through it? If it does not fit my context, can I widen it instead of copying it?
- Not this class: C25 (the owner itself was shaped, scoped or placed for one case, so callers could not use it); C24 (a fact, list or decision restated, no component involved); C26 (an old owner left behind after replacement); C14 (code piled into one place); C16 (a rule with no check at all).
- Pairs: #68 (ten hand-written confirmation footers) ↔ #75 (overlays built their own dialog because the shared one did not work in their container); #288 (a new gateway skipped the preparation the existing model path applies) ↔ #353 (two modules wrapped one lock with their own retry budgets)
- Evidence: 81 cards over 15 surfaces (cards.mjs stats at revision 25); first refs #44 #68 #69 #70 #72
- Home: question in `.claude/skills/place-shared-code`
- Status: recurring, costly

## C03 Judged from a stand-in instead of the real environment or input
- Layer: process · Moment: verify
- Condition: behaviour was accepted from a stand-in (default settings, one language, width or input method, a fake model, synthetic or tidy input, a dependency's name or docs) while users run other settings and feed varied real input; or code received from outside (a fork, a port, a generated patch) was adopted on the strength of its source or its own tests, without running its behaviours on real input.
- Catch: Which real environments and inputs will this meet (language, width, theme, host, input method, real files, real model, real dependency version), and have I observed it on a sample of each?
- Not this class: C04 (the right checks exist but did not run); C20 (the change itself breaks a property).
- Pairs: #1118 (a button sized for the Chinese label overflowed in English) ↔ #753 (chapter detection built for the numbering already seen split a real book into wrong chapters); #875 (a transcription option trusted from its name) ↔ #255 (a library assumed not to mutate its input)
- Evidence: 91 cards over 15 surfaces (cards.mjs stats at revision 25); first refs #17 #19 #20 #21 #29
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring, costly

## C04 The checks that ran were narrower than the change's reach
- Layer: process · Moment: verify
- Condition: the selected tests or the PR's CI did not include checks that scan the whole tree or the merged result (guard tests, slow tests, size ceilings, browser tests), so a change passed locally or per PR and failed on main. Also: manual QA walks or journey scripts that live outside CI were repointed after a UI change and declared fixed without being run once (#682 #694 #785 #787).
- Catch: Which checks read the whole tree or the merged result, did they run on what will actually land, and for checks that live outside CI, did I run each one once after the change?
- Not this class: C03 (wrong environment); C16 (no check exists).
- Pairs: #1251 (smart selection skipped whole-tree guards) ↔ #1355 (three green PRs together exceeded the first-load ceiling)
- Evidence: 23 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #329 #373 #391 #411 #633
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring, costly

## C05 (merged into C02)
- Status: merged. "One fact shown from several sources or in several wordings" now lives in C24.

## C06 What the user or caller is told is untrue or missing
- Layer: concept · Moment: communicate
- Condition: a displayed cause, state, estimate or error did not match what actually happened, or was absent where the user needed it (several failure causes behind one message, rows with no per-item state, unknown input dropped without a word).
- Catch: For each outcome (success, each failure cause, each item in a list), does the user or caller see the real state and the real cause?
- Not this class: C09 (behaviour with no explanation); C11 (the failure itself is silent).
- Pairs: #458 (two failure causes behind one size message) ↔ #12 (parallel import rows with no per-item state); #465 (an action with no declared input reported unrelated errors)
- Evidence: 60 cards over 13 surfaces (cards.mjs stats at revision 25); first refs #26 #34 #57 #58 #88
- Home: question in `.claude/skills/design-screen-content`
- Status: recurring, costly

## C07 Optional choices made the main path longer
- Layer: concept · Moment: design
- Condition: a flow asked the learner for choices the program could default or guess safely, so the required clicks on the main path grew.
- Catch: How many required actions are on the best path and on a fresh user's path, and can each optional choice live behind one fold?
- Not this class: C08.
- Pairs: none yet
- Evidence: 9 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #378 #386 #665 #666 #667
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring, costly

## C08 How users find a feature was decided per feature, not for the whole surface
- Layer: concept · Moment: design
- Condition: entries, blocks, hints or folds were added, moved or removed one feature at a time, so the surface grew crowded or a core feature became invisible to a first-time user, and the finder or tour did not follow.
- Catch: Looking at the whole surface after this change, how many equal-weight entries are there, and what tells a first-time user that this feature exists at the moment they need it?
- Not this class: C07 (choices on one flow); C17 (the feature itself stops short).
- Pairs: #654 (eighteen equal-weight sidebar entries) ↔ #948 (a new learner never found the three core practice tools)
- Evidence: 44 cards over 9 surfaces (cards.mjs stats at revision 25); first refs #27 #173 #381 #398 #404
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring, costly

## C09 Information users need is unexplained or reachable by only some inputs
- Layer: concept · Moment: communicate
- Condition: a control or state with hidden rules (queueing, pausing, limits, fallbacks, cost) shipped without an explanation, or its explanation sits in a channel that keyboard or touch users cannot reach.
- Catch: Can a user predict what this does, when, and what it costs, and can a keyboard or touch user reach that explanation?
- Not this class: C06 (an explanation exists but is untrue).
- Pairs: #86 (key details only in native title attributes)
- Evidence: 9 cards over 6 surfaces (cards.mjs stats at revision 25); first refs #370 #601 #673 #745 #764
- Home: question in `.claude/skills/design-screen-content`
- Status: recurring, costly

## C10 A scope or limit was pinned to the current case
- Layer: concept · Moment: design
- Condition: behaviour was restricted to the current course, a fixed count or a single provider where users need several, and the limit was written into code rather than configuration.
- Catch: Is this limit a product decision with a configurable default, or did I pin it to the case in front of me?
- Not this class: C12 (a default with no limit at all).
- Pairs: none yet (seed: current-course-only home card; a fixed question cap enforced in several modules)
- Evidence: 6 cards over 5 surfaces (cards.mjs stats at revision 25); first refs #134 #220 #380 #383 #805
- Home: question in `.claude/skills/place-shared-code`
- Status: recurring

## C11 A failure, an empty result or a spend happened silently
- Layer: logic · Moment: implement
- Condition: a step that failed, returned nothing or used up quota did so without a visible, true reason and without a retry or resume, so the user lost work, coverage or money without knowing it.
- Catch: If this step fails or returns empty, what does the user see, and does the work retry or resume without paying twice?
- Not this class: C06 (something is shown, but it is wrong).
- Pairs: none yet (seed: an empty search index silently stopped retrieval; malformed review replies dropped batches)
- Evidence: 11 cards over 6 surfaces (cards.mjs stats at revision 25); first refs #50 #106 #184 #197 #234
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C12 A default was not sized to what the user can afford or consume
- Layer: concept · Moment: design
- Condition: a default sent work to the scarce or paid provider, split it into more paid calls than needed, repaid on retry, produced more output than a user can read, or sent the same large input in many calls in an order the provider cannot reuse. Also: paid work ran with no cap, a cap was checked at a coarser point than the spend (between rounds, not before each call), or every stage used the costliest route with no per-stage sizing.
- Catch: For a large input, how many calls, how much cost and how much output does this default produce, can the user afford and read it, is the repeated part placed first (measured on the real provider's cache), is there a cap checked before each paid call, and does each stage use only the model it needs?
- Not this class: C10 (a limit pinned too tight); C11 (spend that is silent).
- Pairs: #462 (an outline build split one material set into 636 tiny points)
- Evidence: 15 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #10 #218 #266 #519 #617
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring, costly

## C13 A local event triggers global work
- Layer: logic · Moment: implement
- Condition: one interaction (an answer, a hover, a source opening) caused work proportional to the whole page, list or document, or a recurring call repeated work on unchanged data every time, so the app lagged on ordinary laptops.
- Catch: What does this handler or call cost each time, measured in the real host, is the work scoped to what changed, and can unchanged data be reused?
- Not this class: C03.
- Pairs: #1304 (the whole page restyled on every answer)
- Evidence: 18 cards over 7 surfaces (cards.mjs stats at revision 25); first refs #2 #24 #38 #215 #224
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C14 Structure grew by accretion instead of through a seam
- Layer: process · Moment: implement
- Condition: each addition went into the nearest existing place (one more prop threaded through every layer, one more branch in shared code, one more block in a large file) instead of a unit that plugs into an extension point.
- Catch: Does this addition make an existing file, function or prop chain longer, and is there a seam it should plug into instead?
- Not this class: C02 (a second owner instead of none).
- Pairs: #113 (services threaded as props through every page) ↔ #130 (the home component grew to 917 lines)
- Evidence: 11 cards over 6 surfaces (cards.mjs stats at revision 25); first refs #74 #108 #112 #131 #154
- Home: question in `.claude/skills/place-shared-code`
- Status: recurring

## C15 A tool or platform behaved differently from the assumption
- Layer: logic · Moment: implement
- Condition: a command or edit assumed Unix behaviour or LF files on Windows (line endings, shell quoting, console encoding), and silently changed or broke files.
- Catch: none needed at a moment; this is long-tail knowledge.
- Not this class: C03 (product behaviour judged from a stand-in).
- Pairs: none yet
- Evidence: 3 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #52 #357 #810
- Home: record `docs/agent-lessons/solutions/windows-tool-assumptions.md`
- Status: recurring

## C16 A rule or required property lived only as intent, with no check that fails on the next violation
- Layer: process · Moment: implement
- Condition: a design or consistency rule (a style restraint, an icon size, a number repeated in docs) or a property the output must have (a question that tests the concept, delimited formulas) was stated, but nothing failed when a change or a generated output broke it; form checks passed while the needed property went unchecked.
- Catch: Which test or guard fails if the next change or the next generated output breaks this rule or lacks this property, and does it scan the whole tree or the real outputs?
- Not this class: C04 (the check exists but did not run); C02 (the rule has two owners).
- Pairs: #1094 (info-blue and side stripes spread over 19 files) ↔ #1041 (docs kept old limits after the code changed); #1041 ↔ #37 (generated questions passed form checks while testing wording memory)
- Evidence: 65 cards over 13 surfaces (cards.mjs stats at revision 25); first refs #6 #37 #49 #66 #76
- Home: question in `.claude/skills/place-shared-code`
- Status: recurring, costly

## C17 The capability covers the middle of the user's job, not its start, end or variants
- Layer: concept · Moment: design
- Condition: a feature worked for the case in hand but stopped at the edges of the user's job: a fresh user with nothing installed, another view or mode where it appears, an in-between state the user can be in when the next event arrives (installed but awaiting restart), or the later steps of moving, renaming, removing, saving or handing the work on; or a shortcut or entry that hands off to a generic flow without carrying its target or intent.
- Catch: Walking the user's whole job with this thing, from a fresh start through every view and every intermediate state to changing, handing on and removing it, where does it stop?
- Use only when the catch reads that way; a missing content kind, a pending state or an unsafe removal with its own lesson is a different class.
- Not this class: C01 (one path of a fix); C08 (the feature exists but cannot be found).
- Pairs: #459 (the book write interface could add but not move or delete) ↔ #1017 (a note made from a question kept the template and dropped the Q&A); #189 (a converter usable only after manual install) ↔ #456 (selection Q&A shown in a view that cannot report selections); #470 ("free editing" declared done at file level only)
- Evidence: 56 cards over 11 surfaces (cards.mjs stats at revision 25); first refs #15 #22 #23 #48 #54
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring, costly

## C18 An operation rewrote or overwrote content the user already owned without a safe mapping or a check of what was there
- Layer: logic · Moment: design
- Condition: an operation that regenerates structure moved or relabelled content the user already owned by a proxy (page number, kept id) without checking the fit, showing a preview or keeping what fits nowhere; or an action wrote into an input, draft or field the user may already have filled, without first checking what was there and keeping it.
- Catch: If this runs over content the user already has or has typed, what happens to each existing item, and does the code keep it or show the user and get confirmation first?
- Not this class: C20 (a transformation breaks a property, without a rebuild).
- Pairs: #478 (notes moved by page number to points they did not belong to) ↔ #461 (rebuilt outline kept ids but changed their titles)
- Evidence: 10 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #453 #489 #612 #618 #827
- Home: question in `.claude/skills/decide-from-data`
- Status: recurring, costly

## C19 A decision was made on state that was not settled at that instant
- Layer: logic · Moment: implement
- Condition: code decided from state that another step was about to fill or change (fields set after submit, a save in flight, layout still moving, a flag the same step had just written), from shared state a concurrent request can change, or applied an async result to the current state instead of the request that issued it.
- Catch: At the instant this code decides, reads or applies a result, is everything it reads final and does it still belong to the request or state it came from, including during a request in flight, a fast second request, or layout still settling?
- Not this class: C11 (the outcome is silent); C33 (a terminal state reported before the work stopped); C36 (a test racing); C32 (settled state left from an earlier use). C39 (a settled setting read at the wrong moment). C46 (a settled signal that also fires where the thing is not true).
- Pairs: #322 (a duplicate check read fields filled after submit) ↔ #603 (a scroll position restored before the layout settled); #1047 (a close decided while a save was in flight) ↔ #609 (a restore used a stored offset while rows arrived)
- Evidence: 15 cards over 9 surfaces (cards.mjs stats at revision 25); first refs #3 #4 #14 #61 #303
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C20 A transformation broke a property that other code or the user relies on
- Layer: logic · Moment: implement
- Condition: a rewrite, normalisation or rescheduling of data changed something it should have left intact (ordinary characters, stored text next to a match, a minimum gap another component guarantees).
- Catch: Which properties of this data do other parts or the user rely on, and have I run the transformation on real data to see each one survive?
- Not this class: C03 (judged from a stand-in, but nothing was broken by the change itself); C18.
- Pairs: #8 (a whitespace cleanup turned every letter s into a space) ↔ #932 (an exam alignment pass ignored the scheduler's minimum gap); #467 (quote normalisation dropped the footnote mark next to a match)
- Evidence: 12 cards over 7 surfaces (cards.mjs stats at revision 25); first refs #51 #181 #187 #248 #413
- Home: question in `.claude/skills/decide-from-data`
- Status: recurring, costly

## C21 A rule written for one case also caught siblings it was not meant for
- Layer: logic · Moment: implement
- Condition: a placement, selector, style, filter, label table or handler was written for the variant, or for the common shape of a family, in hand, and also applied to sibling variants, element kinds or family members whose own kind or shape differs (they got another member's name, stages or sections, or were taken for a different family), where it was never looked at.
- Catch: Which other variants, element kinds or family members does this rule, label or handler match or move, and have I looked at each one with its own kind and shape?
- Not this class: C01 (a fix reached too few paths; C21 reaches too many); C03 (a stand-in environment).
- Pairs: #9 (a strip placed in flow for every card type pushed one type under its floating header) ↔ #30 (a rule for plain row buttons also dropped a new chapter button onto its own line)
- Evidence: 23 cards over 10 surfaces (cards.mjs stats at revision 25); first refs #9 #30 #244 #297 #362
- Home: question in `.claude/skills/decide-from-data`
- Status: recurring, costly

## C22 A broad operation was scoped by exclusion or wildcard over a place others share
- Layer: logic · Moment: implement
- Condition: a cleanup, add or delete selected its targets as "everything except what I own" or by a broad pattern, in a location other components or sessions also use, and so removed or committed things it did not create.
- Catch: Does this operation name only the items I created or intend, or does it select by exclusion or wildcard in a place others use?
- Not this class: C02 (a second owner of the same thing); C20 (a rewrite that breaks a property of the data).
- Pairs: #25 (an upgrade cleanup deleted every file in a shared folder except the one it installed) ↔ #36 (a broad add committed six files of another session)
- Evidence: 2 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #25 #36
- Home: question in `.claude/skills/decide-from-data`
- Status: costly

## C23 Accessibility semantics were added without checking what keyboard and screen-reader users get
- Layer: logic · Moment: implement
- Condition: a role, state, live region or accessible name was declared or left out based on the visual result alone, and keyboard and screen-reader behaviour did not match what it promises or implies (a dialog role without focus moving in, a menu role without arrow keys or Esc, a status region that re-announces every second, contradictory pressed and expanded states, a progress bar with no name). Also: a list or grid of many items was given no keyboard model (one tab stop per item, no arrow walking).
- Catch: For each role, state or live region I add, what does a keyboard and screen-reader user get (focus, keys, what is announced, the name), and did I try it that way?
- Not this class: C09 (an explanation is missing or unreachable); C06 (the displayed state is wrong for everyone); C03 (a stand-in environment in general).
- Pairs: #71 (focus lost when a dialog role mounted without taking focus) ↔ #100 (a whole job row made a live region, so a ticking timer was read every second)
- Evidence: 10 cards over 1 surfaces (cards.mjs stats at revision 25); first refs #71 #79 #82 #100 #144
- Home: none yet
- Status: candidate

## C24 A fact, list or decision was restated in several places with no single table
- Layer: concept · Moment: design
- Condition: one fact, constant, option list, category set or decision (labels, kinds, preferences, the states to reset, a rule enforced in two code paths) was written or branched separately in several tables, readers or if-chains, with no single registry owning it, so the copies drifted and each new case needed several edits.
- Catch: Is this fact or list defined once and read everywhere else? If I am adding another case, how many places must I edit, and should they become one table?
- Not this class: C02 (a component or mechanism rebuilt per caller); C16 (a rule with no guard at all).
- Pairs: #63 (the accent colour restated as literals) ↔ #110 (opening, returning and describing a target each branched on kind in four places); #1045 (the warning and the validator decided one schema rule separately)
- Evidence: 69 cards over 13 surfaces (cards.mjs stats at revision 25); first refs #28 #63 #64 #65 #93
- Home: question in `.claude/skills/place-shared-code`
- Status: recurring, costly

## C25 A shared primitive or default was shaped, scoped or placed for one case
- Layer: concept · Moment: design
- Condition: a shared unit (component, constant, behaviour hook, global style layer) was left private to one feature, lacked the variants its callers need, lived where some callers cannot import it, or forced itself on every consumer (global element rules, forced overrides), so consumers wrote overrides, resets, copies or cross-feature borrows, and the patches escalated.
- Catch: Is this shared thing in a shared place under a neutral name, does it cover the variants its callers need, and can a consumer differ from it without an override? How many overrides, resets or copies exist already?
- Not this class: C02 (a usable owner exists and callers skipped it); C21 (one rule reached siblings it was never looked at for, with no pattern of consumer patches).
- Pairs: #152 (button and segmented control lacked wrap and full-width variants, so each stylesheet copied overrides) ↔ #120 (shared constants lived in a module the browser could not import, so the UI copied them and one copy was wrong); #136 (a global primary-button rule forced with !important) ↔ #141 (generic provider and key-form primitives owned by one feature, borrowed by others)
- Evidence: 26 cards over 5 surfaces (cards.mjs stats at revision 25); first refs #78 #80 #120 #129 #136
- Home: question in `.claude/skills/place-shared-code`
- Status: recurring

## C26 Replaced or removed code was left behind, with no check for orphans
- Layer: process · Moment: declare-done
- Condition: an implementation, component, test or style was superseded or removed, but what it made redundant (a dead component still under test, unreferenced selectors, an old mechanism still running) stayed in place, looked like a live second owner, attracted edits and hid the real surface. Also: code removed because nothing referenced it left behind a function whose only live callers were the removed files. Also: a definition (token, selector, constant) that no code references, where no check fails on an unreferenced one.
- Catch: When I replace or remove something, did I delete everything it made redundant (code, tests, styles, listeners, and functions whose only users were what I removed), and what check fails on an orphan?
- Not this class: C02 (a second live owner built on purpose); C16 (a rule with no guard, nothing superseded).
- Pairs: #133 (a dead import component still under test) ↔ #155 (dozens of unused selectors after code was removed); #73 (an old focus trap left running after a new dialog replaced it)
- Evidence: 8 cards over 5 surfaces (cards.mjs stats at revision 25); first refs #73 #133 #155 #340 #685
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring

## C27 Content arriving after first paint moved or overwrote what the user already saw or chose
- Layer: logic · Moment: implement
- Condition: data that arrives after first paint, or that only some items ever have (badges, recommendations, derived titles, loaded estimates, an optional chooser), was inserted with no reserved space, or the reserved slot was sized to its worst case in every item; the placeholder and the ready state differed in size, arrival recomputed a default, rows already visible shifted, a choice the user was looking at changed, or rows without the content showed an empty gap. Example: a column kept in every row for actions that only appear on hover (#1117).
- Catch: When this data arrives after first paint, does anything already shown move or change, is the loading state the same size as the ready state, and does a row that never gets it pay nothing for the slot?
- Not this class: C19 (a decision made on unsettled state, or a result applied to the wrong request; here the request is right and its arrival disturbs the display); C13 (cost, not movement).
- Pairs: #204 (an estimate row changed width on load and moved the action next to it) ↔ #206 (a late recommendation panel pushed the list down and switched the default mode); #205 (late badges made every row taller) ↔ #225 (late derived titles moved visible rows)
- Evidence: 11 cards over 5 surfaces (cards.mjs stats at revision 25); first refs #204 #205 #206 #225 #1084
- Home: question in `.claude/skills/design-screen-content`
- Status: recurring, costly

## C28 Independent units of work were serialised, with no timing to show the bottleneck
- Layer: logic · Moment: design
- Condition: independent units (waves, chained stages, files, a forced single worker) ran one after another or in blocking batches, with conservative hard-coded concurrency and no per-stage timeline, so wall-clock time was lost and the cause stayed invisible.
- Catch: Which of these units are independent, is the concurrency adjustable, and does a per-stage timeline show where the wall clock goes?
- Not this class: C13 (too much work per event, not too serial); C12 (cost, not latency).
- Pairs: #198 (generation stages chained at low default parallelism) ↔ #212 (proofreading in blocking waves with files forced serial)
- Evidence: 6 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #198 #212 #320 #377 #643
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C29 A quality gate treated every finding as fatal
- Layer: logic · Moment: design
- Condition: a review, validation or precondition check on an action returned only pass or fail, with no severity or repair path, so fixable, cosmetic or advisory findings discarded whole outputs that could have been repaired or kept, or refused the user's action (a save blocked by unfinished optional background work) instead of proceeding with a warning.
- Catch: For each finding this gate can raise, is it fatal, fixable or advisory, and does the gate act accordingly?
- Not this class: C16 (no gate exists); C11 (the loss is silent; here it is visible but wrongly severe).
- Pairs: #202 (a hint that revealed the answer dropped the whole question although a local fix existed) ↔ #216 (formatting differences and rewrite suggestions each dropped a question)
- Evidence: 3 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #202 #216 #696
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C30 Group-level information was repeated on every row
- Layer: concept · Moment: design
- Condition: information common to a group of rows (a file name, a note, a setting) was repeated on each row, or the counting unit did not match what was counted, instead of being stated once at the group level.
- Catch: What is common to all rows here, and is it stated once at the group level with the right unit?
- Not this class: C24 (a fact restated in code with no single table); C08 (crowded entry points).
- Pairs: #201 (the same long file name on every page row, pages counted as documents) ↔ #214 (the same warning and setting line on every history row)
- Evidence: 4 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #201 #214 #569 #586
- Home: question in `.claude/skills/design-screen-content`
- Status: recurring

## C31 A replacement path was accepted before it was compared with the old one
- Layer: process · Moment: verify
- Condition: a new path replaced an old one (a new runtime for a legacy one, a new gateway for an old call) and some observable behaviour of the old path (outputs and receipt fields, error codes, retry ability, retry on rate limit, cleanup) was not reproduced; it surfaced only in final review or in a rerun of the old suite.
- Catch: For the path I replace, which outputs, codes, fields and abilities can a caller observe, and has each one been run on both paths and compared?
- Not this class: C01 (a change made on one path while siblings keep the old behaviour); C02 (a second owner built beside an existing one); C04 (checks exist but did not run).
- Pairs: #279 (a receipt field was 0 on the new path) ↔ #287 (an explicit retry refused after a clearly observed failure); #309 (the new path lost the old rate-limit retry)
- Evidence: 6 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #279 #287 #290 #309 #330
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring

## C32 State left over from an earlier attempt, cycle or context was reused without being reset or checked
- Layer: logic · Moment: design
- Condition: a flag, field, container or saved record from a previous attempt, cycle, request or entry was still present when the next one started or resumed, and was reused as if valid, without being reset, re-derived or checked against the new use (including after a failed start). Also: a resumed run decided what was already done from its own saved record without comparing it with what the store already holds, so finished work showed as interrupted.
- Catch: What state from the earlier attempt, cycle or context is still present when this one starts or resumes, is each part reset, re-derived or checked as valid for the new use (including after a failed start), and does a resume compare its own record with the facts in the store?
- Not this class: C19 (state not settled at this instant); C35 (finished work repeated or duplicated).
- Pairs: #275 (a restored-state flag and finish time carried into the next attempt) ↔ #182 (a finished round reused for a new entry); #316 (a resume applied a saved manifest to a changed source)
- Evidence: 19 cards over 7 surfaces (cards.mjs stats at revision 25); first refs #182 #275 #316 #343 #739
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C33 A stop, timeout or terminal state was reported while the work was still running or holding resources
- Layer: logic · Moment: implement
- Condition: cancel, timeout or "ended" was reported by ignoring the result, or the status was set before the process, request, queue slot or files had actually stopped or been released; a following action collided with the leftover work, or the leftover work kept spending.
- Catch: When this code reports cancelled, timed out or finished, has the work it stands for actually stopped and released what it held (process, request, queue slot, files)?
- Not this class: C19 (a decision on state still changing); C11 (a failure is silent).
- Pairs: #304 (cancelled while an installer was still writing, so an immediate uninstall raced it) ↔ #305 (a timeout dropped the late answer while the request kept billing); #315
- Evidence: 5 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #304 #305 #315 #451 #615
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C34 Background work ran outside the shared task surface, so it could not be seen, stopped or accounted for
- Layer: concept · Moment: design
- Condition: a background operation kept its own run state and called the model or a process directly, so it was missing from the task console, had no cancel, had no usage on its card or ledger, or used its own wording.
- Catch: For this background work, can the user see it in the shared task console, stop it, and see its usage there?
- Not this class: C02 (code rebuilt per caller; C34 is about what the user can see and control); C06 (a displayed state is wrong).
- Pairs: #306 (a local setup absent from the console) ↔ #317 (a live correction that could not be cancelled and had no total); #310 #311 #325
- Evidence: 10 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #306 #310 #311 #317 #325
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C35 An interruptible multi-step operation repeated or duplicated finished work after a restart
- Layer: logic · Moment: design
- Condition: completion of one step (an append, a created object) was not recorded under a stable id or receipt that a replay could check, so after an interruption, or when the same request was issued again, the next attempt re-ran the step or created a second copy; a create step keyed by wording or position instead of identity is the typical cause (#1215: a repeated fill created a second check question because reuse was keyed by prompt text).
- Catch: If this operation is cut off after each step and started again, or the user repeats the same request, which finished steps are repeated or duplicated, and is each one keyed by a stable id or receipt?
- Not this class: C32 (stale state carried in); C11 (silent loss).
- Pairs: #324 (a bank append done but not marked, so a rerun appended again) ↔ #314 (material of an interrupted run duplicated on resume)
- Evidence: 6 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #314 #324 #342 #614 #1215
- Home: question in `.claude/skills/design-background-work`
- Status: recurring

## C36 A test depended on timing, ordering, load or runtime behaviour it did not control
- Layer: logic · Moment: implement
- Condition: a test or test helper read or compared at a moment decided by timing (a fixed time window, one of two tasks finishing, a directory still being written, the wall clock crossing a boundary, mocked timers that also freeze the code under test, garbage-collection timing, the runner's free disk or other machine state), so it failed on slow, loaded or boundary runs. Also: a test released its resources (temp folder, preview server) only on the passing path or in an order it did not control, so a failure left a leak that hung or raced the run. Also: a test double or teardown hook held requests open (ignored the abort signal, or was registered after the hook that waits for it), so dispose stalled until a timeout.
- Catch: Does this test depend on wall-clock time, timer order, machine load or runtime behaviour it does not control, does it still pass if the run is slow or crosses a boundary, does cleanup run on the failure path in an order that does not race the code under test, and does every held request or promise get released when the code under test cancels or disposes?
- Not this class: C19 (production code deciding on unsettled state); C03 (judging the product from a stand-in); C16 (a rule with no check).
- Pairs: #307 (a test read the clock twice across midnight) ↔ #298 (a second run had to start inside a fixed window); #285 (a helper copied a directory still being written), #318 (mocked timers stalled retries)
- Evidence: 28 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #260 #285 #293 #298 #307
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring, costly

## C37 A rule or boundary picked its targets by the names already known, not by the capability that makes them matter
- Layer: logic · Moment: design
- Condition: a refusal list, guard or matcher enumerated the action names, function names or spellings seen so far, so equivalent actions or calls under another name passed unchecked and a boundary said to be absolute had holes.
- Catch: Does this rule or boundary select by a list of known names or spellings, and what else has the same capability that is not on the list (new, renamed, aliased)?
- Not this class: C22 (a destructive operation scoped by exclusion over a shared place); C21 (a rule reached too many siblings; C37 reaches too few); C16 (no guard exists).
- Pairs: #291 (two install actions refused by name while equivalent actions got through) ↔ #326 (a guard matched one function name only)
- Evidence: 2 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #291 #326
- Home: question in `.claude/skills/decide-from-data`
- Status: costly

## C38 A stored or exchanged format crossed a release boundary without being tested in the other direction
- Layer: process · Moment: verify
- Condition: a persisted or exchanged shape was changed (new keys, new states), or was read without checking its version, so the release users can roll back to could not read what the new code wrote, or an older reader took a newer file as its own and overwrote it. Also: a stored value kept its key but the new code gave it a different meaning, so the new reader took an old release's value as the new thing.
- Catch: Can the previous release read what this change writes, does this code refuse a newer or unknown version and leave its bytes alone, and which test runs each reader on real output of the other release?
- Not this class: C16 (a rule with no check at all; C38 is one specific untested compatibility direction); C32 (a stale record reused on resume).
- Pairs: #331 (new manifest keys rejected by the previous release's closed schema) ↔ #360 (a stored version never compared, so an older reader overwrote a newer file); #339
- Evidence: 6 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #331 #339 #360 #487 #611
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring, costly

## C39 A run took a setting's value from the wrong moment
- Layer: concept · Moment: design
- Condition: a long-running, resumed or continued operation read a user setting or shared list, but nobody decided or stated whether it uses the value as issued or as it is now; an edit made mid-run changed work already submitted, or an edit had no effect on the run the user was sent to adjust.
- Catch: For each setting this operation uses across steps or on a continuation, is it taken as issued or as it is now, is that written down, and does a test change the setting mid-run and on a continuation?
- Not this class: C19 (a decision on state not yet final, or a result applied to the wrong request; here the value is settled and the question is which moment's value is meant); C32 (stale state carried into a new attempt).
- Pairs: #312 (a glossary re-read each wave, so a mid-run edit changed a submitted translation) ↔ #368 (a continuation kept a limit frozen in the draft; #371 is the same change)
- Evidence: 4 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #312 #368 #371 #937
- Home: question in `.claude/skills/design-background-work`
- Status: recurring

## C40 A control, prompt or warning was shown without checking the condition that makes it valid
- Layer: logic · Moment: implement
- Condition: a button, link, dialog or warning was rendered or opened unconditionally, although whether it applies (a host capability, a count above zero, a prerequisite present) was knowable when it was shown; the user acted or read, and only then learned it did not apply.
- Catch: For each control, prompt or warning I show, what condition makes it valid or true, is that condition read at the moment of showing, and is it shown only then?
- Not this class: C17 (the user's job stops short at its edges, or a view lacks a capability and offers no fallback, as in #456); C06 (a displayed state or cause is wrong); C09 (a hidden rule has no explanation).
- Pairs: #400 (a hand-in dialog warned about 0 unanswered items on a full paper) ↔ #211 (a link always shown, with the host's inability reported only on click)
- Evidence: 13 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #211 #400 #620 #675 #746
- Home: question in `.claude/skills/design-screen-content`
- Status: recurring, costly

## C41 Work was counted as delivered without checking that it is on the branch or channel users get it from
- Layer: process · Moment: declare-done
- Condition: a change or finished piece of work was reported landed, finished, cleaned up or released from the state of its PR, branch or one publishing channel (merged into a stacked base, archived on a side branch, published as a release page), while its content never reached the branch that ships, or another channel users install from stayed on an older version, and a later sweep found it.
- Catch: Is this work present on the branch that ships and on every channel users install from, checked there and not from the PR, the branch or one channel's state?
- Not this class: C04 (the checks exist but did not run on the merged result); C01 (a fix reached one code path, not one branch); C42 (the work was handed out twice).
- Pairs: #251 (a stacked PR merged into its base, so the shipping branch lacked a phase) ↔ #474 (a finished fix sat on a side branch and was in neither of the last two releases); #473 #491
- Evidence: 6 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #251 #473 #474 #491 #750
- Home: question in `.claude/skills/verify-before-done`
- Status: recurring

## C42 The same work item was handed to parallel workers with no claim on it
- Layer: process · Moment: delegate
- Condition: an item was given to more than one worker, or to a worker while an open branch or PR already covered it, with no recorded claim and no decision on who merges or discards a second result, so a full duplicate was built and thrown away.
- Catch: Before handing this item to a worker, is it already assigned, on a branch or in an open PR, and who merges or discards a second result?
- Not this class: C35 (a restart repeats finished steps; here two workers start the same item); C02 (a second live component built on purpose).
- Pairs: #498 ↔ #500 (two duplicate implementations of one issue by parallel workers; find a more different second pair when one turns up)
- Evidence: 2 cards over 1 surfaces (cards.mjs stats at revision 25); first refs #498 #500
- Home: question in `.claude/skills/verify-before-done`
- Status: costly

## C43 A failure was handled by one generic response without telling its kind apart
- Layer: logic · Moment: design
- Condition: a step's failures (a permanent per-item outcome, a transient fault, the guard's own outage) all got the same treatment: counted toward an abort threshold, retried unchanged, or treated as a refusal; one run aborted on an item that can never succeed, or one outage blocked even harmless calls, and nothing recorded the terminal state, so the next attempt hit the same thing.
- Catch: For each way this step can fail, is the failure permanent, transient or the guard's own fault, and does each kind get a different response (recorded and skipped, retried, degraded and reported as a fault) so that a retry makes progress and one kind cannot abort or block everything?
- Not this class: C29 (a review finding judged fatal when fixable; C43 is failure kind and retry policy); C11 (the failure is silent); C35 (finished work repeated after restart); C06 (the message is wrong, not the handling).
- Pairs: #521 (a page that can never yield passages counted toward an abort and was never recorded) ↔ #463 (a permission reviewer's own error treated as a refusal of every call); #523
- Evidence: 16 cards over 7 surfaces (cards.mjs stats at revision 25); first refs #463 #521 #523 #688 #695
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C44 Bytes or work that only some sessions need were paid on the common path
- Layer: logic · Moment: implement
- Condition: code or data that only some sessions or views need (a heavy library, a second language's tables, rarely opened pages, the hidden or unopened part of a page, rows not yet visible) was loaded or built on every first load or page entry, usually through a static import chain or an eager render, and no budget or ceiling failed when it grew. Also: bytes most users never use were shipped in every release package or install. Also: prompt text that only some turns need was sent on every turn, with ceilings too loose to fail.
- Catch: Which of what the common path loads or builds will most sessions never use, and what measure fails when that grows?
- Not this class: C13 (work repeated per interaction or per recurring call on unchanged data); C16 (a stated rule with no guard; here the lesson is what the default path pays for, whether or not a rule was written); C04 (a ceiling exists but did not run on the merged result); C27 (late arrival moving the display).
- Pairs: #562 (almost every page in the first-load closure, with no ceiling) ↔ #590 (page entry built a hidden picker and thousands of elements inside a shut fold); #563 (a second language's tables loaded for every user) ↔ #560 (a renderer pulled in by a static chain that bypassed the lazy wrapper)
- Evidence: 19 cards over 9 surfaces (cards.mjs stats at revision 25); first refs #560 #561 #562 #563 #565
- Home: question in `.claude/skills/design-background-work`
- Status: recurring, costly

## C45 A view was designed and checked only with data present
- Layer: concept · Moment: design
- Condition: a view was designed and looked at only in its populated state, so its empty, zero or unconfigured state (a giant zero as the focal number, an empty message repeated at several layers, controls with nothing to attach to) was never looked at.
- Catch: For each view, what does it show with no data, a zero value or nothing configured, and have I looked at that state next to the populated one?
- Not this class: C03 (wrong environment such as language, width or a fake model; here the input is real but empty); C06 (one empty message covers several causes, #508); C17 (a fresh user cannot get started); C02 (a shared empty-state component was bypassed).
- Pairs: #573 (a statistics page opened on a huge zero for a broken streak) ↔ #576 (an empty board showed four empty messages); #591
- Evidence: 7 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #573 #576 #591 #655 #700
- Home: question in `.claude/skills/design-screen-content`
- Status: recurring

## C46 A status or decision was taken from a signal that also fires where the thing it stands for is not true
- Layer: logic · Moment: design
- Condition: a derived status, count or action (studied, hand-off intended, whole book, user wants to close) was computed or triggered from a raw signal that usually accompanies the thing but also fires in other contexts where it is not true, or from the absence of its evidence, so missing input counted as proof; nobody listed the contexts that produce the signal or the case where it is absent.
- Catch: Which contexts produce the signal this status or action is computed from, including the context where the evidence is absent, is it true in each of them, and is there an explicit flag that only the real thing sets?
- Not this class: C19 (the state is not yet final; here the signal is settled but means something else); C24 (several sources count one fact differently; here one source over-fires); C21 (a selector reaches sibling variants); C06 (what is shown is untrue; here the computation behind it is wrong). C50 (the signal is true but other recorded evidence is ignored; C46 is a signal or record that stands for something untrue in that context, such as a record that is not an answer, a clock running while the user is away, a visibility event caused by a jump).
- Pairs: #625 (a point counted as studied from any recorded attempt, which also fires in mock exams) ↔ #597 (a stored link taken as proof of an explicit hand-off, so a board opened its composer on its own); #1028 (a menu closed on any scroll event)
- Evidence: 25 cards over 9 surfaces (cards.mjs stats at revision 25); first refs #522 #597 #625 #737 #754
- Home: question in `.claude/skills/decide-from-data`
- Status: recurring, costly

## C47 An action, message, warning or default order was placed and weighted in build or ranking order, not the order the user looks, decides and works through
- Layer: concept · Moment: design
- Condition: a control, message, warning, feedback or default sequence was placed, weighted or ordered by how the system built, produced or ranks it, not by the order the user looks, reads and decides: the committing or destructive action sat beside or ahead of what must be checked first, feedback appeared away from the thing just acted on, a warning shared one style with plain facts, a transient notice floated at a spot that depends on content height, or items the user works through came in production, finish or shuffle order rather than the order the source or the user's job walks through.
- Catch: On this screen and in this sequence, where does the user look and in what order do they decide or work through the items, and does each action, message, warning and default order sit and weigh in that order?
- Not this class: C08 (equal-weight entries counted across a surface; C47 is where and how heavily one item sits); C40 (a control shown when its condition is false); C06 (a message that is untrue or missing); #56 (a destructive action with no recoverable step is irreversibility, not placement). C50 (the order is wrong because a signal the system already recorded is ignored, as in #906).
- Pairs: #669 (publish placed before the questions the user must review) ↔ #676 (a needs-action warning in the same grey line as plain facts); #668 #672 #677
- Evidence: 9 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #668 #669 #672 #676 #677
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring

## C48 A step depended on an external resource that moves or stalls, with no pin, bounded wait or retry
- Layer: process · Moment: implement
- Condition: a pipeline or build step fetched or floated on something outside the repo (a latest image tag, a package mirror, a download) with no pinned version, no time limit and no retry of a transient fault, so when the resource changed or stalled, the step hung until the whole job limit and failed a run that was otherwise fine.
- Catch: For each external thing this step pulls (image tag, package mirror, download), is its version pinned, is a stall bounded by a time limit, and is a transient failure retried?
- Not this class: C15 (assumed behaviour of a local tool); C36 (a test's own timing); C03 (product judged from a stand-in); C04 (a check that exists did not run).
- Pairs: #757 ↔ #789 (issue and fix PR of one CI incident; find a second surface such as an unpinned action or tool version)
- Evidence: 2 cards over 1 surfaces (cards.mjs stats at revision 25); first refs #757 #789
- Home: question in `.claude/skills/design-background-work`
- Status: costly

## C49 A proposal was scoped to the ideal end state without weighing its upkeep against what the existing mechanism already covers
- Layer: concept · Moment: design
- Condition: a plan, issue or design proposal (often written by an audit or an agent) specified the complete end state (a second parallel entry, hash locking across platforms, a receipt state machine, a double-blind framework) while existing mechanisms already covered most of the need, and the owner closed it as too heavy for the upkeep it adds. Also: a defect report or proposal the owner closed as already covered or as the default sufficing (#901 #912).
- Catch: Before proposing this, what does the existing mechanism already cover, what is the smallest change that closes the remaining gap, and who pays the upkeep of the proposal on every later change?
- Not this class: C02 (code-level copies actually built); C03 or C04 (the gap was real and fixed in a lighter form); C07 or C08 (when the only reason was an extra click or a crowded surface and no existing mechanism was named).
- Pairs: #841 (a text-only interface that would double the upkeep of every UI change) ↔ #844 (a release receipt state machine on top of existing CI, release check and hash list); #843 (platform-wide hash locking) ↔ #846 (an evaluation framework where light sampling sufficed)
- Evidence: 13 cards over 6 surfaces (cards.mjs stats at revision 25); first refs #841 #843 #844 #846 #848
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring, costly

## C50 A decision ran on fewer of the system's own recorded or computed signals than bear on it
- Layer: concept · Moment: design
- Condition: a decision, schedule, grade, status or ordering was computed from one input while a signal the system already stored or computed (a deadline on the same record, hint use, a failure count, forgetting) bore on it and was read by nothing, or was never exported to the code that decides, so the user-visible result contradicted that evidence.
- Catch: For each decision this code makes, which signals the system already records or computes bear on it, and is each one read here or deliberately left out?
- Not this class: C46 (a signal that over-fires or whose absence counts as proof; C50 is evidence that never arrives); C02 (a usable component rebuilt); C24 (a fact restated in several places); C17 (a job that stops short at its edges).
- Pairs: #882 (a scheduler ignored a deadline stored on the same record) ↔ #884 (a failure count was written and read by nothing); #883 (a flat grade despite stored hint use) ↔ #894 (readiness ignored projected forgetting)
- Evidence: 17 cards over 4 surfaces (cards.mjs stats at revision 25); first refs #881 #882 #883 #884 #889
- Home: question in `.claude/skills/decide-from-data`
- Status: recurring, costly

## C51 A change or deletion of the user's stored work shipped with no way back
- Layer: concept · Moment: design
- Condition: an action that changes or deletes the user's stored work or progress (a one-key grade, a removal, a bulk edit, an overwrite by sync) was shipped with no undo, restore point or recoverable stage, so a slip or a bad bulk operation could be repaired only from an export most users never made.
- Catch: If the user does this by mistake, or the data is damaged, what brings the earlier state back, and does that path exist before the action ships?
- Not this class: C18 (a check or preview before an operation rewrites existing content; C51 is the way back after the write); C47 (placement of a destructive control); C29 (a gate that refuses).
- Pairs: #56 (a removal went straight to permanent deletion) ↔ #885 (a mis-keyed grade reset the interval and could not be corrected); #892
- Evidence: 5 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #56 #885 #892 #1107 #1109
- Home: question in `.claude/skills/decide-from-data`
- Status: recurring

## C52 The faithful original form of the user's material was unsupported or buried, so the user was forced through a lossy derived form
- Layer: concept · Moment: design
- Condition: the user owns material in a richer or more faithful form (source markup, an original document view), but the feature accepted or defaulted to only a lossy derived form (extracted text, a converted copy), and the original form was unsupported on import or hidden behind a secondary control that did not follow the user's place.
- Catch: For each kind of material the user owns, can they bring it in and read it in its faithful original form without an export or conversion first, and is that form one step from the derived view, at the same place and remembered?
- Not this class: C20 (the system's own transformation broke a property, as in #897; C52 is the faithful form never offered or reachable); C17 (excludes a missing content kind); C08 (the crowd of entries, not which form of one thing is the default).
- Pairs: #978 (the user had to export source markup to PDF before upload) ↔ #1001 (formula-heavy PDFs defaulted to garbled extracted text with the original view buried); #998
- Evidence: 5 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #781 #978 #998 #1001 #1021
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring

## C53 A step the user takes mid-job replaced or closed the view they were working from
- Layer: concept · Moment: design
- Condition: an action reachable from the screen where the user works (open the source, answer a section question, start a related flow) was built to open a full-size view or separate flow that hid, closed or replaced that screen, so the user lost their place or the context (question, options, reading position) needed to use the result and had to re-find it on return. Also: such a step switched a selection the user works under (the current course, a filter) so that the target could load, and the way back restored the place but not that selection (#1223 #1234).
- Catch: When the user takes this step, what must stay visible or be restored (the question, the place, the draft, and any selection this step changed), and does this step keep it in view or bring the user back to it?
- Not this class: C17 (the job stops short of its start, end or a variant; a hand-off that drops its target is C17); C47 (where one item sits and how heavily it is weighted); C40 (a control shown although its condition is false); C32 (stale state reused).
- Pairs: #1012 (material opened as a full-screen dialog that hid the question) ↔ #1013 (answering a section question closed the reader and lost the reading position); #1034
- Evidence: 5 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #1012 #1013 #1034 #1223 #1234
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring

## C54 Parts of one unit were each given their own width, frame, spacing or separator, with no shared unit setting them together
- Layer: concept · Moment: design
- Condition: elements the user reads or operates as one unit (a label with its controls, blocks stacked in a small dialog, a sentence joined from fragments, the rows of one list) were assembled from independent pieces that each set their own width, left edge, frame style, spacing, punctuation or how much of their content to show; no grid, row unit, builder or list-level value owned the arrangement, and nobody looked at the joined result for each combination of present and absent parts, or at neighbouring rows side by side, so edges, frames, joins or cut points did not line up.
- Catch: Which pieces (or rows of one list) does the user take as one unit here, and does one grid, row unit, builder or list-level value set their edges, frames, spacing, separators and how much each shows, checked with each optional piece present and absent and with neighbouring rows side by side?
- Not this class: C02 (one action rebuilt on several pages; C54 is the parts inside one place); C24 (a fact or decision restated in code); C25 (a shared primitive lacked variants); C16 (a written rule had no guard); C21 (a rule reached siblings).
- Pairs: #1085 (a dropdown and a filter box with different widths, edges and looks) ↔ #1086 (a header sentence with a stray dot and a missing separator); #1081 (three frame styles stacked in one small dialog); #1135 (rows of one list each decided alone how much of their size to show)
- Evidence: 4 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #1081 #1085 #1086 #1135
- Home: question in `.claude/skills/design-screen-content`
- Status: recurring

## C55 A feature acted on and recorded the unit the system stores, not the unit in which the user gets stuck or works
- Layer: concept · Moment: design
- Condition: a feature's action, entry or record followed the stored unit (question, page, file, one request per item) while the user gets stuck, understands or works in another unit (a term, a section, a set of items), so the user could not name that unit, had to repeat the action once per item, or got no result gathered at that unit.
- Catch: In which unit does the user get stuck, understand or work on this, is that the unit this feature acts on and records, and if not, where can the user name that unit and see the result gathered by it?
- Not this class: C08 (the feature exists but is not found where the need appears; C55 is found but acts on the wrong unit); C17 (the job stops at its start, end or a variant); C50 (a recorded signal ignored); C47 (placement or order); C24 (a fact restated).
- Pairs: #1192 (help acted only on the whole question; the user could not mark one unfamiliar word) ↔ #1194 (help records kept per question, nothing gathered for the section where the gap sits); #1202 (marking five words took five separate requests)
- Evidence: 8 cards over 3 surfaces (cards.mjs stats at revision 25); first refs #551 #553 #1014 #1154 #1192
- Home: question in `.claude/skills/design-user-flow`
- Status: recurring

## C56 A composite action reused single-item operations without silencing the side effects each one carries
- Layer: logic · Moment: implement
- Condition: an action that does the work of many steps was built by calling operations written for one item; each kept its own side effect (a notice, a message, a record, a charge), nobody listed those effects for the composite, so one user action fired them once per step.
- Catch: When this action calls operations built for a single item, which of them also notify, record or spend on their own, and does the composite action suppress those and emit one effect for the whole?
- Not this class: C21 (a rule reached sibling variants it was never meant for; here the operation was reused as designed); C02 (a second owner built); C35 (a restart or repeat re-runs finished steps); C13 (a local event triggers global work); C06 (the message is wrong, not repeated).
- Pairs: #1218 (one supplement left six inbox letters, one per linked item and follow-up) ↔ #1235 (the fix: a silent flag on the reused operations and one summary from the composite). One incident so far; look for a second surface (a bulk action that logs, charges or notifies per item).
- Evidence: 2 cards over 1 surfaces (cards.mjs stats at revision 25); first refs #1218 #1235
- Home: none yet
- Status: candidate

## C57 A displaying component had no rule for a content form that the producing side already emits
- Layer: logic · Moment: implement
- Condition: a shared renderer, viewer or parser handled the content forms in hand while the writer, importer or content model could already produce another form (image syntax, a horizontal rule, a table), so that form showed as raw markup or nothing.
- Catch: For the content this writer or model can produce, does every component that displays it have a rule for each form, and have I rendered one sample of each form?
- Not this class: C17 (a job stopping short; a missing content kind is not C17); C52 (the faithful original form unsupported); C20 (a transformation broke a property); C03 (accepted from tidy input; C57 is the producer/renderer contract).
- Pairs: #32 (question cards showed image markup as raw text) ↔ #232 (a line of dashes in transcripts showed as raw text in the reader)
- Evidence: 2 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #32 #232
- Home: none yet
- Status: candidate

## C58 A value was keyed or looked up by an identifier that did not name the unit it belongs to
- Layer: logic · Moment: implement
- Condition: a key was built from too few coordinates, so distinct units (rounds, attempts) collided, or a lookup went through a neighbouring record's similar reference; test data in which the similar identifiers were equal hid it.
- Catch: For this key or lookup, which exact unit does the value belong to, does the identifier carry every coordinate that tells it from its neighbours, and does a test use data where the similar identifiers differ?
- Not this class: C35 (a step re-run or duplicated after restart or repeat; C58 is the key itself naming the wrong unit); C32 (stale state reused); C03 (behaviour accepted from a stand-in).
- Pairs: #302 (generation step keys were the same for different rounds) ↔ #1146 (a history view read the clearing attempt's run instead of the missed attempt's); #1150
- Evidence: 3 cards over 2 surfaces (cards.mjs stats at revision 25); first refs #302 #1146 #1150
- Home: question in `.claude/skills/decide-from-data`
- Status: recurring

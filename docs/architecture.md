# StudyHub 2.0 Alpha architecture

Question decks remain JSON. Materials retain their original PDF, Markdown, HTML or TXT files and expose versioned text projections. The workbench composes separately loadable capability plugins.

## Contexts and public APIs

| Context | API | Responsibility |
| --- | --- | --- |
| Runtime | `StudyRuntime` / `studyRuntime` | Registration, owned persistence ports, request services, transactions, capability discovery and disposal |
| Materials | `materials.v1` | Original files, source projections, exact selections, grounded questions, material metadata and backlinks |
| Bank | `bank.v1` | JSON decks, card content, draft publication, idempotent additions and a narrow schedule update port |
| Study | `study.v1` | Practice runs, grading, attempts and scheduling policy |
| Generation | `generation.v1` | Authored candidates, independent review and publication into an existing deck |
| Audio | `audio.v1` | Transcription/live recording operations and optional publication integrations |

The full installation retains system and transition contexts for snapshots, existing host routes, coaching, teaching, oral practice, notebooks and workflows. Existing action bodies have moved into their owning context directories. A private compatibility kernel retains shared legacy helpers and historical transaction rules while the new APIs use scoped ports. Extensions must use public APIs rather than importing this kernel or another context's operation tables.

## Independent plugin loading

The workbench is the default package entry. Independent entries are exported as `./plugins/runtime`, `./plugins/materials`, `./plugins/bank`, `./plugins/study`, `./plugins/generation` and `./plugins/audio`. The GitHub alpha also includes a separate installer archive for each entry.

```js
import * as materials from '@ericwang1358/dsh-daily-flashcard/plugins/materials';
import * as bank from '@ericwang1358/dsh-daily-flashcard/plugins/bank';

ctx.plugin(materials);
ctx.plugin(bank);
```

Each plugin acquires its contribution to the shared `studyRuntime` service. Reference ownership prevents duplicate service/tool registrations when standalone plugins and the workbench are installed together, including separately installed copies. Unloading the last owner removes that contribution and its tools; its durable library records remain.

Read operations do not require a model. Discover available operations before invoking a model-backed feature:

```js
ctx.inject(['studyRuntime'], async c => {
  const api = c.studyRuntime.forLibrary(absoluteLibraryPath);
  const contracts = api.describe();
  const capabilities = api.capabilities(requestServices);
  const result = await api.invoke('bank.v1', 'get', { deckId }, requestServices);
});
```

Request services carry model completion, language, cancellation and notification context. They are not persisted in domain records. The `runtime.describe` and `runtime.capabilities` routes expose contracts and current availability to the UI and agents. Compact domain tools use typed arguments; the existing `study_workspace` tool remains a transition entry.

## Document-to-deck flow

1. `materials.document.import` receives one absolute file path or uploaded `dataBase64`, plus a filename or format. Originals are limited to 8 MB per file. Text files use UTF-8.
2. `materials.document.get` returns document/revision identity, projected source IDs and an original preview descriptor. `materials.document.bytes` supplies verified original bytes for the standalone preview.
3. `materials.selection.resolve` verifies visible `quote`, optional `prefix`/`suffix`, source/document identity, revision and optional offsets/PDF page. It reports `resolved`, `ambiguous`, `stale` or `missing`.
4. `materials.selection.ask` answers from the checked passage and nearby source evidence when a request model is available.
5. `generation.selection.supplement` requires a resolved `selection`, existing `deckId`, stable `operationId`, `expectedVersion`, and optional `count`, `kind` and `focus`. It authors, independently reviews and appends accepted questions.
6. `materials.links.list` derives associations and current explanations from committed card JSON. A passage may link to multiple cards across decks.

```js
const selected = await api.call('materials.selection.resolve', {
  documentId, revision, quote, prefix, suffix,
});
const destination = await api.call('bank.get', { deckId });
const result = await api.call('generation.selection.supplement', {
  selection: selected.selection,
  deckId,
  expectedVersion: destination.version,
  operationId: crypto.randomUUID(),
  count: 3,
  kind: 'flashcard',
}, requestServices);
```

The append transaction checks the destination version and material evidence while holding the library lock. It preserves existing card IDs and progress, appends new cards with additive `selections` metadata, and records a receipt once. Replaying an already committed operation returns its receipt even if the document subsequently changes. Reusing an operation ID with different content is rejected.

Failed reviews retain authored candidates. Conflicting commits retain approved cards. Inspect `generation.selection.get`; use `generation.selection.review` to repeat an independent review, or `generation.selection.commit` with a newly read destination version to retry publication. Neither path authorizes unchecked additions or silently retargets an outdated source selection.

## Preview integration

The workbench opens retained originals through DSH's public `sidebarRight.openResource` file resources and contributes learning actions to `sidebar.right.tab.document.actions`. Focused-target identity binds a captured selection to its current document tab.

DSH's built-in HTML preview uses a sandboxed frame. An optional inert **Study HTML** renderer supplies selectable HTML and passage marks through the public preview registry. The original renderer remains selectable in DSH. The workbench's own document view renders Markdown tables, sanitized HTML and TXT with passage marks; PDF shows its retained original and a clearly labelled selectable extracted-page view. Native PDF/Markdown/TXT keep the host viewer.

HTML scripts, event handlers, embedded browsing, forms and external resource loading are removed from the study renderer. Selection validation uses source evidence rather than trusting rendered DOM text alone.

## Storage and existing users

The existing atomic, content-addressed v3 shard store remains. Contexts register collection descriptors without editing the core field list. Unknown extension shards, scalar values and older manifest arrays survive reads and unrelated writes, including when their plugin is absent.

Supported older libraries normalize missing collections on read and upgrade during a later write, retaining a pre-upgrade backup. Old sources/decks may lack optional document or question metadata and remain usable. `materials.enrich` fills missing deterministic values and reports facts it cannot establish.

Original files live at library-relative `attachments/materials/<sha256>.<format>` paths. Document revisions retain historical source IDs and evidence. Opening an old retained path preserves its actual revision. A new projection does not overwrite old citation text.

Old PDF imports that discarded originals remain available as extracted text. Attach an actual original explicitly to gain an original preview. Full library exports with retained documents include a verified portable attachment bundle; restoring into a fresh library restores the original bytes as well as JSON and associations.

## Adding a capability

```js
const dispose = api.register({
  id: 'annotations', version: 1,
  collections: [{ name: 'annotations', mode: 'item' }],
  dependencies: ['materials.v1'],
  operations: {
    list: {
      input: { type: 'object', additionalProperties: false },
      description: 'Read saved annotations.',
      execute: async (_args, context) => ({
        annotations: (await context.state.read()).annotations,
      }),
    },
  },
});
```

`context.state` reads detached owned data and merges only declared fields on update. Dependency calls must be declared. Domain handlers receive no whole `Store`. Plugins may register their own typed DSH tools and UI contributions against these APIs and release registrations through Cordis lifecycle ownership.

For multi-context commits, register a read-validation participant with owned fields. Public invocation arguments contain data, never raw transactions or another context's mutable state. Treat durable schema changes separately from optional model-assisted enrichment.

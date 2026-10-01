# StudyHub 2.0 Alpha architecture

Question decks remain JSON. Materials retain their original PDF, Markdown, HTML or TXT files and expose versioned text projections. The workbench composes separately loadable capability plugins.

## Contexts and public APIs

| Context | API | Responsibility |
| --- | --- | --- |
| Runtime | `StudyRuntime` / `studyRuntime` | Registration, owned persistence ports, request services, transactions, capability discovery and disposal |
| Materials | `materials.v1` | Original files, source projections, exact selections and grounded questions |
| Bank | `bank.v1` | JSON decks/drafts, card content, idempotent additions, material associations and a narrow schedule update port |
| Study | `study.v1` | Practice runs, grading, attempts and scheduling policy |
| Generation | `generation.v1` | Authored candidates, independent review and publication into an existing deck |
| Audio | `audio.v1` | Transcription/live recording operations and optional publication integrations |
| Authoring | `authoring.v1` | Publication and deck relocation transactions across content and study records |
| Learner | `learner.v1` | Learner profile, coach letters, feedback and prepared practice records |
| Workflow data | `workflow-data.v1` | Workflow templates and sessions |
| Skeleton data | `skeleton-data.v1` | Topic skeletons and groups |
| Notifications | `notifications.v1` | Inbox records and read markers |
| Notes | `notes.v1` | Article drafts, references and publication metadata |
| Recording | `recording.v1` | Conversation capture and ingest sessions |
| Coach | `coach.v1` | Coaching and prepared-practice workflows |
| Workflows | `workflows.v1` | Workflow editing, teaching, practice and guidance |
| Skeleton | `skeleton.v1` | Topic outline editing and generation |
| Jobs | `jobs.v1` | Public background job inspection, messages and cancellation |
| System | `system.v1` | Settings and focus |
| Library | `library.v1` | Workspace snapshots, administrative backups and cross-domain presentation |

The compatibility `StudyService` facade delegates to the same public runtime operations. It has no inherited kernel or mixed-in domain methods, and domains never receive the facade or the unrestricted store. Shared pure functions remain ordinary modules; splitting every helper is not a goal. Mutable work belongs to one runtime, with named service projections supplied to the domains that need them.

Public compatibility actions can declare a higher-priority alias for an installed aggregate provider. For example, materials alone answers `materials.links.list` with an unavailable bank state; adding bank selects its authoritative link query, and unloading bank restores the materials fallback. `source.import` and `source.courses.set` similarly use library aggregation when available. Qualified domain operations retain their own implementations, and internal calls still require declared dependencies and grants. Equal-priority aliases remain registration conflicts.

The dependency graph is acyclic. Settings, notifications and data owners form the bottom layer; bank reads material evidence; study reads bank data; authoring coordinates content and referential updates; generation uses authoring publication; audio can invoke generation. Library supplies presentation joins. `lib/runtime/domain-contracts.js` declares each dependency, exact operation grants and per-action write sets. Cross-context transactions use named participants under one storage lock. ESLint and `tests/architecture-boundaries.test.mjs` inspect actual imports and runtime declarations, rather than an illustrative graph.

The former transition responsibilities have lasting owners: coach and prepared practice → coach/learner; article drafts → notes; conversation capture and ingest → recording; learning flows → workflows/workflow-data; outlines → skeleton/skeleton-data; oral practice → study. Snapshot/inbox presentation and administrative backups belong to library. The transition container and legacy authority are removed.

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

`context.state` reads detached owned data and merges only declared fields on update. Dependency calls must be declared; built-ins also declare exact operation grants. Domain handlers receive no whole `Store`. Plugins may register their own typed DSH tools and UI contributions against these APIs and release registrations through Cordis lifecycle ownership.

For multi-context commits, register a read-validation participant with owned fields. Public invocation arguments contain data, never raw transactions or another context's mutable state. Treat durable schema changes separately from optional model-assisted enrichment.

## Background work and ownership

Third-party operations receive the same formal task service as built-ins:

```js
execute: (_args, context) => context.work.start({
  key: 'refresh-index', queue: 'index', label: 'Refresh index',
}, async ({ signal, progress }) => {
  signal.throwIfAborted();
  progress({ stage: 'Reading', done: 0, total: 1 });
  const result = await buildIndex({ signal });
  signal.throwIfAborted();
  return result;
})
```

`start/get/list/wait/cancel` provide deduplication, FIFO, progress and detached results. Scopes include both the domain and work owner. Default queues are isolated by those identities; completed history is limited to 100 tasks. Respect the supplied signal in long operations. Domain unload aborts that domain's tasks; host unload cancels only its work. Captured state callbacks cannot commit after their context or host owner is removed, including when the same context ID is registered again.

One host/library reuses one runtime across requests and compact domain tools. Request facades retain separate model routes and notifications. Sibling hosts can share installed capabilities without losing their own jobs when another workbench unloads. Live sessions, uploads, assist task histories, reusable teachers and panel bridges have explicit owners. Resume reconstructs upload paths from validated checkpoints rather than granting ownership to copied handles.

## Storage hot path

`Store.update(fn, changed, fields)` accepts an optional read/write projection (`fields` as an array, or `{ reads, writes }`). Current-format scoped transactions decode their declared inputs, reuse unmodified collection shards and commit one atomic manifest. Older-format writes retain full migration and backup behavior. Cold loads still validate all shards and damaged libraries remain write-protected.

Transactions borrow the store's private working draft rather than cloning entire histories repeatedly. Read-only fields retain mutation checks; returned API objects remain detached. Shard reuse metadata comes from the committed working draft, not mutable cached readers. The existing append-only attempt hint and run-ID hint remain on review operations. Full unscoped updates preserve their historical semantics.

`scripts/benchmark-store.mjs` measures scoped storage writes; `scripts/benchmark-study.mjs` measures actual `review.answer` with 5,000 cards and 50,000 attempts, excluding run preparation and verifying distinct attempts are saved. Performance figures and methodology are recorded with validation evidence.

## Frontend modules

The native entry activates the workspace and document contributions, then optional views use seven real lazy-loading boundaries. `scripts/build.mjs` emits sibling `lib/client.<name>.js` classic factories through DSH's official `require.async` chunk protocol. All chunks use the host's React instance. Live recording remains mounted when navigating between views.

The standalone preview retains its `app.js`/`app.css` contract; the static demo uses ESM chunks. The loader test executes actual feature importers and checks native preview/selection registrations. Generated chunks are packaged and ignored in source control; authored boundaries live under `ui/`.

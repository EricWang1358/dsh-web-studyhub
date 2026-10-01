# StudyHub context boundaries

## Goal

Finish the architecture correction requested for a55edee: remove the shared legacy kernel, enforce independently loadable contexts and directed API dependencies, migrate every transition responsibility, split the frontend source/build boundaries, and remove five obsolete root installers. Preserve JSON, old data and all existing learning/audio behavior.

## Requirements

- R1: No context imports legacy-kernel, a replacement omnibus kernel, mutable process-global work maps, a foreign context's private implementation, or raw unrestricted storage. Work state and cancellation/lifecycle ownership belong to runtime-scoped services. Different runtimes do not leak jobs, queues or controllers.
- R2: Cross-context operations use scoped ports. Dependencies name the APIs actually consumed and form an acyclic graph, including removal of bank↔study and materials↔generation. Undeclared calls fail even if the target is installed. Atomic publication and existing replay/cancellation rules remain intact.
- R3: StudyService remains an external compatibility facade that delegates to APIs. No inheritance/mix-in of an all-domain kernel, no ambient this authority for handlers, and no audio mutation of a kernel object.
- R4: Inventory every transition action, assign it to a named lasting domain, preserve its alias/behavior, and remove transition and its registration entirely. Move helper logic to its owning domain rather than another miscellaneous container.
- R5: Every lasting context has an isolated load/read/write or meaningful operation smoke, including capability denial and unavailable optional dependencies. Test same-root distinct runtime isolation and plugin disposal without cancelling a sibling owner.
- R6: lib/client.js is generated. Split authored frontend responsibilities and generated distribution at real module boundaries, preserving the DSH classic loader contract, one host React instance, native preview and standalone preview/demo behavior. Do not hand-edit generated bundles or merely move the same bundle into another file.
- R7: Remove the five obsolete root tgz files and prevent future root installer commits. Confirm their actual Git status rather than assuming they were tracked. Build/release outputs remain in output and installable.
- R8: Lint enforces forbidden imports. Architecture tests measure forbidden edges and actual dependency cycles, not just file sizes. Existing tests are preserved/strengthened; full lint/test/build and installer smoke pass. New regressions have witnessed red/characterization evidence.

## Implementation units and ownership

### U1: Backend boundaries

Dependencies: committed a55edee baseline. Own lib except generated frontend artifacts, backend tests explicitly scoped by the coordinator. Implement R1–R5, including runtime services, scoped ports, data ownership and transaction participants, domain helpers, transition migration and external facade compatibility. Report an explicit action migration/dependency map and evidence. Backend interfaces are one unit because changing shared ports and callers independently would collide.

### U2: Frontend boundaries

Dependencies: committed a55edee baseline; independent of U1 API internals because public action names remain stable. Own ui, scripts/build.mjs, scripts/build-demo.mjs, generated frontend lib files, and frontend build tests. Implement R6. No backend changes, installs or shared build outputs during the parallel wave. Root performs authoritative builds and browser verification.

### U3: Enforcement and artifacts

Dependencies: boundary contracts inspected; final checks depend on U1/U2. Coordinator owns eslint.config.js, .gitignore, root obsolete archives, architecture enforcement tests and docs/architecture.md. Implement R7/R8, characterize/red-test existing forbidden edges before implementation, and record the migration and verification evidence.

## Verification contract

1. Inspect every actual import, scoped invocation and state adapter. No implicit whole-state authority or renamed kernel is an acceptable substitute.
2. Test installed and missing targets, reject undeclared cross-domain calls, exercise each context without the workbench, demonstrate same-root separate runtimes and correct unload cancellation ownership.
3. Preserve existing JSON/progress/unknown fields, selection and supplemental append, replay, source version checking, audio checkpoint/cancellation, teacher/follow-up, coach, notes, mistakes and oral workflows.
4. Run full npm run lint and npm test, native/preview build and static demo build. Explain environment-specific skips and exercise skipped relevant paths locally.
5. Inspect native and standalone UI after frontend changes, at desktop/mobile widths. Verify generated frontend modules resolve without a second React and archives include all required assets.
6. Complete simplification and independent code review against these requirements before final delivery. Re-audit all eight requirements from current source and runtime evidence.

## Scope and settled decisions

User-directed: retain JSON and old-user data compatibility; plugins are independent and composable; API boundaries isolate implementation; all six review issues are in scope. Published v2.0.0-alpha.1 tag/assets are immutable. Existing unrelated .claude, scripts/site-*, site and videos files are excluded. Do not narrow completion to file extraction, smoke-only success or a future migration promise.

## User clarification during implementation

The user subsequently prioritized performance and extensibility over splitting every shared implementation. Pure shared functions are acceptable; file count and eliminating a filename are not success metrics. Runtime state must still belong to one instance, and capabilities must remain explicit. Audio, generation, coach and notes retain their business workflows; the common work service provides task lifecycle, progress, cancellation, queueing and deduplication for built-in and third-party plugins.

The storage optimization adds an explicit transaction field projection while retaining unscoped full-state updates for compatibility. Measure a fixture of 5,000 cards and 50,000 attempts before and after. Tests must demonstrate no unrelated decoding on scoped writes, preservation of absent plugin data, rollback, retained-object isolation, legacy migration and concurrent writers. Do not remove protective clones or replace mutation permission checking with reference equality without evidence that nested mutation still cannot cross a boundary. Schema compilation is deferred unless measurement identifies validation as a material cost.

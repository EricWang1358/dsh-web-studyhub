# S1-0 isolated DSH host probe

Manual audit fixtures for StudyHub 2.6.0 at aa0259254bcd587128e583070599a804485c7d06 and DSH 0.2.0-rc.2. They do not participate in npm test or modify production code. The runner reuses a private profile provisioned by scripts/qa/dsh-e2e.mjs and pins that driver source hash before adapting it in memory.

## Run

From the isolated worktree, provision the rc.2 CLI and private QA profile using the existing repository QA workflow. Then run:

```powershell
$taskRoot=(Get-Location).Path
node tests/fixtures/runtime-s10/run-host-probe.mjs --repo $taskRoot --dsh-bin "$taskRoot/output/runtime-s10/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js" --out "$taskRoot/output/qa/host-s10-jobs-preset" --variant official-jobs-preset --port 3491 --model-port 4495 --lang zh
```

Use free ports and a new output directory for each variant: the runner replaces only its named directory strictly inside output/qa. Paths overlapping the private profile, workspace, temporary files, packages or supplied SDK are rejected before the driver runs; existing junctions are resolved before checking. The existing private profile/default preset stays unchanged. For the preset-free refusal use --variant bare and a distinct --out. Credential and redirect variables are scrubbed, TEMP/TMP and DSH_HOME stay private, parent/child tools are restricted to empty schemas, and model routes use the repository local fake endpoint.

## Captured results and composition boundary

On 2026-10-05 the preset-free baseline passed genuine parent/session/scope, direct stream with adapter-reported usage 17/12, unsupported-effort rejection, one-shot child label/lineage and lifecycle, repeated disposal, and cleanup. Owned job start refused with: background jobs unavailable: no job controller serves this agent. Results remain at output/qa/host-s10.

The official-jobs-preset run passed all five steps, with 4 local fake requests and zero page/console errors. It also proved owner and callerless denial, observer timeout preserving the producer, running→stopping→killed, cancel/settled once, and owner disposal removing the job/agent/session while releasing its effect once. Results remain at output/qa/host-s10-jobs-preset.

The official rc.2 source explains the difference:

- dsh-web-app/cordis.patch.yml:455–467 disables host-plane tool-jobs; the job registry remains installed.
- dsh-web-app/presets/standard.patch.yml:35–36 includes official tool-jobs; the default registry preset is standard (cordis.patch.yml:562–565).
- dsh-api-session-controller/lib/index.js:358–369 explicitly calls presets.mount during web-agent creation. Bare agents.create omits this setup.
- dsh-tools/lib/index.js:2895–2909 and 2944–2973 filters inherited tool visibility; it does not detach controller layers. dsh-jobs-local/lib/index.js:543–545 checks controller availability separately.
- dsh-tool-jobs/lib/index.js:256 attaches its own controller in normal plugin apply.

The second variant declares a separate s10-jobs-only preset with installed official dsh-tool-jobs and quiet completion delivery. It mounts through the official preset registry, never calls attachController by hand, forces native tool mode, and asserts empty parent/child schemas. Reports label controllerLoadedByTestVariant=true. Probe work starts after its injection callback returns so preset audit does not await its own activation.

## Limits

- Companion root and genuine agent scopes were measured; the production StudyHub fiber was not intercepted. A green explicit composition does not prove all configured presets have controllers.
- Server uiWorkspace absence is informational: browser openSession, navigation permissions, sidebar child visibility and full P0 console workflow remain unverified. The screenshot proves host/StudyHub loading.
- Continuable children, held-request cancellation, unloading, provider errors/internal retries, shared 429/RPM policy, ledger deduplication, crash recovery, notification redelivery and crash durability remain outside these assertions.
- Fake usage is adapter-reported; real-provider quality, billing and price were not measured. S1-0 owner approval and S1-1 through S1-7 remain separate gates.

The scripts were syntax-checked and the official variant executed by the integration agent. Detailed versions, commands, baseline failures and review status are recorded in docs/plans/unified-job-runtime/s1-0-baseline.md and s1-0-dsh-capabilities.md.

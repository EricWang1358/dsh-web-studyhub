## Agent-Native Architecture Review

### Summary

This app has agent integration through typed domain tools, runtime capability discovery, and the full plugin’s generic `study_workspace` tool. The domain migration retains a shared workspace and explicit operation routing. The two new audio workflows remain accessible through the full plugin’s generic tool, but are absent from the standalone audio plugin’s typed tool.

### Capability Map

| UI Action | Location | Agent Tool | Discoverable? | Priority | Status |
|---|---|---|---|---|---|
| Import timestamped subtitles | `ui/AudioImport.jsx:404` | Generic `study_workspace`; missing from `study_audio` | Runtime discovery lists operation | Must have | Full plugin only |
| Review uncertain corrections | `ui/document-preview/DocumentViewer.jsx:101` | Generic `study_workspace`; missing from `study_audio` | Runtime discovery lists operation | Must have | Full plugin only |
| Inspect audio jobs/results | `ui/AudioImport.jsx` | `study_audio` | Typed operation list | Should have | Accessible |
| Follow material question links | `lib/runtime/tools.js:43` | `study_materials` | Typed operation list | Should have | Accessible; uses authoritative alias |

### Findings

#### Warnings (Should Fix)

1. **[P2] Expose new audio workflows through the standalone tool** — `lib/contexts/audio/operations.js:121` and `:138`; registry omission at `lib/runtime/tools.js:25–27`. Confidence: **75**.

   Motivating new operations:

   ```js
   "audio.subtitles.import": async function (a) {
   "audio.corrections.review": async function (a) {
   ```

   The registered audio tool still declares:

   ```js
   operations: ['results', 'result.get', 'jobs', 'job.wait', 'job.cancel', 'audio.settings.get', 'audio.import', 'audio.retry', 'live.list', 'live.get', 'live.save'],
   ```

   `lib/plugins/audio.js:4` installs only the audio context. Its available domain tool therefore advertises neither new operation, and lacks the required subtitle `filename`/`text` and correction-review `sourceId` parameters. `study_capabilities` can describe these operations but cannot invoke them. The generic escape hatch is registered separately in `lib/index.js:236`, so its availability in the full plugin does not restore standalone audio parity.

   **Suggested fix:** Add both operations to `study_audio`, including `filename`, `text`, and `sourceId` parameters, and expose the supported subtitle metadata parameters. Update its description to explain subtitle import and correction review. Verify the standalone audio plugin can invoke both workflows using its registered tool.

   Classification: secondary interaction between newly added workflows and the existing tool registry. Not a pre-existing finding. Owner: downstream resolver; manual fix; verification required.

#### Critical

None.

### What's Working Well

- Domain tools resolve the same library used by the application.
- Capability discovery reflects installed contexts.
- Material-link reads now follow the public alias, allowing the authoritative bank provider to supply current question data.
- The full plugin’s generic tool preserves access to the new operations.

### Score

- **2/4 reviewed capabilities accessible through the applicable standalone typed tools; 4/4 through the full plugin.**
- **Verdict: NEEDS WORK** for standalone audio parity.

No additional supported residual risks. Verification was read-only; no runtime tests were executed.

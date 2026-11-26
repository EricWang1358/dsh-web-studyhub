# Private sync relay and client

Start the relay with its own randomly generated bearer in `STUDYHUB_SYNC_TOKEN` (at least 32 characters) and its storage directory in `STUDYHUB_SYNC_DATA_DIR`. The packaged relay accepts `java --enable-preview -jar <relay.jar>`. It defaults to loopback port 8080. Configure `--server.address` and TLS or a TLS reverse proxy to serve a remote desktop. `GET /actuator/health` is available to the deployment health probe.

Each desktop sets its own `STUDYHUB_SYNC_DB` (SQLite filename) and `STUDYHUB_SYNC_DEVICE` (stable local identifier). Both use the same `STUDYHUB_SYNC_VAULT` (UUID), `STUDYHUB_SYNC_URL`, relay token and `STUDYHUB_SYNC_KEY` (base64 of a separate, randomly generated 32-byte AES key). Supply that encryption key to the clients only. The relay stores operation IDs, sequence numbers, packet sizes and ciphertext. One bearer controls all vaults in this private deployment.

Run client commands with `java --enable-preview -jar <exec.jar> --studyhub.mode=sync-client` followed by one of these arguments.

| Command | Result |
| --- | --- |
| `attempt <library> <course> <card> <grade> <operation-uuid> [ISO-instant] [zone-id]` | Records a 0–5 native review offline. A retry with the same UUID reuses the first-issued time, zone, and settings for any omitted values. A conflicting explicit value fails. |
| `correct <library> <course> <card> <attempt-uuid> <grade> <operation-uuid>` | Replaces the effective native grade and replays later reviews in order. The original grade stays in history. |
| `undo <library> <course> <card> <attempt-uuid> <operation-uuid>` | Voids the named native review and replays the other active reviews. The void remains in history. |
| `show <library> <course> <card>` | Reads the active attempt IDs, history with original and effective grades and the winning correction/undo IDs, metadata and FSRS state. |
| `sync` | Pushes pending ciphertext, then pulls and commits remote pages. |
| `watch` | Performs an initial sync, follows WebSocket notifications and catches up on reconnect. |
| `backup-put <export.json>` | Stages and sends a complete Node-format library export and prints its immutable backup ID. The local spool and receipt support retry. |
| `backup-list` | Lists the backup IDs visible in this vault. |
| `backup-get <id> <new-file.json>` | Verifies and materializes the exact exported bytes at a new path for the existing StudyHub restore flow. |

The Java review journal replays immutable attempts with their issued time zone and settings. Metadata updates and explicit delete/restore each use a hybrid-clock register. The Node UI owns its separate live shard store. Its backup transfer preserves adjusted grades, voided attempts, foreign fields, and course/deck IDs as recorded. A Node export lacks a reliable per-answer history of the original scheduling settings, including changes to focus boost. Restoring the snapshot through StudyHub preserves those recorded results.

Native correction keeps the original answer's time, zone, settings and position. Among concurrent corrections, the maximum hybrid-clock stamp wins, with operation UUID as the final tie-breaker. Any undo permanently excludes that target from scheduling. A local command requires an active native target in the same vault, library, course and card. A remote compensation can arrive before its target. When the target arrives it takes effect only in the matching scope. Every immutable operation remains in the encrypted journal.

The desktop Node action `review.undo` checks the latest eligible grade in an open round and restores its saved state, including eligible implicit prerequisite credit. Node's rubric and cloze adjustment paths preserve the original grade and can reschedule at the adjustment timestamp. Their immutable desktop-history manifest carries those recorded outcomes. Native commands apply only to reviews issued into the Java journal.

A SQLite journal containing only v1 operations remains readable by the previous client. Its first native undo, correction or desktop-attempt manifest upgrades the file for every vault it contains, in the same transaction as the ciphertext and cursor. Opening that journal requires an updated client. An already-running v1 reader also loses access to the old table names on its next transaction. On the relay the AES envelope stays at v1 and is opaque. A previous client pulling an unsupported operation fails before committing that page. All devices in a vault should upgrade before issuing these operations.

The relay accepts binary AES-256-GCM packets at `PUT /sync/v1/vaults/{vault}/ops/{id}`. Replaying identical bytes returns the original sequence. A conflicting packet for the same identity returns HTTP 409. `GET .../ops?after=<seq>&limit=<1..64>` returns ascending rows. The authenticated `.../events` WebSocket sends `ready` and cursor notifications. CAS chunks use `HEAD/PUT/GET .../chunks/{sha256}` with the hash of the encrypted packet. Remote clients use HTTPS and attach the bearer in the authorization header, including for the WebSocket handshake.

## Desktop history from a Node library

Set `STUDYHUB_SYNC_DB`, `STUDYHUB_SYNC_DEVICE`, `STUDYHUB_SYNC_VAULT`, `STUDYHUB_SYNC_KEY`, `STUDYHUB_SYNC_URL` and `STUDYHUB_SYNC_TOKEN` as described above. Run the desktop with `--studyhub.desktop-history.enabled=true`, `--studyhub.desktop-history.library=<logical-id>` and `--studyhub.desktop-history.root=<absolute-library-directory>`. Select the same logical ID on both devices. Each device binds that ID to its own directory identity. Check `GET /api/sync/desktop-history/status` for separate capture and relay outcomes. The optional `studyhub.desktop-history.interval-ms` defaults to 5000.

Send the local desktop's `X-Study-Token` to these endpoints. `GET /api/sync/desktop-history?after=0&limit=64` returns revision IDs, the originating device and local observation time, a stable source key and a preceding revision when available. Follow `next` while `more` is true, including for a page with no matching entries. `GET /api/sync/desktop-history/{revision}` returns the entire original `attempt` and its available deck/course scope. A receiving peer verifies and caches large encrypted records before advancing its cursor.

The Node Store owns the live library, including its run, feedback and due dates. History captures observed committed states. For example, an answer and undo before the next scan can first appear together in an already-voided record. Missing records do not imply a deletion. Independent changes on different devices remain available for inspection. If a source directory is replaced, choose a new logical library or explicitly bind a fresh replica after checking the source.

## WP-S5 verification

### Native attempt commands, pre-implementation checks

The Node sources `undo-ops.js`, `grading-ops.js` and `operations.js` keep voided attempts and original grades. They also own run eligibility, cloze equivalence, prerequisite credit, retries and stale questions. The native command concerns an explicitly identified native review in one vault, library, course and card. Its immutable journal supplies both the FSRS projection and the encrypted outbox. A retry must reuse every omitted first-issued input after a crash or a settings change. Tests must exercise old readers, a late target, concurrent corrections, permanent undo, differing scopes and rollback of a whole unsupported page. These checks cover C18, C20, C35, C38, C39 and C58.

Before implementation, C18/C20/C51 require immutable attempts, deterministic replay in recorded time zones, encrypted client packets durably journaled before network I/O and no silent overwrite on ID collisions. C58 binds vault, library, course and card identities. Tombstones survive delivery in reverse order. C38 requires rejecting a future packet version before advancing a cursor. C03/C36 use independent temporary replicas with fixed clocks skewed by five minutes and a real loopback HTTP/WebSocket server.

The Windows JDK 21 module gate ran a real Spring relay, two temporary SQLite replicas, and 100 offline answers per device. After REST catch-up both replicas held identical attempt lists, FSRS state, tombstone and LWW metadata. The test also exercised WebSocket authentication and notification, ciphertext corruption, future wire versions, replay after restart, partial chunk resume and exact Node Store restoration. A second smoke ran the packaged Java processes with `node src/test/resources/packaged-sync-smoke.mjs <exec.jar> <relay.jar>`. A Windows JVM client and Linux container JVM client also converged on two independent reviews through a Linux Docker relay.

The native review gate ran six sync integration tests and three FSRS tests on Windows JDK 21. It raced two independent SQLite writers, retried through a separate JVM with different first-issue defaults, replayed offline compensations through a real relay, and read a captured v1 ciphertext fixture. Set `-Dstudyhub.previous-sync-jar=<previous-exec.jar>` to also run the previous binary. The 0.1.0 executable read a newly written v1 attempt and refused a v2 journal. Its relay client rolled back a page containing both versions; the upgraded client then caught up from cursor zero. An authenticated fractional or unsupported operation version also rolls back the page.

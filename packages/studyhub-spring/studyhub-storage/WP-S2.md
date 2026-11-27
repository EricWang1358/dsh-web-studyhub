# WP-S2 verification

## Before implementation

- C02, C21, C37, C50. The reference scheduler is `lib/sm2.js` with the pinned `ts-fsrs@5.4.2`. Replay grades 0–5, fresh and previously answered cards, failures, recovery, same-day passes and reviews across local midnight. Carry the learner's time zone and explicit scheduling settings with the history.
- C46, C58. Fit only recorded review outcomes. Scope storage keys by library, collection and record identifier. Test two libraries with the same record ID.
- C18, C20, C22, C51, C38. This checkout's Node Store writes JSON shards. Exchange its complete exported object through a separately selected SQLite database, keeping opaque fields and original payload bytes. Exercise Node Store restoration into a test-owned second directory. Before migration or write, refuse a foreign or future database without changing its contents.
- C03, C31, C36. Generate seeded cross-language trajectories at test time, test real independent SQLite readers, compare exact counters, intervals and instants and bound floating-point errors. Use temporary directories, explicit time zones and a fixed review clock.
- C42. WP-S2 owns the domain scheduling and storage packages. Synchronization owns its separate domain namespace. No release or installation occurs in this module gate.

## Module gate

`mvn -pl studyhub-domain,studyhub-storage test` passed on Windows x64, Oracle JDK 21.0.4 and Node 22.22.3. The independent oracle replayed 14,000 reviews in 1,000 histories against ts-fsrs 5.4.2 with maximum absolute stability/difficulty error 0. The same inputs also matched StudyHub counters, intervals and due dates in UTC, Shanghai and New York. The fitter adjusts four initial stabilities and decay using bounded L-BFGS on recorded cross-day outcomes.

The storage tests ran 200 concurrent records across two writer pools, verified failed transaction rollback, streamed and deduplicated SHA-256 blobs, rejected foreign/future SQLite files without changing their main file bytes, and exercised the Node Store export/restore path through a new SQLite file. This module targets deterministic scheduling. The compatibility host continues to own optional interval fuzz and the live Node shard store. Shipping-channel and Linux installation checks belong to WP-S6.

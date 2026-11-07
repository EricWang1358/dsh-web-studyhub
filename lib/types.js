// @ts-check
/* THE SHAPES THAT CROSS MODULES (#749).

   Types only: nothing here is exported at runtime, so no bundle grows and no module gains an import. A checked module names a shape in its
   own JSDoc, as `import('./types.js').JobContract` in a @typedef line, and `npm run typecheck` then checks how it uses it.

   A shape belongs here when two modules pass it to each other. One module's own data stays in that module's JSDoc, and a field a producer
   does not promise is left out or kept as `Record<string, any>`, so this file never claims more than the code keeps.

   The three that matter most:
     LibrarySnapshot     what `snapshot` answers (lib/contexts/library/operations.js), read by every page as `data`
     JobContract         one background job in the public shape (lib/job-contract.js, docs/job-contract.md)
     StudyActionPayload  one action of the panel's transport (ui/transport.js -> lib/host.js) */

/** @typedef {'audio-import' | 'pdf-convert' | 'translation' | 'generation' | 'supplement' | 'draft-repair' | 'draft-publish' | 'coach-daily' | 'extension'} JobKind */
/** @typedef {'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'complete' | 'failed' | 'interrupted'} JobStatus */

/**
 * A stage of a job: `code` is what the interface translates, `args` are its values, `text` is the producer's own prose (a fallback only).
 * @typedef {Object} JobStage
 * @property {string} code
 * @property {Record<string, unknown>} [args]
 * @property {string} [text]
 */

/**
 * One segment of the progress bar (a question run's plan / blueprint / author / review, an audio import's steps).
 * @typedef {Object} JobProgressSegment
 * @property {string} stage
 * @property {number} done
 * @property {number} total
 */

/**
 * How far a job is. `total` and `percent` are null while the producer cannot know them, never a guess.
 * @typedef {Object} JobProgress
 * @property {number} done
 * @property {number | null} total
 * @property {string | null} unit
 * @property {number | null} percent
 * @property {JobProgressSegment[]} segments
 */

/**
 * Whether the learner may do one action to a job now, and why not when they may not.
 * @typedef {Object} JobActionState
 * @property {boolean} available
 * @property {{ code: string, [key: string]: unknown }} [reason]
 */

/**
 * A setting a running job accepts (a limit, a reasoning level): the console draws the control from it.
 * @typedef {Object} JobSetting
 * @property {string} key
 * @property {'int' | 'enum' | 'bool'} type
 * @property {number} [min]
 * @property {number} [max]
 * @property {unknown[]} [values]
 * @property {unknown} value
 */

/**
 * The five actions, as THIS job declares them: `pause.mode` says how (or whether) it may be paused, `set.settings` are its live settings.
 * @typedef {Object} JobActions
 * @property {JobActionState} cancel
 * @property {JobActionState & { mode: 'unsupported' | 'queued-only' | 'checkpoint', waiting?: { reason: string, count: number } }} pause
 * @property {JobActionState} resume
 * @property {JobActionState & { keeps?: 'completed' | 'nothing' }} retry
 * @property {JobActionState & { settings?: JobSetting[] }} set
 */

/**
 * One thing a job produced and left to open (a source, a draft, a deck, a document).
 * @typedef {Object} JobResultRef
 * @property {'source' | 'draft' | 'deck' | 'document'} kind
 * @property {string} id
 */

/**
 * What a job produced, and whether it is complete: `partial` means it stopped before everything it was asked for.
 * @typedef {Object} JobResult
 * @property {JobResultRef[]} refs
 * @property {'complete' | 'partial' | null} completeness
 */

/** @typedef {{ message: string, code?: string }} JobError */

/**
 * What a job used: every token of its calls, the provider's own counts (the console's 已用 and per-call figures), and the model calls it made.
 * @typedef {Object} JobUsage
 * @property {number | null} tokens
 * @property {Record<string, any> | null} tokenUsage
 * @property {number} calls
 */

/** @typedef {{ mode: 'direct' | 'subagent' | 'mixed' | null }} JobExecution */

/**
 * One model call of a job, in the shape the 任务 console's timeline draws (lib/job-calls.js). A time is present only when it was observed.
 * @typedef {Object} JobCall
 * @property {string} callId
 * @property {string} jobId
 * @property {string} [attemptId]
 * @property {string} stepKey
 * @property {string} kind
 * @property {string | null} [stage]
 * @property {number | null} [slot]
 * @property {string | null} [startedAt]
 * @property {string | null} [endedAt]
 * @property {string} [queuedAt]
 * @property {string} [firstOutputAt]
 * @property {string} status
 * @property {string | null} [runner]
 * @property {string | null} [childId]
 * @property {string | null} [parentId]
 * @property {number | null} [part]
 * @property {number | null} [parts]
 * @property {number | null} [round]
 * @property {string | null} [reasoning]
 * @property {number | null} [tokens]
 * @property {number} [outputTokens]
 * @property {Record<string, any>} [timing]
 * @property {number} [queuedMs]
 * @property {string} [file]
 * @property {string} [reason]
 * @property {string} [error]
 * @property {boolean} [reused]
 * @property {number} [retry]
 * @property {Record<string, number>} [counts]
 */

/**
 * A line of a job's log (lib/job-calls.js recordEvent): `code` and `args` are translated, `text` is prose the producer already wrote.
 * @typedef {Object} JobEvent
 * @property {string} id
 * @property {string} at
 * @property {'info' | 'step' | 'warn' | 'error' | 'done'} level
 * @property {string | null} tag
 * @property {string} code
 * @property {Record<string, any> | null} args
 * @property {string} [text]
 * @property {string} [file]
 */

/**
 * One background job in the public shape: what a consumer (the 任务 console, a compact card, an agent) may rely on, and nothing else.
 * @typedef {Object} JobContract
 * @property {number} contractVersion
 * @property {string} jobId
 * @property {string} [attemptId]
 * @property {JobKind} kind
 * @property {string | null} title
 * @property {JobStatus} status
 * @property {'user-cancel' | 'superseded'} [endReason]
 * @property {string} [continuedBy]
 * @property {JobStage} stage
 * @property {JobProgress} progress
 * @property {JobActions} actions
 * @property {JobResult} result
 * @property {JobError | null} error
 * @property {JobUsage} usage
 * @property {JobExecution} execution
 * @property {Record<string, any>} detail
 * @property {string | null} startedAt
 * @property {string} [finishedAt]
 * @property {JobCall[]} calls
 * @property {JobEvent[]} events
 * @property {string} [archivedAt]
 */

/**
 * A job as the snapshot carries it (lib/job-contract.js snapshotJob): the job's own fields, which only its kind's page reads, and its contract.
 * @typedef {{ contract: JobContract } & Record<string, any>} SnapshotJob
 */

/**
 * Progress of a deck, a topic or a focus topic: the counts are by mastery level, and `status` is the one word the catalogue shows.
 * @typedef {Object} ProgressRow
 * @property {number} total
 * @property {{ new: number, weak: number, learning: number, familiar: number, mastered: number }} counts
 * @property {number} mastery
 * @property {number} due
 * @property {'todo' | 'active' | 'done'} status
 */

/**
 * A deck's progress (lib/mastery.js deckProgress) with its topics in syllabus order.
 * @typedef {ProgressRow & { topics: (ProgressRow & { name: string })[] }} DeckProgress
 */

/**
 * A deck as the snapshot lists it: the row the catalogue and every deck picker read.
 * @typedef {{ id: string, title: string, due: number, count: number, archived?: boolean } & Record<string, any>} SnapshotDeck
 */

/**
 * A run the snapshot offers to carry on (lib/contexts/library/operations.js): its identity, its title and where it is.
 * `complete` is present only when the producer knows the run ended.
 * @typedef {{ id: string, complete?: boolean } & Record<string, any>} SnapshotRun
 */

/**
 * The library snapshot, which every page reads as `data`. A compact snapshot (an agent's) has the lean jobs and the fields marked
 * optional left out; a poll that nothing changed answers `{ unchanged: true, fingerprint }` instead, so a reader checks both.
 * @typedef {Object} LibrarySnapshot
 * @property {string} root
 * @property {number} revision
 * @property {Record<string, any>} settings
 * @property {boolean} experimental
 * @property {boolean} modelReady
 * @property {SnapshotJob[]} jobs
 * @property {SnapshotJob[]} [archivedJobs]
 * @property {Record<string, DeckProgress>} progress
 * @property {SnapshotDeck[]} decks
 * @property {SnapshotRun[]} runs
 * @property {Record<string, any>[]} sources
 * @property {Record<string, any>[]} drafts
 * @property {Record<string, any>[]} attempts
 * @property {Record<string, any>[]} courses
 * @property {Record<string, any>} today
 * @property {Record<string, any> | null} next
 * @property {Record<string, any>} coach
 * @property {Record<string, any>} inbox
 * @property {Record<string, any>} ingest
 * @property {string} [fingerprint]
 * @property {boolean} [unchanged]
 * @property {boolean} [partial]
 */

/**
 * What the panel sends for one action (ui/transport.js -> lib/host.js): the session that asks, the action's name and its arguments.
 * @typedef {Object} StudyActionPayload
 * @property {string} sessionId
 * @property {string} action
 * @property {Record<string, any>} args
 */

/**
 * The host's answer to one call (lib/host.js): `{ ok: true, value }` or `{ ok: false, error }` with a code the panel may act on.
 * @typedef {{ ok: true, value: any } | { ok: false, error: { code: string, message: string, details?: Record<string, any> } }} StudyActionResult
 */

export {};

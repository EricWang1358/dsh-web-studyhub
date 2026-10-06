import { RUNTIME_CONTRACT_VERSION, readJobContract } from '../../jobs/contract.js';
import { get, id } from "../../util.js";
import { jobCleanup } from "../../job-cleanup.js";
import { canContinueDraft, missingQuestions } from "../../draft-continuation.js";
import { jobCalls } from "../../job-calls.js";
import { checkAction, reasonText, kindOf } from "../../job-contract.js";
import { ARCHIVE, archiveRecordOf, jobArchive } from "../../job-archive.js";
import { isOwnRow } from "../../job-status.js";
import { KEEP_ENDED, OUTPUT_LIMIT } from "../../job-output.js";
import { coachDailyLedger, coachDailyJobs, coachDayId, dayOf } from "../../coach-daily.js";



/** jobs operations close over only the ports declared by this context. */
export function createOperations(ports, { cleanup = jobCleanup, archive: archiveOf = jobArchive } = {}) {
  const { state: storagePort } = ports;
  const { jobs, settled, generationMessengers, generationControllers, jobControls, jobOutputs } = ports.work;
  const { activeJob, publicJob, dropRetry, forgetRetry } = ports.jobServices;
  const archive = () => archiveOf(storagePort.root);
  const scopedJobs = () => [...jobs.values()].filter((j) => j.root === storagePort.root && (ports.runtimeJobs?.visible(j.id) ?? true));
  // A job is named by its own id or by what survives a retry (an audio batch's id); every attempt of it answers to the name.
  const matching = (list, wanted) => list.filter((j) => j.id === wanted || j.batchId === wanted || j.singleId === wanted || j.restoredArchive?.ids.includes(wanted));
  const lineage = (job) => job.restoredContract?.jobId || job.batchId || job.singleId || job.id;
  const newest = (list) => list.reduce((a, b) => (Date.parse(b.startedAt) >= Date.parse(a.startedAt) ? b : a));
  /* The ids a request names: `jobId`, `jobIds` (at most ARCHIVE.maxBatch) or, where `all` is allowed, all:true. */
  function requested(a, { all = false, name }) {
    const named = Array.isArray(a?.jobIds) ? a.jobIds.filter((value) => typeof value === "string" && value) : [];
    const single = typeof a?.jobId === "string" && a.jobId ? [a.jobId] : [];
    if ((all && a?.all ? 1 : 0) + (single.length ? 1 : 0) + (named.length ? 1 : 0) !== 1) throw new Error(`${name} needs ${all ? "jobId, jobIds (a list) or all:true" : "jobIds (a list of up to 100 ids)"}`);
    if (named.length > ARCHIVE.maxBatch) throw new Error(`一次最多处理 ${ARCHIVE.maxBatch} 个任务，请分几次来`);
    return { ids: [...new Set(named.length ? named : single)], all: !!(all && a?.all), single: single.length === 1 && !named.length };
  }
  /* A job leaves the library for good: its retry hold is released (with its cleanup), the working copy of an audio batch goes to the background cleanup
     (lib/job-cleanup.js) and a pre-manifest job's inbox letter, which is its only persisted record, is pruned before the reply. */
  async function removeLive(job) {
    // Queue permanent removal after any pending automatic archive write for this v2 history.
    if (job.restoredContract?.contractVersion === RUNTIME_CONTRACT_VERSION) await archive().remove(job.restoredArchive?.ids || [job.restoredContract.jobId, job.id]);
    dropRetry(job.id); jobs.delete(job.id);
    const batchId = job.batchId || job.singleId || job.restoredArchive?.files;
    if (batchId) await cleanup.dismissBatch(storagePort.root, batchId);
    if (job.legacy) await pruneLetters([job.id]);
  }
  const pruneLetters = (jobIds) => storagePort.update(s => { s.inbox = (s.inbox || []).filter(item => !(item.kind === 'audio-failed' && jobIds.includes(item.jobId))); });
  /* The files an archived record (or one that fell off the end of the archive) still holds go to the background cleanup. */
  async function releaseRecord(record) {
    if (record.files) await cleanup.dismissBatch(storagePort.root, record.files);
    if (record.legacy) await pruneLetters(record.ids);
  }
  async function dropEvicted(evicted) { for (const record of evicted) await releaseRecord(record).catch(() => {}); }
  const stillRunning = () => new Error("任务还在进行，请先停止或等它结束");
/* One day of 为你定制 (lib/coach-daily.js): pause today (no new batch starts; the one in flight finishes), resume, and the live settings (limits, reasoning).
   The same judge as every other job decides whether the action is allowed (checkAction on the day's row); nothing here stops a batch. */
async function coachControl(a) {
  const ledger = coachDailyLedger(storagePort.root), date = coachDayId(a.jobId), data = await ledger.read();
  const row = coachDailyJobs({ data, preparing: data.inflight.length > 0, state: {} }).find((item) => item.date === date);
  if (!row) throw new Error(`Study job not found: ${a.jobId}`);
  const action = a.action ?? (a.patch !== undefined ? "set" : undefined);
  if (!action) throw new Error("job.control needs an action: pause, resume or set");
  const verdict = checkAction(row, action);
  if (!verdict.ok) throw Object.assign(new Error(verdict.message), { code: verdict.code, capability: true });
  const done = (extra = {}) => ({ jobId: a.jobId, attemptId: a.jobId, action, ...extra });
  switch (action) {
    case "pause": await ledger.setPaused(true); return done({ paused: true, note: "今天不再开始新的一批；正在进行的一批会跑完。" });
    case "resume": await ledger.setPaused(false); return done({ paused: false, note: "已继续：新的一批会照常开始。" });
    default: {
      if (Object.hasOwn(a.patch ?? {}, "paused")) throw Object.assign(new Error("暂停和继续用 action: pause / resume，不是 set。"), { code: "unknown-setting" });
      return done({ applied: await ledger.patch(a.patch), note: "从下一批开始生效；正在进行的一批不受影响。" });
    }
  }
}
const handlers = {
"job.cancel": async function (a) {
      const scoped = scopedJobs();
      if (a.all && a.jobId) throw new Error("Use jobId or all, not both");
      if (!a.all && !a.jobId) throw new Error("Specify jobId or all:true to cancel this library queue");
      const targets = a.all ? scoped.filter((job) => activeJob(job) && job.type !== "draft-publish")
        : [get(scoped, a.jobId, "Study job")];
      if (targets.some((job) => job.type === "draft-publish"))
        throw new Error("发布检查正在进行，请等待完成");
      for (const job of targets) {
        const canonical = ports.runtimeJobs?.compatible(job.id);
        if (canonical) { await canonical.control(job.id, 'cancel'); continue; }
        if (!activeJob(job) || job.cancelRequestedAt || (job.status === "cancelling" &&
            generationControllers.get(job.id)?.signal.reason?.code !== 'GENERATION_BUDGET')) continue;
        const queued = job.status === "queued";
        job.cancelRequestedAt = new Date().toISOString();
        job.status = queued ? "cancelled" : "cancelling";
        job.stage = queued ? "Cancelled before starting" : job.type === "draft-repair"
          ? "正在停止后台修题；已修好的题目会保留" : job.type === "audio-import"
          ? "正在停止音频导入；已完成的转写会保留" : job.type === "pdf-convert"
          ? "正在停止 PDF 转换；已解析好的段落会保留" : job.origin === "selection"
          ? "Stopping; nothing is saved to the deck unless it already passed review" : job.origin === "translation"
          ? "Stopping; translated paragraphs are kept" : "Stopping generation; questions already saved to the draft are kept";
        // Accurate with or without a draft: nothing was approved when nothing was saved (P28).
        generationControllers.get(job.id)?.abort(new Error(job.type === "draft-repair"
          ? "后台修题已取消；已修好的题目会保留" : job.type === "audio-import"
          ? "音频导入已取消；已完成的转写会保留" : job.type === "pdf-convert"
          ? "PDF 转换已取消；已解析好的段落会保留" : job.origin === "selection"
          ? "Supplement stopped; nothing new was saved to the deck" : job.origin === "translation"
          ? "Translation stopped; translated paragraphs are kept" : "Generation cancelled; questions already saved to the draft are kept"));
        if (queued) {
          job.finishedAt = new Date().toISOString();
          generationControllers.delete(job.id);
        }
      }
      return { jobs: targets.map(publicJob), note: "Cancelling means worker cleanup is pending. Cancelled queued jobs will never start. Saved drafts are retained." };
    },
"job.dismiss": async function (a) {
      // A day of 为你定制 is a record in its own file (lib/coach-daily.js): dismissing it removes the day.
      if (coachDayId(a.jobId)) {
        const ledger = coachDailyLedger(storagePort.root), date = coachDayId(a.jobId), data = await ledger.read();
        if (data.inflight.length && date === dayOf(Date.now())) throw new Error("任务还在进行，请先停止或等它结束");
        await ledger.dismiss(date);
        return { dismissed: [a.jobId] };
      }
      const scoped = scopedJobs();
      // An archived record is removed for good the same way (the archive forgets it and its working copy is cleaned).
      if (typeof a.jobId === "string" && !scoped.some((job) => job.id === a.jobId)) {
        const { removed } = await archive().remove([a.jobId]);
        if (removed.length) { for (const record of removed) await releaseRecord(record); return { dismissed: [a.jobId] }; }
      }
      // jobIds: a card and the earlier jobs of the same deck folded into it leave together.
      const named = Array.isArray(a.jobIds) ? a.jobIds.filter((value) => typeof value === "string") : [];
      if ((a.all ? 1 : 0) + (a.jobId ? 1 : 0) + (named.length ? 1 : 0) !== 1) throw new Error("Specify jobId or all:true (or jobIds for several)");
      const targets = a.all ? scoped.filter((job) => !activeJob(job) && isOwnRow(job)) : named.length ? named.map((jobId) => get(scoped, jobId, "Study job")) : [get(scoped, a.jobId, "Study job")];
      if (targets.some(activeJob)) throw new Error("任务还在进行，请先停止或等它结束");
      // Reply fast (a click on 知道了 must not wait for disk): leave the list and persist the dismissal first, then let
      // the slow file deletion finish in the background (lib/job-cleanup.js; idempotent, swept on the next start).
      // Only pre-manifest jobs live in the inbox; their letter is the persisted record, so it goes before the reply.
      for (const job of targets) await removeLive(job);
      return { dismissed: targets.map((job) => job.id) };
    },
/* 任务 归档 (2.6.1, lib/job-archive.js). job.archive {jobId | jobIds (≤100) | all:true}: finished jobs leave the list and are kept as a read-only record
   (the contract as the console draws it, bounded) in <library>/job-archive.json; nothing is deleted, an audio batch's folder stays where it is. A running, queued or
   stopping job is not archived: with one jobId it is refused like job.dismiss does, in a list it is skipped and named (`skipped: [{ id, reason: "running" }]`).
   Archiving again is harmless (`alreadyArchived`); an id nobody knows is `missing` (an error when it is the only one asked for). A day of 为你定制 is not archived
   (`not-archivable`: its own file keeps fourteen days). The oldest records beyond 200 / 90 days fall off, and an audio batch's working copy falls with them. */
"job.archive": async function (a) {
      const request = requested(a, { all: true, name: "job.archive" }), scoped = scopedJobs(), store = archive();
      const out = { archived: [], alreadyArchived: [], skipped: [], missing: [] }, plan = [];
      const wanted = request.all ? [...new Set(scoped.filter((job) => !activeJob(job) && isOwnRow(job)).map(lineage))] : request.ids;
      for (const id of wanted) {
        if (coachDayId(id)) { out.skipped.push({ id, reason: "not-archivable" }); continue; }
        const found = matching(scoped, id);
        if (!found.length) { (await store.has(id) ? out.alreadyArchived : out.missing).push(id); continue; }
        if (found.some(activeJob)) { out.skipped.push({ id, reason: "running" }); continue; }
        const at = new Date().toISOString(), record = archiveRecordOf(newest(found), { at });
        if (!record) { out.skipped.push({ id, reason: "not-archivable" }); continue; }
        record.ids = [...new Set([...record.ids, ...found.map((job) => job.id)])];
        plan.push({ id, found, record });
      }
      if (request.single) {
        if (out.missing.length) throw new Error(`Study job not found: ${request.ids[0]}`);
        if (out.skipped[0]?.reason === "running") throw stillRunning();
      }
      if (plan.length) {
        // The record is written first: whatever happens next, the job is not lost. Then it leaves the list; its files stay.
        const { evicted } = await store.add(plan.map((item) => item.record));
        for (const { found } of plan) for (const job of found) { forgetRetry(job.id); jobs.delete(job.id); }
        out.archived.push(...plan.map((item) => item.id));
        await dropEvicted(evicted);
      }
      return out;
    },
/* job.unarchive {jobId | jobIds}: the record goes back to the list. An audio batch or a PDF conversion that is still on disk comes back from its folder the way a
   restart brings it back (retry and all); anything else comes back from its record as an ended job (nothing to retry, 打开结果 works if its target is still there). */
"job.unarchive": async function (a) {
      const request = requested(a, { name: "job.unarchive" }), store = archive(), out = { unarchived: [], missing: [] }, records = [];
      for (const id of request.ids) {
        const record = await store.find(id);
        if (!record) { out.missing.push(id); continue; }
        records.push({ id, record: { ...record, job: { ...record.job, contract: readJobContract(record.job.contract) } } });
      }
      if (request.single && out.missing.length) throw new Error(`Study job not found: ${request.ids[0]}`);
      if (!records.length) return out;
      const restoreHistory = (record) => {
        if (!matching(scopedJobs(), record.id).length && !record.ids.some((name) => jobs.has(name))) {
          const contract = record.job.contract;
          jobs.set(record.job.id, { id: record.job.id, root: storagePort.root, ...(contract.kind === "generation" ? {} : { type: contract.kind }), status: contract.status,
            startedAt: contract.startedAt, ...(contract.finishedAt ? { finishedAt: contract.finishedAt } : {}), restoredContract: contract,
            ...(contract.contractVersion === RUNTIME_CONTRACT_VERSION ? { restoredArchive: { ids: record.ids, ...(record.files ? { files: record.files } : {}) } } : {}) });
        }
      };
      await store.remove(records.map((item) => item.record.id));
      // Install validated v2 history before the library-wide legacy scan, which also excludes previously restored history.
      for (const { record } of records) if (record.job.contract.contractVersion === RUNTIME_CONTRACT_VERSION) restoreHistory(record);
      if (records.some(({ record }) => record.job.contract.contractVersion === 1 && (record.files || ["audio-import", "pdf-convert"].includes(record.job.contract.kind))) && typeof ports.call === "function") await Promise.resolve().then(() => ports.call("recover", { again: true })).catch(() => {});
      for (const { id, record } of records) {
        restoreHistory(record);
        out.unarchived.push(id);
      }
      return out;
    },
/* job.delete {jobIds (≤100)}: removes records for good, the same as job.dismiss does for one (the task record, and for audio the working copy of the batch in the
   background); never the imported sources, drafts or decks. Finished jobs and archived records both go (an archived record leaves the archive). A running job is not
   touched: `skipped: [{ id, reason: "running" }]`. Unknown ids are `missing`. */
"job.delete": async function (a) {
      const request = requested({ jobId: a?.jobId, jobIds: a?.jobIds }, { name: "job.delete" }), scoped = scopedJobs(), store = archive();
      const out = { deleted: [], skipped: [], missing: [] };
      for (const id of request.ids) {
        if (coachDayId(id)) {
          const ledger = coachDailyLedger(storagePort.root), data = await ledger.read();
          if (data.inflight.length && coachDayId(id) === dayOf(Date.now())) { out.skipped.push({ id, reason: "running" }); continue; }
          await ledger.dismiss(coachDayId(id));
          out.deleted.push(id);
          continue;
        }
        const found = matching(scoped, id);
        if (found.length) {
          if (found.some(activeJob)) { out.skipped.push({ id, reason: "running" }); continue; }
          for (const job of found) await removeLive(job);
          out.deleted.push(id);
          continue;
        }
        const { removed } = await store.remove([id]);
        if (!removed.length) { out.missing.push(id); continue; }
        for (const record of removed) await releaseRecord(record);
        out.deleted.push(id);
      }
      return out;
    },
/* One door for what the learner (or an agent) can DO to a job: {jobId, action: cancel | pause | resume | retry | set, patch?}. Whether it may is decided
   once, from what the kind of job declares and the state it is in (lib/job-contract.js checkAction); a refusal is an error with a `code` (capability-unsupported,
   no-safe-checkpoint, job-ended ...) and a clear message, and the contract the snapshot carries already says the same, so a UI shows the reason instead of a button.
   `set` changes live settings for the NEXT call and interrupts none; with a patch and no action it is `set` (the first form of this action). job.cancel and
   job.dismiss stay as they were. */
"job.control": async function (a) {
      if (coachDayId(a?.jobId)) return coachControl(a);
      const scoped = scopedJobs();
      // A job that can be retried is named by what survives the retry; its newest record is the one that is acted on.
      const wanted = a?.jobId;
      const job = scoped.find((j) => j.id === wanted) || scoped.filter((j) => j.batchId === wanted || j.singleId === wanted || j.contract?.jobId === wanted).at(-1);
      if (!job && wanted && await archive().has(wanted)) throw Object.assign(new Error(reasonText("archived")), { code: "archived", capability: true });
      if (!job) throw new Error(`Study job not found: ${wanted}`);
      const action = a.action ?? (a.patch !== undefined ? "set" : undefined);
      if (!action) throw new Error("job.control needs an action: cancel, pause, resume, retry or set");
      const canonical = ports.runtimeJobs?.compatible(job.id);
      if (canonical) { const result = await canonical.control(job.id, action, a.patch); return { jobId: a.jobId, attemptId: result.runtime.legacyId, action, status: result.status }; }
      const verdict = checkAction(job, action);
      if (!verdict.ok) throw Object.assign(new Error(verdict.message), { code: verdict.code, capability: true });
      const control = jobControls.get(job.id), done = (extra = {}) => ({ jobId: a.jobId, attemptId: job.id, action, ...extra });
      // A retry starts a new attempt: the reply names it, like a runtime job's control reply does.
      const retried = started => done({ retried: true, ...started, attemptId: started.jobId ?? job.id });
      switch (action) {
        case "cancel": { const reply = await handlers["job.cancel"]({ jobId: job.id }); return done({ status: "cancelling", note: reply.note }); }
        case "pause": { const reply = control.patch({ paused: true }); return done({ ...reply, note: "新的调用不再开始；正在进行的调用跑完后任务才算暂停。" }); }
        case "resume": { const reply = control.patch({ paused: false }); return done({ ...reply, note: "已继续。" }); }
        case "retry": {
          // 接着做 of a coverage run the last process left running: the rounds of the draft's plan from the next one that is not done (the draft is the checkpoint, lib/coverage-run.js).
          if (job.coverageRun) {
            const draft = get((await storagePort.read()).drafts, job.draftId, "Draft");
            return retried(await ports.call("generate", { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } }));
          }
          // 接着做 of a plain run (a count, no plan) that kept a draft: the same draft goes on, every approved question stays and only the questions it was asked for and did not get are made, with its own settings.
          if (kindOf(job) === "generation" && job.draftId) {
            const draft = get((await storagePort.read()).drafts, job.draftId, "Draft");
            return retried(await ports.call("generate", { resumeDraftId: draft.id, draftVersion: draft.draftVersion }));
          }
          const started = await ports.call(job.type === "pdf-convert" ? "mineru.retry" : "audio.retry", { jobId: job.id });
          return retried(started);
        }
        default: {
          if (!a.patch || typeof a.patch !== "object" || Array.isArray(a.patch)) throw new Error("job.control set needs a patch object, for example {concurrency: 3}");
          if (Object.hasOwn(a.patch, "paused")) throw Object.assign(new Error("暂停和继续用 action: pause / resume，不是 set。"), { code: "unknown-setting" });
          return done({ ...control.patch(a.patch), note: "从下一次调用开始生效；正在进行的调用不受影响。" });
        }
      }
    },
/* What a call has written (the console's 实时输出): only the text after `cursor` (a position this action returned as `nextCursor`), from a bounded in-memory buffer.
   A running call is read while it grows. An ended call keeps its tail (the last OUTPUT_LIMIT characters; the last KEEP_ENDED finished calls are kept, in memory
   only): `ended: true, retained: true, source: "memory"`, readable from cursor 0 once. When a DSH sub-agent wrote more than that tail, or its tail is gone (older
   than the kept ones, a restart), the full final reply is read from its session on demand (`ports.sessions.lastReply`): `source: "session"`, at most 200 KB
   (`clipped: true` when longer). A session that cannot be read is not an error: `sessionUnreadable: true`. A running call never reads a session, and neither
   does a reader that already has the text (cursor > 0). A call that cannot offer its text on the way (a Gemini request) says so (`supported: false`). */
"job.output": async function (a) {
      const scoped = scopedJobs();
      const wanted = a?.jobId, job = scoped.find((j) => j.id === wanted) || scoped.filter((j) => j.batchId === wanted || j.singleId === wanted || j.contract?.jobId === wanted).at(-1);
      if (!job) throw new Error(`Study job not found: ${wanted}`);
      if (typeof a.callId !== "string" || !a.callId) throw new Error("job.output needs a callId (an id of one of the job's calls)");
      const call = jobCalls(job).find((item) => item.id === a.callId);
      if (!call) throw new Error("Call not found: it may be older than the list the job keeps");
      const cursor = Number.isFinite(Number(a.cursor)) ? Number(a.cursor) : 0, live = call.status === "running";
      const base = { jobId: job.id, callId: call.id, retention: { unit: "chars", limit: OUTPUT_LIMIT, persisted: false, endedCalls: KEEP_ENDED } };
      const read = jobOutputs.read(job.id, call.id, cursor);
      if (live) {
        if (read) return { ...base, supported: true, live, text: read.text, nextCursor: read.next, truncated: read.reset, reasoningChars: read.reasoning };
        const supported = jobOutputs.wasOpened(job.id, call.id);
        return { ...base, supported, live, text: "", nextCursor: 0, truncated: false, reasoningChars: 0, ...(supported ? {} : { runner: call.runner }) };
      }
      // An ended call. A session is only read for a call that finished (not one waiting or queued), that has a sub-agent, and for a reader that has not read it yet.
      const finished = ["ok", "failed", "cancelled", "skipped"].includes(call.status);
      const wantsSession = finished && !!call.childId && cursor === 0 && typeof ports.sessions?.lastReply === "function" && (!read || read.total > read.text.length);
      const reply = wantsSession ? await ports.sessions.lastReply(call.childId) : undefined;
      const opened = !!read || jobOutputs.wasOpened(job.id, call.id);
      if (reply?.text) return { ...base, supported: true, live, ended: true, retained: !!read, source: "session", text: reply.text, nextCursor: read ? read.next : reply.text.length,
        truncated: true, reasoningChars: read?.reasoning ?? 0, ...(read ? { writtenChars: read.total } : {}), ...(reply.clipped ? { clipped: true } : {}) };
      const unreadable = wantsSession && reply === null;
      if (read) return { ...base, supported: true, live, ended: true, retained: true, source: "memory", text: read.text, nextCursor: read.next, truncated: read.reset,
        reasoningChars: read.reasoning, writtenChars: read.total, ...(read.total > read.text.length && cursor === 0 ? { partial: true } : {}), ...(unreadable ? { sessionUnreadable: true } : {}) };
      return { ...base, supported: opened || !!reply, live, ended: true, retained: false, text: "", nextCursor: cursor, truncated: false, reasoningChars: 0,
        ...(opened || reply ? {} : { runner: call.runner }), ...(unreadable ? { sessionUnreadable: true } : {}) };
    },
"job.message": async function (a) {
      const candidates = [...jobs.values()].filter((j) => j.root === storagePort.root && activeJob(j));
      if (!a.jobId && candidates.length > 1) throw new Error("Multiple generation jobs are active; specify jobId");
      const job = a.jobId ? get(candidates, a.jobId, "Active generation job") : candidates[0];
      if (!job) throw new Error("No active generation job; completed drafts are not changed by messages");
      const text = typeof a.message === "string" ? a.message.trim() : "";
      if (!text || text.length > 4000) throw new Error("Use a message of 1–4000 characters");
      if (job.messages.length >= 20) throw new Error("This job already has 20 supplementary messages");
      const message = { id: id(), text, at: new Date().toISOString(), delivery: "next-stage" };
      job.messages.push(message);
      const senders = [...(generationMessengers.get(job.id)?.values() || [])];
      if (senders.length) {
        message.receipts = await Promise.all(senders.map(async (send) => {
          try { return { ...await send(text), delivered: true }; }
          catch (error) { return { delivered: false, error: error.message }; }
        }));
        const delivered = message.receipts.filter((receipt) => receipt.delivered);
        if (delivered.length === senders.length) message.delivery = "delivered";
        else if (delivered.length) message.delivery = "partial";
        if (senders.length === 1 && delivered.length) Object.assign(message, delivered[0]);
      }
      return { jobId: job.id, ...message,
        note: message.delivery === "delivered"
          ? "Delivered to all currently reachable children and retained for later stages; completed batches are unchanged."
          : "Saved for the next model stage; NOT delivered to the current child. If no stage remains, regenerate the draft with this requirement." };
    },
"job.status": async function (a) {
      /* The read-only look at a background job (a step of the generation path, a draft check, an import): it answers at once and never waits, so the chat agent can
         report where a job is when the learner asks, and start the next step only once the one before it has finished. Without a jobId it lists this library's jobs. */
      const scoped = scopedJobs();
      const brief = (job) => ({ id: job.id, type: job.type, status: job.status, finished: !activeJob(job), stage: job.stage, stageCode: publicJob(job).stageCode,
        count: job.count, requestedTotal: job.requestedTotal, savedCount: job.savedCount, startedAt: job.startedAt, finishedAt: job.finishedAt });
      if (!a?.jobId) return { jobs: scoped.filter(isOwnRow).map(brief) };
      // A Job of the unified runtime answers to its logical id as well as to its facade id (as in job.control).
      const job = scoped.find((j) => j.contract?.jobId === a.jobId && ports.runtimeJobs?.visible(j.id)) || get(scoped, a.jobId, "Job");
      ports.runtimeJobs?.compatible(job.id);
      const result = { ...publicJob(job), finished: !activeJob(job) };
      if (job.draftId) {
        const draft = (await storagePort.read()).drafts.find((d) => d.id === job.draftId);
        if (draft) result.draft = { id: draft.id, draftVersion: draft.draftVersion, title: draft.title, cards: draft.cards.length };
      }
      return result;
    },
"job.wait": async function (a) {
      const job = a.jobId
          ? (scopedJobs().find(job => job.id === a.jobId || job.singleId === a.jobId || job.contract?.jobId === a.jobId) || get(scopedJobs(), a.jobId, "Job"))
          : scopedJobs().at(-1);
      if (!job) return { status: "none" };
      ports.runtimeJobs?.compatible(job.id);
      const seconds = Math.min(Math.max(Number(a.timeoutSeconds) || 60, 1), 60);
      // A job leaves the active states just before its last bookkeeping (the inbox letter, the notice to the session)
      // is written; wait for that too, so a caller that continues does not race those writes.
      if (activeJob(job) || settled.has(job.id)) {
        let timer;
        await Promise.race([
          settled.get(job.id),
          new Promise((resolve) => {
            timer = setTimeout(resolve, seconds * 1000);
          }),
        ]);
        clearTimeout(timer);
      }
      const result = publicJob(job);
      result.waitLimitSeconds = seconds;
      if (job.draftId) {
        const draft = (await storagePort.read()).drafts.find((d) => d.id === job.draftId);
        if (draft)
          result.draft = {
            id: draft.id,
            draftVersion: draft.draftVersion,
            title: draft.title,
            cards: draft.cards.length,
            topics: [...new Set(draft.cards.map((c) => c.topic))],
            warnings: draft.quality?.warnings?.length || 0,
            failures: draft.editorial?.failures || [],
            ...(missingQuestions(draft) ? { missing: missingQuestions(draft), requested: draft.editorial.requested } : {}),
          };
        // A short draft is topped up, not started again: the passing questions stay and only the missing ones are written.
        if (draft && canContinueDraft(draft) && !activeJob(job))
          result.next = `The draft kept ${draft.cards.length} of ${draft.editorial.requested} requested questions${job.partReport?.summary ? ` (${job.partReport.summary})` : ""}. Top it up with generate {resumeDraftId: "${draft.id}", draftVersion: ${draft.draftVersion}} — it keeps the questions that passed and writes only the missing ones. Do not start the whole generation again, and do not suggest the learner select fewer pages by hand before trying that.`;
      } else if (activeJob(job))
        result.next = "Still running in the background. Return control to the learner; progress and the resulting draft appear in the Study workspace. Do not start duplicate jobs.";
      return result;
    }
};
const mutations = {

};
  return { handlers, mutations };
}

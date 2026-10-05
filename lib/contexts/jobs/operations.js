import { get, id } from "../../util.js";
import { jobCleanup } from "../../job-cleanup.js";
import { canContinueDraft, missingQuestions } from "../../draft-continuation.js";
import { jobCalls } from "../../job-calls.js";
import { checkAction } from "../../job-contract.js";
import { OUTPUT_LIMIT } from "../../job-output.js";



/** jobs operations close over only the ports declared by this context. */
export function createOperations(ports, { cleanup = jobCleanup } = {}) {
  const { state: storagePort } = ports;
  const { jobs, settled, generationMessengers, generationControllers, jobControls, jobOutputs } = ports.work;
  const { activeJob, publicJob, dropRetry } = ports.jobServices;
const handlers = {
"job.cancel": async function (a) {
      const scoped = [...jobs.values()].filter((j) => j.root === storagePort.root);
      if (a.all && a.jobId) throw new Error("Use jobId or all, not both");
      if (!a.all && !a.jobId) throw new Error("Specify jobId or all:true to cancel this library queue");
      const targets = a.all ? scoped.filter((job) => activeJob(job) && job.type !== "draft-publish")
        : [get(scoped, a.jobId, "Study job")];
      if (targets.some((job) => job.type === "draft-publish"))
        throw new Error("发布检查正在进行，请等待完成");
      for (const job of targets) {
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
      const scoped = [...jobs.values()].filter((j) => j.root === storagePort.root);
      // jobIds: a card and the earlier jobs of the same deck folded into it leave together.
      const named = Array.isArray(a.jobIds) ? a.jobIds.filter((value) => typeof value === "string") : [];
      if ((a.all ? 1 : 0) + (a.jobId ? 1 : 0) + (named.length ? 1 : 0) !== 1) throw new Error("Specify jobId or all:true (or jobIds for several)");
      const targets = a.all ? scoped.filter((job) => !activeJob(job)) : named.length ? named.map((jobId) => get(scoped, jobId, "Study job")) : [get(scoped, a.jobId, "Study job")];
      if (targets.some(activeJob)) throw new Error("任务还在进行，请先停止或等它结束");
      // Reply fast (a click on 知道了 must not wait for disk): leave the list and persist the dismissal first, then let
      // the slow file deletion finish in the background (lib/job-cleanup.js; idempotent, swept on the next start).
      for (const job of targets) {
        dropRetry(job.id); jobs.delete(job.id);
        const batchId = job.batchId || job.singleId;
        if (batchId) await cleanup.dismissBatch(storagePort.root, batchId);
        // Only pre-manifest jobs live in the inbox; their letter is the persisted record, so it goes before the reply.
        if (job.legacy) await storagePort.update(s => { s.inbox = (s.inbox || []).filter(item => !(item.kind === 'audio-failed' && item.jobId === job.id)); });
      }
      return { dismissed: targets.map((job) => job.id) };
    },
/* One door for what the learner (or an agent) can DO to a job: {jobId, action: cancel | pause | resume | retry | set, patch?}. Whether it may is decided
   once, from what the kind of job declares and the state it is in (lib/job-contract.js checkAction); a refusal is an error with a `code` (capability-unsupported,
   no-safe-checkpoint, job-ended ...) and a clear message, and the contract the snapshot carries already says the same, so a UI shows the reason instead of a button.
   `set` changes live settings for the NEXT call and interrupts none; with a patch and no action it is `set` (the first form of this action). job.cancel and
   job.dismiss stay as they were. */
"job.control": async function (a) {
      const scoped = [...jobs.values()].filter((j) => j.root === storagePort.root);
      // A job that can be retried is named by what survives the retry; its newest record is the one that is acted on.
      const wanted = a?.jobId;
      const job = scoped.find((j) => j.id === wanted) || scoped.filter((j) => j.batchId === wanted || j.singleId === wanted).at(-1);
      if (!job) throw new Error(`Study job not found: ${wanted}`);
      const action = a.action ?? (a.patch !== undefined ? "set" : undefined);
      if (!action) throw new Error("job.control needs an action: cancel, pause, resume, retry or set");
      const verdict = checkAction(job, action);
      if (!verdict.ok) throw Object.assign(new Error(verdict.message), { code: verdict.code, capability: true });
      const control = jobControls.get(job.id), done = (extra = {}) => ({ jobId: a.jobId, attemptId: job.id, action, ...extra });
      switch (action) {
        case "cancel": { const reply = await handlers["job.cancel"]({ jobId: job.id }); return done({ status: "cancelling", note: reply.note }); }
        case "pause": { const reply = control.patch({ paused: true }); return done({ ...reply, note: "新的调用不再开始；正在进行的调用跑完后任务才算暂停。" }); }
        case "resume": { const reply = control.patch({ paused: false }); return done({ ...reply, note: "已继续。" }); }
        case "retry": {
          const started = await ports.call(job.type === "pdf-convert" ? "mineru.retry" : "audio.retry", { jobId: job.id });
          return done({ retried: true, ...started });
        }
        default: {
          if (!a.patch || typeof a.patch !== "object" || Array.isArray(a.patch)) throw new Error("job.control set needs a patch object, for example {concurrency: 3}");
          if (Object.hasOwn(a.patch, "paused")) throw Object.assign(new Error("暂停和继续用 action: pause / resume，不是 set。"), { code: "unknown-setting" });
          return done({ ...control.patch(a.patch), note: "从下一次调用开始生效；正在进行的调用不受影响。" });
        }
      }
    },
/* What a running call has written so far (the console's 实时输出): only the text after `since` (a position this action returned as `next`), from a
   bounded in-memory buffer that is gone when the call ends. A call that cannot offer its text on the way (a Gemini request) says so. */
"job.output": async function (a) {
      const scoped = [...jobs.values()].filter((j) => j.root === storagePort.root);
      const job = get(scoped, a?.jobId, "Study job");
      if (typeof a.callId !== "string" || !a.callId) throw new Error("job.output needs a callId (an id of one of the job's calls)");
      const call = jobCalls(job).find((item) => item.id === a.callId);
      if (!call) throw new Error("Call not found: it may be older than the list the job keeps");
      const cursor = Number.isFinite(Number(a.cursor)) ? Number(a.cursor) : 0, live = call.status === "running";
      const base = { jobId: job.id, callId: call.id, retention: { unit: "chars", limit: OUTPUT_LIMIT, persisted: false } };
      const read = jobOutputs.read(job.id, call.id, cursor);
      if (read) return { ...base, supported: true, live, text: read.text, nextCursor: read.next, truncated: read.reset, reasoningChars: read.reasoning };
      const supported = jobOutputs.wasOpened(job.id, call.id);
      return { ...base, supported, live, ...(live ? {} : { ended: true }), text: "", nextCursor: live ? 0 : cursor, truncated: false, reasoningChars: 0, ...(supported ? {} : { runner: call.runner }) };
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
      const scoped = [...jobs.values()].filter((j) => j.root === storagePort.root);
      const brief = (job) => ({ id: job.id, type: job.type, status: job.status, finished: !activeJob(job), stage: job.stage, stageCode: publicJob(job).stageCode,
        count: job.count, requestedTotal: job.requestedTotal, savedCount: job.savedCount, startedAt: job.startedAt, finishedAt: job.finishedAt });
      if (!a?.jobId) return { jobs: scoped.map(brief) };
      const job = get(scoped, a.jobId, "Job");
      const result = { ...publicJob(job), finished: !activeJob(job) };
      if (job.draftId) {
        const draft = (await storagePort.read()).drafts.find((d) => d.id === job.draftId);
        if (draft) result.draft = { id: draft.id, draftVersion: draft.draftVersion, title: draft.title, cards: draft.cards.length };
      }
      return result;
    },
"job.wait": async function (a) {
      const root = storagePort.root,
        job = a.jobId
          ? get([...jobs.values()].filter((j) => j.root === root), a.jobId, "Job")
          : [...jobs.values()].filter((j) => j.root === root).at(-1);
      if (!job) return { status: "none" };
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

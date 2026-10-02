import { get, id } from "../../util.js";
import { jobCleanup } from "../../job-cleanup.js";



/** jobs operations close over only the ports declared by this context. */
export function createOperations(ports, { cleanup = jobCleanup } = {}) {
  const { state: storagePort } = ports;
  const { jobs, settled, generationMessengers, generationControllers } = ports.work;
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
      if (!!a.all === !!a.jobId) throw new Error("Specify jobId or all:true");
      const targets = a.all ? scoped.filter((job) => !activeJob(job)) : [get(scoped, a.jobId, "Study job")];
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
          };
      } else if (activeJob(job))
        result.next = "Still running in the background. Return control to the learner; progress and the resulting draft appear in the Study workspace. Do not start duplicate jobs.";
      return result;
    }
};
const mutations = {

};
  return { handlers, mutations };
}

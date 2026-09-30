import { libraryContext, datedSources } from "../../source-query.js";
import { latestOutcomes } from "../../mastery.js";
import { studyMap } from "../../insights.js";
import { focusView, courseOf } from "../../focus.js";
import { courseRoute } from "../../course-route.js";
import { noteView, noteBadges } from "../../blog-notes.js";
import { sourcesWithCourses } from "../../source-courses.js";
import { reviewedCardStatus } from "../../review-integrity.js";
import { selfCitedCardCount } from "../../source-provenance.js";
import { runTitle, runTitleInfo } from "../../run-title.js";
import { oralReport } from "../../oral-exam.js";
import { skeletonTopics, topicGroupsView, skeletonSummary } from "../../skeleton.js";
import { inboxView } from "../../inbox.js";
import { get, id, required } from "../../util.js";
import { removeAudioBatch } from "../../audio-batch.js";
import { importLegacy } from "../../legacy.js";
import { checkSettings } from "../../domain.js";
import { jobs, publicJob, runOpen, runKey, submittedExam, examReport, ingestView, currentRun, activeJob, generationControllers, dropRetry, generationMessengers, settled } from "../../legacy-kernel.js";
import { exportAttachments, importAttachments } from '../materials/files.js';

export const handlers = {
"library.context": async function (a) { return libraryContext(await this.store.read(), a, this.store.root); },
"snapshot": async function (a) {
      const started = performance.now();
      // Polling panels send their last fingerprint. It is built from the
      // library file's stat plus in-memory job and coach state, so an
      // unchanged poll neither reads nor parses the library (megabytes of
      // source text) nor builds and sends a full snapshot. Due counts move
      // with time, so the fingerprint also rolls over each minute.
      const root = this.store.root;
      const entry = this.store.load ? await this.store.load() : null;
      const storageIssues = entry?.storageIssues || [];
      const fingerprint = JSON.stringify([
        entry?.stamp ?? await this.store.stamp(), root, !!this.complete, this.coach && !!this.light, this.language,
        Math.floor(Date.now() / 60000), this.coachActivity(),
        a.hostState || null,
        storageIssues,
        [...jobs.values()].filter((j) => j.root === root).map(publicJob),
      ]);
      if (!a.compact && a.since === fingerprint) return { unchanged: true, fingerprint };
      const s = entry?.state ?? await this.store.read();
      const loaded = performance.now();
      const coach = this.coachStatus(s);
      const outcome = latestOutcomes(s.attempts),
        map = studyMap(s);
      const latestRuns = new Map();
      for (const r of s.runs.filter((r) => !r.workflowSessionId && runOpen(r))) latestRuns.set(runKey(r), r);
      const snapshot = {
        today: map.today,
        next: map.next,
        progress: Object.fromEntries(map.decks.map((d) => [d.id, d])),
        root: this.store.root,
        storageIssues,
        revision: s.revision,
        settings: s.settings,
        focus: { ...focusView(s), route: courseRoute(s, { language: this.language }) },
        notes: (s.notes || []).map(item => { const { markdown, cards, ...note } = noteView(s, item); return { ...note, cardCount: cards.length }; }),
        noteBadges: noteBadges(s),
        csdnHome: s.csdnHome || "",
        sources: datedSources({ ...s, sources: sourcesWithCourses(s) }),
        decks: s.decks.map((d) => ({
          id: d.id,
          title: d.title,
          folder: d.folder || "",
          course: courseOf(d),
          createdAt: d.createdAt || null,
          publishedAt: d.publishedAt || null,
          count: d.cards.length,
          systemKind: d.systemKind,
          archived: !!d.archived,
          available: d.cards.filter((q) => !q.suspended).length,
          quizCount: d.cards.filter(
            (q) => !q.suspended && q.kind !== "flashcard",
          ).length,
          examCount: d.cards.filter((q) => !q.suspended && ["quiz", "multi"].includes(q.kind)).length,
          examQuizCount: d.cards.filter((q) => !q.suspended && q.kind === "quiz").length,
          examMultiCount: d.cards.filter((q) => !q.suspended && q.kind === "multi").length,
          suspended: d.cards.filter((q) => q.suspended).length,
          wrong: d.cards.filter((q) => !q.suspended && outcome(d.id, q.id) < 3)
            .length,
          topics: [...new Set(d.cards.map((q) => q.topic))],
          due: d.cards.filter(
            (q) =>
              !q.suspended &&
              (!q.review?.due_at || Date.parse(q.review.due_at) <= Date.now()),
          ).length,
          flagged: d.cards.filter((q) => q.flag).length,
          uncheckedAtPublish: reviewedCardStatus(d)?.changed ?? d.editorial?.uncheckedAtPublish ?? 0,
          selfCited: selfCitedCardCount(d.cards, s.sources),
        })),
        drafts: s.drafts,
        attempts: s.attempts.slice(-100),
        runs: [...latestRuns.values()]
          // A run is unresumable once every deck it references is gone; hide it
          // rather than offering a button that fails with "Deck not found".
          // Path runs may carry an empty scope (all decks) or a null deckId
          // when they span decks, so the run's own entries are authoritative.
          .filter((r) => {
            const ids = new Set(
              (r.entries || []).map((e) => e.deckId).filter(Boolean),
            );
            for (const x of r.scope || []) if (x.deckId) ids.add(x.deckId);
            if (!ids.size && r.deckId) ids.add(r.deckId);
            return [...ids].some((id) => s.decks.some((d) => d.id === id));
          })
          .map((r) => ({
            id: r.id,
            deckId: r.deckId,
            deckIds: [...new Set([r.deckId, ...r.entries.map((entry) => entry.deckId)].filter(Boolean))],
            title: runTitle(s, r),
            titleInfo: runTitleInfo(s, r),
            scope: r.scope ?? [{ deckId: r.deckId }],
            index: r.index,
            total: r.entries.length,
            mode: r.mode,
            ...(r.purpose ? { purpose: r.purpose, course: r.course } : {}),
            startedAt: r.startedAt,
          })),
        exams: s.runs.filter(submittedExam).slice(-8).reverse().map((run) => {
          const report = examReport(s, run);
          return { runId: run.id, submittedAt: report.submittedAt, total: report.total,
            answered: report.answered, correct: report.correct, scorePct: report.scorePct,
            examKinds: report.examKinds, comparison: report.comparison, decks: report.byDeck.map((row) => row.title) };
        }),
        oralExams: (s.oralRuns || []).filter((run) => run.submittedAt).slice(-8).reverse().map((run) => {
          const report = oralReport(run);
          return { runId: run.id, submittedAt: report.submittedAt, role: report.role,
            total: report.total, assessed: report.assessed, strong: report.strong,
            developing: report.developing, weak: report.weak };
        }),
        jobs: [...jobs.values()]
          .filter((j) => j.root === this.store.root)
          .map(publicJob),
        modelReady: !!this.complete,
        // Topics not yet in a topic group, so the library can remind after an import.
        topicGrouping: (() => {
          const topics = skeletonTopics(s), view = topicGroupsView(s, topics);
          return { topics: topics.length, groups: view.groups.length, ungrouped: view.ungrouped.length };
        })(),
        coach,
        ...(a.compact ? {} : { fingerprint }),
        ingest: ingestView(s),
        inbox: inboxView(s),
        skeletons: (s.skeletons || []).map(skeletonSummary).reverse(),
        lastRun: (() => {
          // The run itself, not the first run that happens to sit on the same card.
          const best = currentRun(s);
          const run = best?.run;
          if (!run || !runOpen(run) || !s.decks.some((d) => d.id === (best.entry.deckId ?? run.deckId))) return null;
          return { id: run.id, title: runTitle(s, run), titleInfo: runTitleInfo(s, run), index: run.index, total: run.entries.length, mode: run.mode };
        })(),
      };
      // Agents get summaries; full texts stay behind source.get / deck.get.
      if (a.compact)
        Object.assign(snapshot, {
          sources: snapshot.sources.map((x) => ({ id: x.id, title: x.title, chars: x.text.length,
            courses: x.courses, coursesInferred: x.coursesInferred, usedBy: x.usedBy })),
          drafts: s.drafts.map((d) => ({
            id: d.id,
            title: d.title,
            cards: d.cards.length,
            requested: d.editorial?.requested,
            missing: Math.max(0, (d.editorial?.requested || 0) - d.cards.length),
            canContinue: !d.editingDeckId && !!d.editorial?.generation?.sourceIds?.length && d.cards.length < d.editorial.requested,
            draftVersion: d.draftVersion,
            editingDeckId: d.editingDeckId,
          })),
          attempts: s.attempts.length,
        });
      const ended = performance.now();
      if (ended - started >= 1000)
        console.warn(`[study-snapshot] read ${Math.round(loaded - started)}ms, build ${Math.round(ended - loaded)}ms`);
      return snapshot;
    },
"export": async function (a) {
      const state = await this.store.read();
      this.store.assertWritable?.({ storageIssues: state.storageIssues });
      if (!state.documents?.some(document => document.versions?.some(version => version.attachment))) return state;
      if (state.portableMaterials !== undefined) throw new Error('The library has a reserved portableMaterials field; preserve it before creating a portable backup');
      return { ...state, portableMaterials: { format: 'study-materials-backup/v1',
        attachments: await exportAttachments(this.store.root, state.documents) } };
    },
"restore": async function (a) {
      if ([...jobs.values()].some((job) => job.root === this.store.root && activeJob(job)))
        throw new Error("请先完成或取消当前学习库的出题任务，再恢复备份");
      const backup = a.state;
      if (backup?.portableMaterials?.format !== 'study-materials-backup/v1') return this.store.restore(backup);
      const { portableMaterials, ...state } = backup;
      // Originals are immutable content-addressed files. Validate the complete
      // bundle before changing state; a failed state restore leaves only unused files.
      const referenced = new Set((state.documents || []).flatMap(document => (document.versions || [])
        .flatMap(version => version.attachment ? [version.attachment.path] : [])));
      const supplied = new Set((portableMaterials.attachments || []).map(attachment => attachment.path));
      if ([...referenced].some(path => !supplied.has(path))) throw new Error('Portable backup is missing a material original');
      await importAttachments(this.store.root, portableMaterials.attachments);
      return this.store.restore(state);
    },
"job.cancel": async function (a) {
      const scoped = [...jobs.values()].filter((j) => j.root === this.store.root);
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
          ? "正在停止音频导入；已完成的转写会保留" : "Stopping generation workers; keeping approved draft";
        generationControllers.get(job.id)?.abort(new Error(job.type === "draft-repair"
          ? "后台修题已取消；已修好的题目会保留" : job.type === "audio-import"
          ? "音频导入已取消；已完成的转写会保留" : "Generation cancelled; approved questions were retained"));
        if (queued) {
          job.finishedAt = new Date().toISOString();
          generationControllers.delete(job.id);
        }
      }
      return { jobs: targets.map(publicJob), note: "Cancelling means worker cleanup is pending. Cancelled queued jobs will never start. Saved drafts are retained." };
    },
"job.dismiss": async function (a) {
      const scoped = [...jobs.values()].filter((j) => j.root === this.store.root);
      if (!!a.all === !!a.jobId) throw new Error("Specify jobId or all:true");
      const targets = a.all ? scoped.filter((job) => !activeJob(job)) : [get(scoped, a.jobId, "Study job")];
      if (targets.some(activeJob)) throw new Error("任务还在进行，请先停止或等它结束");
      for (const job of targets) {
        if (job.batchId || job.singleId) await removeAudioBatch(this.store.root, job.batchId || job.singleId);
        if (job.legacy) await this.store.update(s => { s.inbox = (s.inbox || []).filter(item => !(item.kind === 'audio-failed' && item.jobId === job.id)); });
        dropRetry(job.id); jobs.delete(job.id);
      }
      return { dismissed: targets.map((job) => job.id) };
    },
"job.message": async function (a) {
      const candidates = [...jobs.values()].filter((j) => j.root === this.store.root && activeJob(j));
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
      const root = this.store.root,
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
        const draft = (await this.store.read()).drafts.find((d) => d.id === job.draftId);
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
    },
"legacy.import": async function (a) {
      const imported = await importLegacy(
        required(a.path, "Legacy library path"),
      );
      return this.store.update((s) => {
        const createdAt = new Date().toISOString();
        for (const source of imported.sources)
          if (!s.sources.some((x) => x.id === source.id))
            s.sources.push({ createdAt, ...source });
        const existing = s.decks.find((d) => d.id === imported.deck.id);
        if (existing)
          return { id: existing.id, reused: true, warnings: imported.warnings };
        s.decks.push(imported.deck);
        return {
          id: imported.deck.id,
          count: imported.deck.cards.length,
          warnings: imported.warnings,
        };
      });
    }
};
export const mutations = {
"settings": (s, a) => {

      s.settings = checkSettings({ ...s.settings, ...a });
      return s.settings;
    }
};

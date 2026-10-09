import { get } from '../../util.js';
import { validateDeck, norm } from '../../domain.js';
import { reviewedCardFingerprint, cardMatchesReview } from '../../review-integrity.js';
import { explanationIssues, learnerContextIssues, answerLeakIssues, reviewIssues } from '../../assessment-quality.js';
import { reviewDeck, mentionsCard } from '../../generation.js';
import { supplementPublication, supplementBudgetPublication } from '../../runtime/jobs.js';
import { publicationTarget, publicationDuplicates } from '../../bank-import.js';
import { runTouches, runOpen } from '../../study-state.js';
import { withJobUsage } from '../../usage-scope.js';

/** Bank owns publication preflight and optimistic content guards. */
export async function preparePublication(action, a, { state: storagePort, complete: providedComplete, work: { jobs, generationControllers }, jobServices: { activeJob, checkSupplementPublication } }) {
    if (["draft.save", "draft.delete", "draft.publish", "draft.publish.plan", "draft.publish.quick"].includes(action)) {
      const draftId = action === "draft.save" ? a.deck?.id : a.id;
      const publishing = [...jobs.values()].find((job) => job.root === storagePort.root &&
        job.draftId === draftId && job.type === "draft-publish" && activeJob(job));
      if (publishing && a.publishJobId !== publishing.id)
        throw new Error("这份草稿正在后台发布检查，请等待结果");
    }
    if (["draft.publish", "draft.publish.plan", "draft.publish.quick"].includes(action) && [...jobs.values()].some((job) => job.root === storagePort.root && job.draftId === a.id && activeJob(job) && job.type !== "draft-publish" &&
        !(job.type === 'supplement' && job.id === a[supplementPublication])))
      throw new Error("Generation is still updating this draft; wait until it finishes before publishing");
    // `draft.publish.plan` is the whole check of a publication (what is accepted, what the reviews say) without the write; `planned` says it was made and the write follows it.
    if (action === "draft.publish" || action === "draft.publish.plan") {
      if (a[supplementPublication] || a.publishJobId) checkSupplementPublication(a);
      if (action === "draft.publish" && a.planned === true) return a;
      // The quick publication takes the draft as it is (a pasted case with answers): its plan is the write on a copy, with no review.
      if (action === "draft.publish.plan" && a.quick === true) return a;
      const state = await storagePort.read();
      const draft = get(state.drafts, a.id, "Draft");
      const destination = publicationTarget(state, draft, a);
      if (a.draftVersion !== undefined && a.draftVersion !== draft.draftVersion)
        throw new Error("Draft changed in another window; review it before publishing");
      const original = draft.editingDeckId && get(state.decks, draft.editingDeckId, "Deck");
      if (original && (original.contentVersion || 0) !== draft.baseVersion)
        throw new Error("Deck changed; reopen an editing draft");
      if (original && state.runs.some((run) => runTouches(run, original.id) && runOpen(run)))
        throw new Error("该题组还有进行中的学习。请先完成或结束练习，再发布编辑。");
      const structural = validateDeck(draft, state.sources);
      const fatal = structural.errors.filter((issue) => !/^Card \d+:/.test(issue));
      if (fatal.length) throw new Error(fatal.join("\n"));
      const marks = draft.editorial?.reviewedCards || {};
      const rejectedIssues = {};
      for (const issue of structural.errors) {
        if (/^Card \d+: duplicate (learning objective|prompt)$/.test(issue)) continue;
        const match = /^Card (\d+):/.exec(issue);
        if (match) {
          const card = draft.cards[Number(match[1]) - 1];
          if (card) (rejectedIssues[card.id] ||= []).push(issue);
        }
      }
      for (let first = 0; first < draft.cards.length; first++)
        for (let second = first + 1; second < draft.cards.length; second++) {
          const left = draft.cards[first], right = draft.cards[second];
          const duplicate = norm(left.objective) === norm(right.objective)
            ? "学习目标" : norm(left.prompt) === norm(right.prompt) ? "问题" : null;
          if (!duplicate) continue;
          const oldLeft = original?.cards.find((card) => card.id === left.id);
          const oldRight = original?.cards.find((card) => card.id === right.id);
          const leftUnchanged = oldLeft && reviewedCardFingerprint(oldLeft) === reviewedCardFingerprint(left);
          const rightUnchanged = oldRight && reviewedCardFingerprint(oldRight) === reviewedCardFingerprint(right);
          const loser = rightUnchanged && !leftUnchanged ? left : right;
          (rejectedIssues[loser.id] ||= []).push(`${duplicate}与另一道题重复，请修改`);
        }
      if (destination || draft.editorial?.repairOfDeckId || draft.editorial?.partialEdit) {
        const live = destination || get(state.decks, draft.editingDeckId || draft.editorial.repairOfDeckId, "Deck");
        const duplicateInTarget = publicationDuplicates(live.cards);
        for (const card of draft.cards) {
          if (duplicateInTarget(card))
            (rejectedIssues[card.id] ||= []).push("与已发布题目重复，请修改学习目标或问题");
        }
      }
      for (const card of draft.cards) {
        if (rejectedIssues[card.id]) continue;
        const one = { title: draft.title, cards: [card] };
        const issues = [...learnerContextIssues(one), ...explanationIssues(one),
          ...answerLeakIssues(one, draft.editorial?.generation?.constraints)];
        if (issues.length) rejectedIssues[card.id] = issues;
      }
      const pending = draft.cards.filter((card) => !rejectedIssues[card.id] &&
        !cardMatchesReview(marks[card.id], card));
      const autoReview = { marks: {}, checks: [], summary: "" };
      const uncheckedIds = [];
      if (pending.length && providedComplete && !a[supplementBudgetPublication]) {
        const inspect = async (cards, priorBatchConcerns = []) => {
          const sourceIds = new Set(cards.flatMap((card) => card.citations.map((ref) => ref.sourceId)));
          const sources = state.sources.filter((source) => sourceIds.has(source.id));
          const selection = { title: draft.title, cards };
          try {
            const review = await reviewDeck(
              (system, prompt) => typeof a.ask === 'function' ? a.ask(system, prompt, { cardIds: cards.map((card) => card.id) })
                : withJobUsage(jobs.get(a[supplementPublication] || a.publishJobId), undefined, () => providedComplete(system, prompt, (a[supplementPublication] || a.publishJobId) ? {
                jobId: a[supplementPublication] || a.publishJobId, stage: 'Publication review', resultOwner: 'plugin',
                signal: generationControllers.get(a[supplementPublication] || a.publishJobId)?.signal, onEvent() {},
              } : undefined)),
              { sources, deck: selection, kind: "mixed", count: cards.length,
                structuralErrors: [], role: draft.editorial?.generation?.role,
                difficulty: draft.editorial?.generation?.difficulty,
                focus: draft.editorial?.generation?.focus,
                constraints: draft.editorial?.generation?.constraints, priorBatchConcerns },
            );
            const findings = Array.isArray(review.issues) ? review.issues : ["审阅结果缺少问题清单"];
            const unattributed = findings.filter((issue) =>
              !cards.some((card) => mentionsCard(String(issue), card, selection)));
            const checkIssues = reviewIssues({ issues: [], checks: review.checks }, selection);
            const unclearChecks = checkIssues.some((issue) =>
              !cards.some((card) => mentionsCard(String(issue), card, selection)));
            if (cards.length > 1 && (unattributed.length || unclearChecks)) {
              for (const card of cards) await inspect([card], unattributed);
              return;
            }
            for (const card of cards) {
              const check = review.checks?.find((item) => item?.cardId === card.id);
              const issues = [
                ...reviewIssues({ issues: [], checks: check ? [check] : [] }, { cards: [card] }),
                ...findings.filter((issue) => mentionsCard(String(issue), card, selection)),
                ...unattributed,
                ...(cards.length === 1 ? checkIssues : []),
              ];
              if (issues.length) rejectedIssues[card.id] = issues.slice(0, 5);
              else {
                autoReview.marks[card.id] = reviewedCardFingerprint(card);
                autoReview.checks.push(check);
              }
            }
          } catch {
            if (a[supplementPublication] || a.publishJobId) checkSupplementPublication(a);
            if (cards.length > 1) {
              for (const card of cards) await inspect([card]);
            } else uncheckedIds.push(cards[0].id);
          }
        };
        for (let index = 0; index < pending.length; index += 5) {
          await inspect(pending.slice(index, index + 5));
          a.onProgress?.({ reviewed: Math.min(index + 5, pending.length), total: pending.length });
        }
        autoReview.summary = `发布前自动复审 ${autoReview.checks.length} 题，通过逐题质量检查`;
      } else if (!providedComplete || a[supplementBudgetPublication]) {
        uncheckedIds.push(...pending.map((card) => card.id));
      }
      if (a.requireReviewed) for (const cardId of uncheckedIds)
        (rejectedIssues[cardId] ||= []).push('没有通过独立审核，未自动并入题组');
      const acceptedIds = draft.cards.filter((card) => !rejectedIssues[card.id]).map((card) => card.id);
      a = { ...a, draftVersion: draft.draftVersion,
        publishDecision: { acceptedIds, rejectedIssues, uncheckedIds,
          autoReview: autoReview.checks.length ? autoReview : null } };
    }
  return a;
}

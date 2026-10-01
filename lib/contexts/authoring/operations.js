import { currentCourse } from "../../focus.js";
import { get, id } from "../../util.js";
import { readImportFiles } from "../../bulk-import.js";
import { mergeDecks, splitDeck } from "../../deck-organization.js";
import { validateDeck, initialReview } from "../../domain.js";
import { reviewedCardFingerprint } from "../../review-integrity.js";
import { publicationTarget, publicationDuplicates, importJsonDeck } from '../../bank-import.js';
import { markPublicationIssues, contentKey } from '../../card-content.js';
import { runOpen, runTouches } from '../../study-state.js';


/** authoring operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, ports: providedPorts } = ports;
const handlers = {
"deck.import": async function (a) {
      if (a.folder !== undefined && (typeof a.folder !== "string" || a.folder.length > 200)) throw new Error("folder 必须是不超过 200 字的字符串");
      const preferred = currentCourse(await storagePort.read()) || '';
      const files = await readImportFiles(a);
      if (a.into !== undefined && files.length !== 1) throw new Error("into 只能用于单个文件");
      const results = [];
      for (const file of files) {
        if (file.error) { results.push({ file: file.name, error: file.error }); continue; }
        try {
          results.push(await storagePort.update((s) => importJsonDeck(s, file, a, preferred, providedPorts)));
        } catch (error) {
          results.push({ file: file.name, error: error.message });
        }
      }
      const ok = results.filter((r) => !r.error);
      return { files: results.length, imported: ok.length, failed: results.length - ok.length,
        added: ok.reduce((n, r) => n + r.added, 0), skipped: ok.reduce((n, r) => n + r.skipped, 0), results };
    }
};
const mutations = {
"deck.merge": (s, a) => mergeDecks(s, a),
"deck.split": (s, a) => splitDeck(s, a),
"draft.publish.quick": (s, a, ports) => {
      const draft = get(s.drafts, a.id, "Draft");
      if (a.draftVersion !== undefined && draft.draftVersion !== a.draftVersion)
        throw new Error("Draft changed in another window; review it before publishing");
      if (!String(draft.title || "").trim() || !draft.cards.length)
        throw new Error("题组需要标题和至少一道题");
      markPublicationIssues(draft, s.sources);
      const marks = draft.editorial?.reviewedCards || {};
      return ports.mutate("draft.publish", s, { ...a, allowIssues: true,
        publishDecision: { acceptedIds: draft.cards.map((card) => card.id), rejectedIssues: {},
          uncheckedIds: draft.cards.filter((card) => marks[card.id] !== reviewedCardFingerprint(card)).map((card) => card.id) } });
    },
"draft.publish": (s, a) => {
      const draft = get(s.drafts, a.id, "Draft");
      if (
        a.draftVersion !== undefined &&
        draft.draftVersion !== a.draftVersion
      )
        throw new Error(
          "Draft changed in another window; review it before publishing",
        );
      const target = publicationTarget(s, draft, a);
      const beforeIds = new Set(target?.cards.map(card => card.id) || []);
      if (target && !draft.editingDeckId && !draft.editorial?.repairOfDeckId) {
        draft.mergeTargetId = target.id;
        draft.course = target.course || '';
      }
      const decision = a.publishDecision || { acceptedIds: draft.cards.map((card) => card.id), rejectedIssues: {}, uncheckedIds: [] };
      if (a.requireReviewed) {
        const duplicateInTarget = publicationDuplicates(target?.cards || []);
        decision.acceptedIds = decision.acceptedIds.filter(cardId => {
          const card = draft.cards.find(card => card.id === cardId);
          const duplicate = duplicateInTarget(card);
          if (duplicate) (decision.rejectedIssues[cardId] ||= []).push('与目标题组已有题目重复，未并入');
          return !duplicate;
        });
      }
      const accepted = new Set(decision.acceptedIds);
      const rejected = draft.cards.filter((card) => !accepted.has(card.id));
      const acceptedCards = draft.cards.filter((card) => accepted.has(card.id));
      if (acceptedCards.length) {
        const acceptedReport = validateDeck({ title: draft.title, cards: acceptedCards }, s.sources);
        if (acceptedReport.errors.length && !a.allowIssues) throw new Error(acceptedReport.errors.join("\n"));
      }
      const autoReview = decision.autoReview;
      const unchecked = decision.uncheckedIds?.filter((cardId) => accepted.has(cardId)).length || 0;
      draft.editorial ||= {};
      draft.editorial.reviewedCards = { ...draft.editorial.reviewedCards, ...autoReview?.marks };
      if (autoReview?.checks?.length) draft.editorial.publishReview = {
        reviewedAt: new Date().toISOString(), checks: autoReview.checks, summary: autoReview.summary,
      };
      const reviewResult = { autoReviewed: autoReview?.checks?.length || 0, unchecked,
        accepted: acceptedCards.length, rejected: rejected.length };
      const finishDestination = publishedId => {
        if (!draft.mergeTargetId || publishedId === draft.mergeTargetId) return publishedId;
        mergeDecks(s, { sourceIds: [publishedId], targetId: draft.mergeTargetId });
        reviewResult.merged = true;
        return draft.mergeTargetId;
      };
      const receipt = publishedId => {
        const live = get(s.decks, publishedId, 'Published deck');
        return { id: publishedId, deckId: publishedId, ...reviewResult,
          added: live.cards.filter(card => !beforeIds.has(card.id)).length,
          total: live.cards.length };
      };
      if (!acceptedCards.length) {
        draft.editorial.summary = "发布前检查发现问题，题目留在草稿等待处理";
        draft.editorial.rejectedIssues = decision.rejectedIssues;
        draft.draftVersion++;
        return { id: null, ...reviewResult, rejectedDraft: draft };
      }
      const prepareCard = (card, previous) => {
        const next = structuredClone(card);
        next.addedAt = previous?.addedAt || next.addedAt || new Date().toISOString();
        next.review = previous && contentKey(previous) === contentKey(next)
          ? previous.review : initialReview(s.settings);
        next.flag = previous?.flag || "";
        next.requires = previous ? previous.requires || [] : next.requires || [];
        if (previous?.revisions) next.revisions = previous.revisions;
        next.suspended = previous?.suspended || false;
        return next;
      };
      const publishedEditorial = { ...draft.editorial,
        reviewedCards: Object.fromEntries(acceptedCards.flatMap((card) =>
          draft.editorial.reviewedCards[card.id] ? [[card.id, draft.editorial.reviewedCards[card.id]]] : [])),
        uncheckedAtPublish: unchecked };
      delete publishedEditorial.rejectedIssues;
      delete publishedEditorial.repairOfDeckId;
      delete publishedEditorial.partialEdit;
      if (rejected.length) {
        let publishedId;
        if (draft.editingDeckId) {
          const live = get(s.decks, draft.editingDeckId, "Deck");
          if ((live.contentVersion || 0) !== draft.baseVersion)
            throw new Error("Deck changed; reopen an editing draft");
          if (s.runs.some((run) => runTouches(run, live.id) && runOpen(run)))
            throw new Error("该题组还有进行中的学习。请先完成或结束练习，再发布编辑。");
          const old = new Map(live.cards.map((card) => [card.id, card]));
          publishedEditorial.reviewedCards = {
            ...live.editorial?.reviewedCards, ...publishedEditorial.reviewedCards };
          publishedEditorial.uncheckedAtPublish += live.editorial?.uncheckedAtPublish || 0;
          const replacements = new Map(acceptedCards.map((card) => [card.id, prepareCard(card, old.get(card.id))]));
          const cards = draft.editorial.partialEdit
            ? [...live.cards.map((card) => replacements.get(card.id) || card),
              ...acceptedCards.filter((card) => !old.has(card.id)).map((card) => replacements.get(card.id))]
            : draft.cards.flatMap((card) => accepted.has(card.id)
              ? [replacements.get(card.id)] : old.has(card.id) ? [old.get(card.id)] : []);
          const updated = structuredClone(draft);
          delete updated.editingDeckId; delete updated.baseVersion; delete updated.draftVersion;
          Object.assign(live, updated, { id: live.id, cards, editorial: publishedEditorial,
            archived: live.archived, contentVersion: (live.contentVersion || 0) + 1 });
          live.quality = validateDeck(live, s.sources);
          publishedId = live.id;
        } else if (draft.editorial.repairOfDeckId) {
          const live = get(s.decks, draft.editorial.repairOfDeckId, "Deck");
          if (acceptedCards.some((card) => live.cards.some((old) => old.id === card.id)))
            throw new Error("Repair card already exists in the published deck");
          live.cards.push(...acceptedCards.map((card) => prepareCard(card)));
          live.contentVersion = (live.contentVersion || 0) + 1;
          live.editorial ||= {};
          live.editorial.reviewedCards = { ...live.editorial.reviewedCards, ...publishedEditorial.reviewedCards };
          live.editorial.uncheckedAtPublish = (live.editorial.uncheckedAtPublish || 0) + unchecked;
          live.quality = validateDeck(live, s.sources);
          publishedId = live.id;
        } else {
          if (s.decks.some((deck) => deck.id === draft.id)) throw new Error("Deck already exists; publish a new deck id");
          const published = structuredClone(draft);
          published.cards = acceptedCards.map((card) => prepareCard(card));
          published.publishedAt = new Date().toISOString();
          published.editorial = publishedEditorial;
          published.quality = validateDeck(published, s.sources);
          s.decks.push(published);
          publishedId = finishDestination(published.id);
        }
        const repairDraft = { ...draft,
          id: draft.editorial.repairOfDeckId || draft.editorial.partialEdit ? draft.id : id(),
          title: draft.editorial.repairOfDeckId || draft.editorial.partialEdit ? draft.title : `${draft.title} · 待处理`,
          cards: rejected,
          draftVersion: draft.editorial.repairOfDeckId || draft.editorial.partialEdit ? draft.draftVersion + 1 : 1,
          editorial: { ...draft.editorial, summary: "发布前检查发现问题，待处理题目已留在草稿",
            reviewedCards: {}, rejectedIssues: decision.rejectedIssues,
            ...(draft.editingDeckId ? { partialEdit: true } : { repairOfDeckId: publishedId }) },
        };
        delete repairDraft.editorial.publishReview;
        repairDraft.quality = validateDeck(repairDraft, s.sources);
        if (draft.editingDeckId) repairDraft.baseVersion = get(s.decks, draft.editingDeckId, "Deck").contentVersion;
        s.drafts = s.drafts.filter((item) => item.id !== draft.id);
        s.drafts.push(repairDraft);
        return { ...receipt(publishedId), rejectedDraft: repairDraft };
      }
      if (draft.editorial.repairOfDeckId) {
        const live = get(s.decks, draft.editorial.repairOfDeckId, "Deck");
        if (acceptedCards.some((card) => live.cards.some((old) => old.id === card.id)))
          throw new Error("Repair card already exists in the published deck");
        live.cards.push(...acceptedCards.map((card) => prepareCard(card)));
        live.contentVersion = (live.contentVersion || 0) + 1;
        live.editorial ||= {};
        live.editorial.reviewedCards = { ...live.editorial.reviewedCards, ...publishedEditorial.reviewedCards };
        live.editorial.uncheckedAtPublish = (live.editorial.uncheckedAtPublish || 0) + unchecked;
        live.quality = validateDeck(live, s.sources);
        s.drafts = s.drafts.filter((item) => item.id !== draft.id);
        return receipt(live.id);
      }
      const partialEdit = draft.editorial.partialEdit;
      draft.editorial = publishedEditorial;
      if (draft.editingDeckId) {
        const live = get(s.decks, draft.editingDeckId, "Deck");
        if ((live.contentVersion || 0) !== draft.baseVersion)
          throw new Error("Deck changed; reopen an editing draft");
        if (s.runs.some((r) => runTouches(r, live.id) && runOpen(r)))
          throw new Error(
            "该题组还有进行中的学习。请先完成或结束练习，再发布编辑。",
          );
        const updated = structuredClone(draft);
        updated.cards.forEach((q) => {
          const previous = live.cards.find((c) => c.id === q.id);
          q.addedAt = previous?.addedAt || q.addedAt || new Date().toISOString();
          q.review =
            previous && contentKey(previous) === contentKey(q)
              ? previous.review
              : initialReview(s.settings);
          q.flag = previous?.flag || "";
          q.requires = previous ? previous.requires || [] : q.requires || [];
          if (previous?.revisions) q.revisions = previous.revisions;
          q.suspended = previous?.suspended || false;
        });
        if (partialEdit) {
          publishedEditorial.reviewedCards = {
            ...live.editorial?.reviewedCards, ...publishedEditorial.reviewedCards };
          publishedEditorial.uncheckedAtPublish += live.editorial?.uncheckedAtPublish || 0;
          updated.editorial = publishedEditorial;
          const replacements = new Map(updated.cards.map((card) => [card.id, card]));
          updated.cards = [...live.cards.map((card) => replacements.get(card.id) || card),
            ...updated.cards.filter((card) => !live.cards.some((old) => old.id === card.id))];
        }
        delete updated.editingDeckId;
        delete updated.baseVersion;
        delete updated.draftVersion;
        Object.assign(live, updated, {
          id: live.id,
          archived: live.archived,
          contentVersion: (live.contentVersion || 0) + 1,
        });
        live.quality = validateDeck(live, s.sources);
        s.drafts = s.drafts.filter((d) => d.id !== draft.id);
        return receipt(live.id);
      }
      if (s.decks.some((d) => d.id === draft.id))
        throw new Error("Deck already exists; publish a new deck id");
      const published = structuredClone(draft);
      published.publishedAt = new Date().toISOString();
      published.cards.forEach((q) => {
        q.addedAt ||= new Date().toISOString();
        q.review = initialReview(s.settings);
      });
      s.decks.push(published);
      s.drafts = s.drafts.filter((d) => d.id !== a.id);
      return receipt(finishDestination(draft.id));

    }
};
  return { handlers, mutations };
}

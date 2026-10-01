import { currentCourse, courseOf } from "../../focus.js";
import { mergeSuggestionContext, checkedMergeSuggestions } from "../../deck-merge-suggestions.js";
import { parseJson } from "../../generation.js";
import { prepareJsonImport } from "../../json-import.js";
import { libraryCourses, importCourses } from "../../source-courses.js";
import { get, id, required } from "../../util.js";
import { findCard, linkPrerequisite } from "../../prereq.js";
import { notify } from "../../inbox.js";
import { exactDecks } from "../../source-query.js";
import { followupQuestion, followupDigest, currentFollowups } from "../../followup.js";
import { reorderDecks } from "../../deck-organization.js";
import { isSlayDeck } from "../../slay.js";
import { unescapeModelText } from "../../model-text.js";
import { draftShapeErrors, validateDeck } from "../../domain.js";
import { reviewedCardFingerprint } from "../../review-integrity.js";
import { clampInt, searchTerms } from '../../query-input.js';
import { importCourse, cleanFolder } from '../../bank-import.js';


/** bank operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, light: providedLight, complete: providedComplete, call: providedCall } = ports;
const handlers = {
"deck.merge.suggest": async function (a) {
      const state = await storagePort.read();
      const course = typeof a.course === 'string' ? a.course.trim() : currentCourse(state);
      const decks = mergeSuggestionContext(state, course);
      if (decks.length < 2) return { course, proposals: [], method: "too-few-decks" };
      const model = providedLight || providedComplete;
      if (!model) return { course, proposals: [], method: "unavailable" };
      const response = parseJson(await model(
        "Inspect the deck titles and topic names in one course. Suggest up to 8 merges only when decks genuinely cover the same subject or are near duplicates. Preserve all cards. Return JSON {proposals:[{targetId:string,sourceIds:string[],reason:string}]}. Use only provided IDs. Do not merge unrelated modules merely because they share a course. The user will confirm each suggestion.",
        JSON.stringify({ course, decks }),
      ));
      return { course, proposals: checkedMergeSuggestions(response, decks), method: "ai" };
    },
"draft.import.propose": async function (a) {
      const state = await storagePort.read();
      const { deck } = prepareJsonImport(a.text, state.sources);
      const originalTitle = deck.title;
      const courses = libraryCourses(state);
      const fallback = { originalTitle, title: originalTitle.slice(0, 80),
        course: importCourse(state, a, deck),
        mergeTargetId: null, method: "rules" };
      const model = providedLight || providedComplete;
      if (!model) return fallback;
      const examples = deck.cards.slice(0, 8).map((card) => ({
        topic: card.topic, objective: card.objective, prompt: String(card.prompt).slice(0, 180),
      }));
      const candidates = state.decks.filter((item) => !item.archived && !item.systemKind)
        .slice(-30).map((item) => ({ id: item.id, title: item.title, course: courseOf(item),
          topics: [...new Set(item.cards.map((card) => card.topic))].slice(0, 8) }));
      try {
        const answer = parseJson(await model("Suggest filing metadata for imported study cards. Return one JSON object with title, course, mergeTargetId. Keep the title short and specific. Choose an existing course when clearly appropriate. Suggest a merge target only when the cards cover the same focused knowledge area; otherwise null. Do not change any card content.",
          JSON.stringify({ originalTitle, originalFolder: deck.folder, examples, courses, candidates })));
        const title = typeof answer.title === "string" && answer.title.trim()
          ? answer.title.trim().slice(0, 80) : fallback.title;
        const course = a.course !== undefined || deck.course !== undefined ? fallback.course
          : typeof answer.course === "string" && answer.course.trim() ? answer.course.trim().slice(0, 200) : fallback.course;
        const mergeTargetId = candidates.some((item) => item.id === answer.mergeTargetId && item.course === course)
          ? answer.mergeTargetId : null;
        return { originalTitle, title, course, mergeTargetId, method: "ai" };
      } catch { return fallback; }
    },
"draft.get": async function (a) {
      return get((await storagePort.read()).drafts, a.id, "Draft");
    },
"deck.get": async function (a) {
      return get((await storagePort.read()).decks, a.id, "Deck");
    },
"card.link.batch": async function (a) {
      const links = Array.isArray(a.links) ? a.links : [];
      if (!links.length || links.length > 200) throw new Error("links 需要 1–200 项 {cardId, deckId?, requires:{cardId}, remove?}");
      const results = [];
      for (const [index, item] of links.entries()) {
        try {
          if (!item || typeof item !== "object") throw new Error("每一项必须是对象");
          await providedCall("card.link", item);
          results.push({ index, cardId: item.cardId, requires: item.requires?.cardId, ok: true });
        } catch (error) {
          results.push({ index, cardId: item?.cardId, requires: item?.requires?.cardId, ok: false, error: error.message });
        }
      }
      return { linked: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    },
"card.search": async function (a) {
      const terms = searchTerms(a);
      const s = await storagePort.read();
      const limit = clampInt(a.limit, 20, 1, 50);
      const results = [];
      for (const deck of exactDecks(s, a)) {
        if (deck.archived && !a.includeArchived) continue;
        for (const card of deck.cards) {
          const text = [card.topic, card.objective, card.prompt, card.answer].join("\n").toLowerCase();
          const found = terms.filter((t) => text.includes(t));
          if (found.length)
            results.push({ deckId: deck.id, deckTitle: deck.title, course: deck.course ?? deck.folder ?? '', archived: !!deck.archived,
              cardId: card.id, kind: card.kind, topic: card.topic, prompt: String(card.prompt).slice(0, 160), matched: found });
        }
      }
      results.sort((x, y) => y.matched.length - x.matched.length);
      return { terms, total: results.length, results: results.slice(0, limit) };
    }
};
const mutations = {
"deck.course": (s, a) => {
      const deck = get(s.decks, a.id, "Deck");
      if (deck.systemKind) throw new Error("系统题组不能设置课程");
      const course = required(a.course, "课程名称");
      if (course.length > 200) throw new Error("课程名称过长");
      deck.course = course;
      for (const draft of s.drafts) {
        if (draft.editingDeckId !== deck.id && draft.editorial?.repairOfDeckId !== deck.id && draft.mergeTargetId !== deck.id) continue;
        draft.course = course;
        draft.draftVersion = (draft.draftVersion || 0) + 1;
      }
      return { id: deck.id, course };
    },
"deck.reorder": (s, a) => reorderDecks(s, a.ids),
"draft.import": (s, a) => {
      const { source, deck } = prepareJsonImport(a.text, s.sources);
      if (a.title !== undefined) {
        deck.originalTitle = deck.title;
        deck.title = required(a.title, "题组标题");
        if (deck.title.length > 200) throw new Error("题组标题过长");
      }
      deck.course = importCourse(s, a, deck);
      if (a.mergeTargetId !== undefined) {
        const target = get(s.decks, a.mergeTargetId, "目标题组");
        if (target.archived || target.systemKind) throw new Error("只能并入普通题组");
        deck.course = target.course ?? target.folder ?? '';
        deck.mergeTargetId = target.id;
      }
      source.courses = importCourses({ course: deck.course });
      s.sources.push(source);
      s.drafts.push(deck);
      return deck;
    },
"deck.edit": (s, a) => {
      const deck = get(s.decks, a.id, "Deck");
      if (isSlayDeck(deck)) throw new Error("请先将题目恢复到原题组再编辑");
      const existing = s.drafts.find((d) => d.editingDeckId === deck.id);
      if (existing) return existing;
      const draft = {
        ...structuredClone(deck),
        id: id(),
        editingDeckId: deck.id,
        baseVersion: deck.contentVersion || 0,
        draftVersion: 1,
      };
      s.drafts.push(draft);
      return draft;

    },
"card.followup.add": (s, a) => {
      const { deck, card } = findCard(s, a);
      const question = followupQuestion(a.question),
        answer = typeof a.answer === "string" ? a.answer.trim() : "";
      if (!answer || answer.length > 8000) throw new Error("回答不能为空，且最多 8000 字");
      const digest = followupDigest(card);
      const existing = currentFollowups(card).find((item) => item.originalQuestion === question);
      if (existing) return { deckId: deck.id, cardId: card.id, item: existing };
      const item = {
        id: id(),
        at: new Date().toISOString(),
        digest,
        originalQuestion: question,
        question,
        answer: unescapeModelText(answer),
        ...(a.source === "assistant" ? { source: "assistant" } : {}),
      };
      card.followups = [...(card.followups || []), item];
      notify(s, { kind: "followup", deckId: deck.id, cardId: card.id, detail: question });
      return { deckId: deck.id, cardId: card.id, item };
    },
"card.link": (s, a) => {
      const result = linkPrerequisite(
        s,
        { deckId: a.deckId, cardId: a.cardId },
        a.requires || {},
        a.remove === true,
      );
      if (result.linked && !result.existing)
        notify(s, { ...result.dependent, kind: "link", detail: `关联前置题：${findCard(s, result.requires).card.prompt}` });
      return result;
    },
"deck.move": (s, a) => {
      const deck = get(s.decks, a.id, "Deck");
      if (typeof a.folder === "string" && a.folder.length > 200)
        throw new Error("Folder name is too long");
      deck.folder = cleanFolder(a.folder);
      return { id: deck.id, folder: deck.folder };

    },
"draft.save": (s, a) => {
      const d = structuredClone(a.deck);
      d.id = d.id || id();
      const shapeErrors = draftShapeErrors(d);
      if (shapeErrors.length) throw new Error(shapeErrors.join("\n"));
      const report = validateDeck(d, s.sources);
      d.quality = report;
      d.createdAt = new Date().toISOString();
      const old = s.drafts.findIndex((x) => x.id === d.id);
      if (old < 0 && (a.requireExisting || (d.draftVersion !== undefined && d.draftVersion !== 0)))
        throw new Error("草稿已删除或发布；请从学习库新建草稿，不要用旧版本重新创建");
      if (
        old >= 0 &&
        (d.draftVersion || 0) !== (s.drafts[old].draftVersion || 0)
      )
        throw new Error(
          "Draft changed in another window; reopen it before saving",
        );
      if (old >= 0) {
        const previous = s.drafts[old];
        d.editingDeckId = previous.editingDeckId;
        d.baseVersion = previous.baseVersion;
        if (previous.editorial?.rejectedIssues && d.editorial) {
          const before = new Map(previous.cards.map((card) => [card.id, card]));
          d.editorial.rejectedIssues = Object.fromEntries(
            Object.entries(d.editorial.rejectedIssues || {}).filter(([cardId]) => {
              const oldCard = before.get(cardId), newCard = d.cards.find((card) => card.id === cardId);
              return previous.editorial.rejectedIssues[cardId] && oldCard && newCard &&
                reviewedCardFingerprint(oldCard) === reviewedCardFingerprint(newCard);
            }),
          );
          if (Object.keys(previous.editorial.rejectedIssues).length &&
            !Object.keys(d.editorial.rejectedIssues).length &&
            d.editorial.summary === previous.editorial.summary)
            d.editorial.summary = "待处理题已修改，发布前会按新内容重新检查";
        }
      } else if (d.editingDeckId)
        throw new Error("Use deck.edit to create an editing draft");
      d.draftVersion = (d.draftVersion || 0) + 1;
      if (old >= 0) s.drafts[old] = d;
      else s.drafts.push(d);
      return d;

    },
"draft.delete": (s, a) => {

      if (
        a.draftVersion !== undefined &&
        s.drafts.some(
          (d) => d.id === a.id && d.draftVersion !== a.draftVersion,
        )
      )
        throw new Error(
          "Draft changed in another window; reopen it before deleting",
        );
      s.drafts = s.drafts.filter((d) => d.id !== a.id);
      return { ok: true };
    },
"card.flag": (s, a) => {
      const card = get(
        get(s.decks, a.deckId, "Deck").cards,
        a.cardId,
        "Question",
      );
      card.flag =
        typeof a.reason === "string" ? a.reason.slice(0, 1000) : "";
      return { ok: true };

    },
"card.suspend": (s, a) => {
      if (isSlayDeck(get(s.decks, a.deckId, "Deck"))) throw new Error("请使用恢复原题组功能");
      const card = get(
        get(s.decks, a.deckId, "Deck").cards,
        a.cardId,
        "Question",
      );
      card.suspended = a.suspended === true;
      return { ok: true };

    }
};
  return { handlers, mutations };
}

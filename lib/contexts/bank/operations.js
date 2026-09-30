import { currentCourse, courseOf } from "../../focus.js";
import { mergeSuggestionContext, checkedMergeSuggestions } from "../../deck-merge-suggestions.js";
import { parseJson } from "../../generation.js";
import { prepareJsonImport } from "../../json-import.js";
import { libraryCourses, importCourses } from "../../source-courses.js";
import { get, id, required } from "../../util.js";
import { findCard, prerequisiteView, linkPrerequisite } from "../../prereq.js";
import { notify } from "../../inbox.js";
import { readImportFiles } from "../../bulk-import.js";
import { exactDecks } from "../../source-query.js";
import { latestOutcomes } from "../../mastery.js";
import { translateSource, translateCard } from "../../translation.js";
import { suggestionDigest, suggestFollowups, followupQuestion, followupDigest, currentFollowups, answerFollowup } from "../../followup.js";
import { reorderDecks, mergeDecks, splitDeck } from "../../deck-organization.js";
import { slayCard, restoreSlainCard, isSlayDeck } from "../../slay.js";
import { unescapeModelText } from "../../model-text.js";
import { draftShapeErrors, validateDeck, initialReview } from "../../domain.js";
import { reviewedCardFingerprint } from "../../review-integrity.js";
import { importCourse, importJsonDeck, searchTerms, clampInt, currentCard, translateInflight, suggestionInflight, followupInflight, projection, runTouches, patchContent, applyCardContent, cleanFolder, markPublicationIssues, publicationTarget, publicationDuplicates, contentKey, runOpen } from "../../legacy-kernel.js";

export const handlers = {
"deck.merge.suggest": async function (a) {
      const state = await this.store.read();
      const course = typeof a.course === 'string' ? a.course.trim() : currentCourse(state);
      const decks = mergeSuggestionContext(state, course);
      if (decks.length < 2) return { course, proposals: [], method: "too-few-decks" };
      const model = this.light || this.complete;
      if (!model) return { course, proposals: [], method: "unavailable" };
      const response = parseJson(await model(
        "Inspect the deck titles and topic names in one course. Suggest up to 8 merges only when decks genuinely cover the same subject or are near duplicates. Preserve all cards. Return JSON {proposals:[{targetId:string,sourceIds:string[],reason:string}]}. Use only provided IDs. Do not merge unrelated modules merely because they share a course. The user will confirm each suggestion.",
        JSON.stringify({ course, decks }),
      ));
      return { course, proposals: checkedMergeSuggestions(response, decks), method: "ai" };
    },
"draft.import.propose": async function (a) {
      const state = await this.store.read();
      const { deck } = prepareJsonImport(a.text, state.sources);
      const originalTitle = deck.title;
      const courses = libraryCourses(state);
      const fallback = { originalTitle, title: originalTitle.slice(0, 80),
        course: importCourse(state, a, deck),
        mergeTargetId: null, method: "rules" };
      const model = this.light || this.complete;
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
      return get((await this.store.read()).drafts, a.id, "Draft");
    },
"deck.get": async function (a) {
      return get((await this.store.read()).decks, a.id, "Deck");
    },
"card.update.batch": async function (a) {
      const updates = Array.isArray(a.updates) ? a.updates : [];
      if (!updates.length || updates.length > 100) throw new Error("updates 需要 1–100 项 {cardId, deckId?, patch, reason}");
      const results = [];
      for (const [index, item] of updates.entries()) {
        try {
          if (!item || typeof item !== "object") throw new Error("每一项必须是对象");
          const updated = await this.call("card.update", { ...item, quiet: true });
          results.push({ index, cardId: updated.cardId, deckId: updated.deckId, ok: true, scheduleReset: !!updated.scheduleReset });
        } catch (error) {
          results.push({ index, cardId: item?.cardId, ok: false, error: error.message });
        }
      }
      const done = results.filter((r) => r.ok);
      if (done.length) await this.store.update((s) => {
        const { deck, card } = findCard(s, updates[done[0].index]);
        notify(s, { kind: "improve", deckId: deck.id, cardId: card.id,
          detail: done.length > 1 ? `对话批量改进了 ${done.length} 道题` : String(updates[done[0].index].reason || "对话改进了题目").slice(0, 500) });
      });
      return { updated: done.length, failed: results.length - done.length, results };
    },
"card.link.batch": async function (a) {
      const links = Array.isArray(a.links) ? a.links : [];
      if (!links.length || links.length > 200) throw new Error("links 需要 1–200 项 {cardId, deckId?, requires:{cardId}, remove?}");
      const results = [];
      for (const [index, item] of links.entries()) {
        try {
          if (!item || typeof item !== "object") throw new Error("每一项必须是对象");
          await this.call("card.link", item);
          results.push({ index, cardId: item.cardId, requires: item.requires?.cardId, ok: true });
        } catch (error) {
          results.push({ index, cardId: item?.cardId, requires: item?.requires?.cardId, ok: false, error: error.message });
        }
      }
      return { linked: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    },
"deck.import": async function (a) {
      if (a.folder !== undefined && (typeof a.folder !== "string" || a.folder.length > 200)) throw new Error("folder 必须是不超过 200 字的字符串");
      const preferred = currentCourse(await this.store.read()) || '';
      const files = await readImportFiles(a);
      if (a.into !== undefined && files.length !== 1) throw new Error("into 只能用于单个文件");
      const results = [];
      for (const file of files) {
        if (file.error) { results.push({ file: file.name, error: file.error }); continue; }
        try {
          results.push(await this.store.update((s) => importJsonDeck(s, file, a, preferred, this.ports.forContext('bank'))));
        } catch (error) {
          results.push({ file: file.name, error: error.message });
        }
      }
      const ok = results.filter((r) => !r.error);
      return { files: results.length, imported: ok.length, failed: results.length - ok.length,
        added: ok.reduce((n, r) => n + r.added, 0), skipped: ok.reduce((n, r) => n + r.skipped, 0), results };
    },
"card.search": async function (a) {
      const terms = searchTerms(a);
      const s = await this.store.read();
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
    },
"card.get": async function (a) {
      const s = await this.store.read(),
        { deck, card } = findCard(s, a),
        outcome = latestOutcomes(s.attempts),
        cited = new Set(card.citations?.map((c) => c.sourceId));
      return {
        deckId: deck.id,
        deckTitle: deck.title,
        folder: deck.folder || "",
        card: (({ review, revisions, ...content }) => content)(card),
        revisions: (card.revisions || []).map(({ at, reason }) => ({ at, reason })),
        prerequisites: prerequisiteView(s, deck.id, card, outcome),
        requiredBy: s.decks.flatMap((d) =>
          d.cards
            .filter((c) => c.requires?.some((r) => r.deckId === deck.id && r.cardId === card.id))
            .map((c) => ({ deckId: d.id, cardId: c.id, prompt: c.prompt })),
        ),
        sources: s.sources.filter((x) => cited.has(x.id)).map((x) => ({ id: x.id, title: x.title, chars: x.text.length })),
      };
    },
"card.current": async function (a) {

      return this.call("card.get", currentCard(await this.store.read()));
    },
"card.translate": async function (a) {
      const s = await this.store.read();
      const { deck, card } = findCard(s, a);
      const { digest } = translateSource(card);
      if (card.translation && card.translation.digest === digest)
        return { deckId: deck.id, cardId: card.id, cached: true, translation: card.translation };
      if (!this.light) throw new Error("翻译这道题需要可用的模型");
      const key = JSON.stringify([this.store.root, card.id, digest]);
      if (!translateInflight.has(key))
        translateInflight.set(
          key,
          translateCard(this.light, card)
            .then(({ translation }) =>
              this.store.update((st) => {
                const live = findCard(st, a).card;
                if (translateSource(live).digest !== digest) throw new Error("题目已更新，请重新翻译");
                // Re-check under the lock: a parallel call may have saved it already.
                if (!live.translation || live.translation.digest !== digest)
                  live.translation = { lang: "en", at: new Date().toISOString(), digest, ...translation };
                return true;
              }),
            )
            .finally(() => translateInflight.delete(key)),
        );
      await translateInflight.get(key);
      const latest = findCard(await this.store.read(), a).card;
      return { deckId: deck.id, cardId: card.id, cached: false, translation: latest.translation || null };
    },
"card.followup.suggest": async function (a) {
      const { deck, card } = findCard(await this.store.read(), a);
      const digest = suggestionDigest(card, this.language);
      if (card.followupSuggestions?.digest === digest)
        return { questions: card.followupSuggestions.questions };
      if (!this.light) throw new Error("追问需要可用的模型");
      const ref = { deckId: deck.id, cardId: card.id };
      const key = JSON.stringify([this.store.root, card.id, digest]);
      if (!suggestionInflight.has(key)) {
        suggestionInflight.set(key, suggestFollowups(this.light, card).then((result) =>
          this.store.update((s) => {
            const live = findCard(s, ref).card;
            if (suggestionDigest(live, this.language) !== digest) throw new Error("题目或问答已更新，请重新获取推荐问题");
            live.followupSuggestions = { digest, questions: result.questions };
            return result;
          }),
        ).finally(() => suggestionInflight.delete(key)));
      }
      return suggestionInflight.get(key);
    },
"card.followup": async function (a) {
      const question = followupQuestion(a.question);
      const { deck, card } = findCard(await this.store.read(), a);
      const digest = followupDigest(card);
      // Retrying a submitted question reuses its answer, including after a reload.
      const existing = currentFollowups(card).find((item) => item.originalQuestion === question);
      if (existing) return { deckId: deck.id, cardId: card.id, item: existing };
      if (!this.light) throw new Error("追问需要可用的模型");
      const ref = { deckId: deck.id, cardId: card.id };
      const key = JSON.stringify([this.store.root, card.id, digest, question]);
      if (!followupInflight.has(key)) {
        followupInflight.set(key, answerFollowup(this.light, card, question).then((reply) =>
          this.store.update((s) => {
            const live = findCard(s, ref).card;
            if (followupDigest(live) !== digest) throw new Error("题目已更新，请返回新版题目重新追问");
            const saved = currentFollowups(live).find((item) => item.originalQuestion === question);
            if (saved) return { item: saved, prepEnabled: false };
            const item = { id: id(), at: new Date().toISOString(), digest, originalQuestion: question, ...reply };
            live.followups = [...(live.followups || []), item];
            notify(s, { kind: "followup", ...ref, detail: item.question });
            return { item, prepEnabled: this.coach && s.learner?.consent.prep === true };
          }),
        ).then(({ item, prepEnabled }) => {
          if (prepEnabled)
            this.queuePrep({ ...ref, reason: "followup", followupId: item.id });
          return item;
        }).finally(() => followupInflight.delete(key)));
      }
      return { ...ref, item: await followupInflight.get(key) };
    },
"card.locate": async function (a) {
      const { deck, card } = findCard(await this.store.read(), a);
      return { deck: { id: deck.id, title: deck.title, folder: deck.folder || "" }, card };
    }
};
export const mutations = {
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
"deck.merge": (s, a) => mergeDecks(s, a),
"deck.split": (s, a) => splitDeck(s, a),
"card.slay": (s, a) => {
      const result = slayCard(s, a);
      return a.runId ? projection(s, get(s.runs, a.runId, "Review")) : result;
    },
"card.restore": (s, a) => restoreSlainCard(s, a),
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
"deck.archive": (s, a) => {
      const deck = get(s.decks, a.id, "Deck");
      if (isSlayDeck(deck)) throw new Error("斩题组不参与复习，请逐题恢复到原题组");
      deck.archived = a.archived === true;
      if (deck.archived)
        for (const run of s.runs.filter(
          (r) => runTouches(r, deck.id) && !r.closedAt,
        ))
          run.closedAt = new Date().toISOString();
      return { ok: true };

    },
"card.update": (s, a) => {
      const { card } = findCard(s, a);
      const content = patchContent(card, a.patch);
      const reason = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim().slice(0, 500) : "Improved in conversation";
      const result = applyCardContent(s, a, content, reason);
      // Only the conversation calls card.update; the learner may have moved on.
      const { deck: updatedDeck, card: updated } = findCard(s, a);
      // A batch sends one letter for the whole set instead of one per card.
      if (!a.quiet) notify(s, { kind: "improve", deckId: updatedDeck.id, cardId: updated.id, detail: reason });
      return result;

    },
"card.revert": (s, a) => {
      const { card } = findCard(s, a);
      const last = card.revisions?.at(-1);
      if (!last) throw new Error("This question has no earlier version");
      return { ...applyCardContent(s, a, last.content, null, { keepAnswered: true }), reverted: last.reason };

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

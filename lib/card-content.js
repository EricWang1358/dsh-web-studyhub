
import { initialReview, shuffled, validateDeck } from "./domain.js";
import { findCard } from "./prereq.js";
import { followupDigest } from "./followup.js";


const UNGRADABLE_ISSUE = /(?:expected object|answer is required|prompt is required|need 3–6 options|options have an invalid shape|invalid correct option count|duplicate option id|each option requires|cloze |scoring rubric|unsupported kind)/i;

function markPublicationIssues(deck, sources) {
  const issues = deck.cards.map(() => []);
  for (const issue of validateDeck(deck, sources).errors) {
    const match = /^Card (\d+): (.*)$/.exec(issue);
    if (match && issues[Number(match[1]) - 1])
      issues[Number(match[1]) - 1].push(match[2]);
  }
  deck.cards.forEach((card, index) => {
    if (issues[index].length) {
      card.publicationIssues = issues[index];
      card.publicationUngrable = issues[index].some((issue) => UNGRADABLE_ISSUE.test(issue));
    } else {
      delete card.publicationIssues;
      delete card.publicationUngrable;
    }
  });
}

const EDITABLE = ["topic", "objective", "prompt", "answer", "hint", "explanation", "misconception", "rubric", "options", "citations", "cloze"];

const substance = (c) =>
  JSON.stringify([
    c.kind,
    c.prompt,
    c.answer,
    (c.options || []).map((o) => [o.id, o.text, o.correct]),
    c.cloze ? [c.cloze.text, c.cloze.answers] : null,
  ]);

function applyCardContent(s, ref, content, revision, { keepAnswered = false } = {}) {
  const { deck, card } = findCard(s, ref),
    index = deck.cards.indexOf(card);
  const next = { ...card, ...content, id: card.id, kind: card.kind };
  const cards = deck.cards.map((c, i) => (i === index ? next : c));
  const errors = validateDeck({ title: deck.title, cards }, s.sources).errors.filter((e) =>
    e.startsWith(`Card ${index + 1}:`),
  );
  const previousIssues = new Set((card.publicationIssues || []).map((issue) => `Card ${index + 1}: ${issue}`));
  if (errors.some((issue) => !previousIssues.has(issue))) throw new Error(errors.join("\n"));
  const reset = substance(card) !== substance(next);
  const inExam = s.runs.some((run) =>
    run.mode === "exam" && !run.closedAt && run.entries.some((entry) =>
      (entry.deckId ?? run.deckId) === deck.id && entry.card.id === card.id,
    ),
  );
  if (reset && inExam)
    throw new Error("Finish or end the active exam before changing this question or its answer");
  const { review, flag, suspended, requires, revisions, ...previous } = card;
  next.review = reset ? initialReview(s.settings) : card.review;
  next.revisions = revision
    ? [...(card.revisions || []), { at: new Date().toISOString(), reason: revision, content: previous }].slice(-5)
    : (card.revisions || []).slice(0, -1);
  /* 追问是学习者自己问出来的，不能因为改题就消失：把它们的内容摘要迁到新版
     题目上（内容变了的标 stale，界面提示这条基于旧版题目），而不是留在旧摘要
     下再也显示不出来。 */
  const before = followupDigest(card),
    after = followupDigest(next),
    at = new Date().toISOString();
  if (card.followups?.length && before !== after)
    next.followups = card.followups.map((item) =>
      item.digest === before ? { ...item, digest: after, ...(reset ? { staleFrom: item.staleFrom || at } : {}) } : item,
    );
  delete next.followupSuggestions;
  deck.cards[index] = next;
  if (card.publicationIssues?.length) markPublicationIssues(deck, s.sources);
  const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
  if (editing) {
    editing.cards = editing.cards.map((c) => (c.id === card.id ? structuredClone(next) : c));
    editing.draftVersion = (editing.draftVersion || 0) + 1;
  }
  let refreshed = 0;
  for (const run of s.runs.filter((r) => !r.closedAt)) {
    let resetEntry = false;
    for (const entry of run.entries)
      if ((entry.deckId ?? run.deckId) === deck.id && entry.card.id === card.id) {
        // A background fix must not change an unanswered question while it is
        // on screen. The learner answers the snapshot they actually saw.
        if (keepAnswered && !entry.feedback && run.entries[run.index] === entry) {
          entry.keepSnapshot = true;
          continue;
        }
        // A coach fix after answering must not wipe the feedback on screen.
        // With the same answer key the improved wording replaces the card in
        // place and the result stands; a changed key keeps the answered
        // snapshot and applies from the next attempt.
        if (keepAnswered && entry.feedback) {
          if (answerKey(entry.card) === answerKey(next)) {
            entry.card = structuredClone(next);
            delete entry.keepSnapshot;
            refreshed++;
          } else entry.keepSnapshot = true;
          continue;
        }
        resetEntry = syncReviewEntry(entry, next) || resetEntry;
        refreshed++;
      }
    if (resetEntry) run.queueVersion = (run.queueVersion || 0) + 1;
  }
  return { deckId: deck.id, cardId: card.id, scheduleReset: reset, revisions: next.revisions.length, refreshedInOpenRuns: refreshed };
}

const answerKey = (c) =>
  JSON.stringify([
    c.kind,
    (c.options || []).map((o) => [o.id, o.correct === true]).sort(),
    c.cloze ? c.cloze.answers?.map((a) => [a.id, a.value]) : null,
  ]);

function patchContent(card, raw) {
  const patch = raw && typeof raw === "object" ? raw : {};
  const content = {};
  for (const key of EDITABLE) if (patch[key] !== undefined) content[key] = patch[key];
  if (!Object.keys(content).length) throw new Error("Nothing to update");
  if (card.kind === "cloze") {
    // A cloze card shows cloze.text, not prompt. Patches may change just the
    // text (answers stay), and a reworded prompt that carries exactly the
    // card's blank markers is the new cloze text too.
    if (content.cloze && typeof content.cloze === "object")
      content.cloze = { ...card.cloze, ...content.cloze, answers: content.cloze.answers ?? card.cloze?.answers };
    const ids = (text) => JSON.stringify([...String(text).matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]).sort());
    if (!content.cloze && typeof content.prompt === "string" && card.cloze?.answers?.length &&
      ids(content.prompt) === JSON.stringify(card.cloze.answers.map((x) => x.id).sort()))
      content.cloze = { ...card.cloze, text: content.prompt };
  }
  if (content.cloze !== undefined && card.kind !== "cloze") delete content.cloze;
  /* 修题 must not change what kind of question this is: blank markers {{…}} on a card that is not a fill-in-the-blank would be shown to the learner as raw text. */
  if (card.kind !== "cloze") {
    const marker = /\{\{[^{}]+\}\}/, introduced = (key) => {
      const was = card[key], next = content[key];
      if (Array.isArray(next)) return next.some((option, index) => marker.test(String(option?.text ?? "")) && !marker.test(String((was?.find?.((x) => x.id === option?.id) ?? was?.[index])?.text ?? "")));
      return typeof next === "string" && marker.test(next) && !marker.test(String(was ?? ""));
    };
    if (["prompt", "answer", "hint", "explanation", "misconception", "options"].some(introduced))
      throw new Error("这不是填空题，题目、答案和选项里不能出现 {{…}} 填空标记；请保持原题型，把题干写成完整的问句");
  }
  if (!Object.keys(content).length) throw new Error("Nothing to update");
  // Options may be patched by id, e.g. only their explanations.
  if (Array.isArray(content.options) && card.options) {
    const byId = (o) => card.options.find((x) => x.id === o?.id);
    content.options = content.options.every(byId)
      ? card.options.map((o) => ({ ...o, ...content.options.find((x) => x.id === o.id) }))
      : content.options.map((o) => ({ ...(byId(o) || {}), ...o }));
  }
  return content;
}

function syncReviewEntry(entry, next) {
  const reset = substance(entry.card) !== substance(next);
  const sameOptions = JSON.stringify((entry.card.options || []).map((o) => [o.id, o.correct])) ===
    JSON.stringify((next.options || []).map((o) => [o.id, o.correct]));
  if (reset) {
    // Only a question the learner already answered needs "please answer again".
    const hadAnswer = !!entry.feedback || !!entry.revealed;
    if (entry.feedback) entry.previousVersions = [...(entry.previousVersions || []), {
      card: structuredClone(entry.card), feedback: structuredClone(entry.feedback),
      order: entry.order ? [...entry.order] : undefined,
      signature: entry.signature, at: new Date().toISOString(),
    }];
    entry.feedback = null;
    entry.revealed = false;
    entry.selected = null;
    delete entry.signature;
    entry.startedAt = Date.now();
    entry.contentUpdated = hadAnswer;
  }
  entry.card = structuredClone(next);
  if (!sameOptions && next.options) entry.order = shuffled(next.options.map((o) => o.id));
  return reset;
}

const contentKey = (card) => {
  // `part` (lib/deck-parts.js) says which part of its deck a card came from; it is not what the card asks.
  const { review, flag, suspended, requires, revisions, part, ...content } = card;
  return JSON.stringify(content);
};

export { UNGRADABLE_ISSUE, markPublicationIssues, EDITABLE, substance, applyCardContent, answerKey, patchContent, syncReviewEntry, contentKey };

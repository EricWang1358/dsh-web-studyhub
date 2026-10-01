import { get, id } from "../../util.js";
import { notify } from "../../inbox.js";
import { findCard, linkPrerequisite } from "../../prereq.js";
import { parseSparInput, captureQuestion, samePrompt } from "../../capture.js";
import { currentCourse } from "../../focus.js";
import { resolveCourse, importCourses } from "../../source-courses.js";
import { initialReview } from "../../domain.js";
import { MAX_INGEST_CHARS, INGEST_KINDS, parseIngest } from "../../ingest.js";
import { cleanFolder } from '../../bank-import.js';
import { currentCard } from '../../study-state.js';
import { MISTAKES, ingestView, recordingDestination } from '../../recording-state.js';


/** recording operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, complete: providedComplete } = ports;
async function inTurn(root, task) {
  const previous = ports.work.captureQueues.get(root) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  ports.work.captureQueues.set(root, next);
  try { return await next; } finally { if (ports.work.captureQueues.get(root) === next) ports.work.captureQueues.delete(root); }
}
const handlers = {
"capture": async function (a) {
      if (!providedComplete)
        throw new Error("A model is required to file questions");
      const parsed =
        a.question !== undefined
          ? { question: String(a.question).trim(), kind: a.kind || "flashcard" }
          : parseSparInput(a.input);
      if (parsed.question.length < 2 || parsed.question.length > 2000)
        throw new Error("Question must be 2–2000 characters");
      if (!["flashcard", "quiz", "multi", "open"].includes(parsed.kind))
        throw new Error("Unknown question kind");
      // Start the scope read at receipt but reserve FIFO order before awaiting it.
      const submission = storagePort.read();
      const startedAt = Date.now();
      return inTurn(storagePort.root, async () => {
        const timings = { queueMs: Date.now() - startedAt, modelCalls: [] };
        const submitted = await submission;
        const requestedDeckId = typeof a.deckId === 'string' ? a.deckId : undefined;
        const requestedDeck = requestedDeckId && submitted.decks.find(deck => deck.id === requestedDeckId && !deck.archived && !deck.systemKind);
        if (requestedDeckId && !requestedDeck) throw new Error('Requested capture deck does not exist or is archived');
        const dependent = a.requiredBy === 'current' || parsed.prerequisite ? currentCard(submitted)
          : a.requiredBy ? (({ deck, card }) => ({ deckId: deck.id, cardId: card.id }))(findCard(submitted, a.requiredBy)) : null;
        const originDeck = requestedDeck || (dependent && findCard(submitted, dependent).deck);
        const preferred = currentCourse(submitted);
        const course = resolveCourse(submitted, originDeck ? {} : a,
          { course: originDeck ? originDeck.course ?? originDeck.folder ?? '' : undefined,
            preferred: preferred ?? '' });
        const state = await storagePort.read();
        const plan = await captureQuestion(async (system, prompt) => {
          const start = Date.now();
          try { return await providedComplete(system, prompt); }
          finally { timings.modelCalls.push({ stage: system.startsWith("You file") ? "placement" : "author", elapsedMs: Date.now() - start, inputChars: system.length + prompt.length }); }
        }, state, {
          ...parsed,
          deckId: requestedDeckId,
          course,
          answer: typeof a.answer === "string" ? a.answer.slice(0, 8000) : "",
          related: dependent && { ...dependent, prompt: findCard(state, dependent).card.prompt },
          notes: typeof a.notes === "string" ? a.notes.slice(0, 4000) : "",
        });
        const link = (s, result) => {
          if (!dependent) return result;
          try {
            const linked = linkPrerequisite(s, dependent, result);
            if (!linked.existing)
              notify(s, { ...linked.dependent, kind: "link", detail: `新增前置题：${result.prompt}` });
            return {
              ...result,
              prerequisiteFor: { ...dependent, prompt: findCard(s, dependent).card.prompt },
              alreadyLinked: !!linked.existing,
            };
          } catch (e) {
            return { ...result, linkError: e.message };
          }
        };
        const result = await storagePort.update((s) => link(s, (() => {
          const at = (deck, card) => ({
            deckId: deck.id,
            deckTitle: deck.title,
            folder: deck.folder || "",
            course: deck.course ?? deck.folder ?? '',
            topic: card.topic,
            cardId: card.id,
            prompt: card.prompt,
            kind: card.kind,
          });
          if (plan.duplicate) {
            const deck = get(s.decks, plan.duplicate.deckId, "Deck");
            return {
              status: "duplicate",
              ...at(deck, get(deck.cards, plan.duplicate.cardId, "Question")),
            };
          }
          let deck = plan.deckId && get(s.decks, plan.deckId, 'Deck');
          if (deck && (deck.archived || deck.systemKind)) throw new Error('Requested capture deck does not exist or is archived');
          const created = !deck;
          if (!deck) {
            deck = {
              id: id(),
              title: plan.newDeck?.title || "随手问",
              folder: cleanFolder(plan.newDeck?.folder),
              course,
              cards: [],
            };
            s.decks.push(deck);
          }
          const same = deck.cards.find((c) => samePrompt(c.prompt, plan.card.prompt));
          if (same) return { status: "duplicate", ...at(deck, same) };
          if (plan.note) s.sources.push({ createdAt: new Date().toISOString(), ...plan.note, courses: importCourses({ course }) });
          const card = {
            ...plan.card,
            review: initialReview(s.settings),
            capturedAt: new Date().toISOString(),
          };
          deck.cards.push(card);
          // Keep an open editing draft in step so publishing it cannot drop the new card.
          const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
          if (editing) {
            editing.cards.push(structuredClone(card));
            editing.draftVersion = (editing.draftVersion || 0) + 1;
          }
          return {
            status: "added",
            ...at(deck, card),
            answer: card.answer,
            grounded: !plan.note,
            newDeck: created,
          };
        })()));
        return { ...result, performance: { ...timings, totalMs: Date.now() - startedAt } };
      });
    },
"ingest.status": async function (a) {
      // Tool results must be JSON objects; the snapshot keeps `ingest: null`.
      return ingestView(await storagePort.read()) || { active: false };
    },
"ingest": async function (a) {
      if (!providedComplete) throw new Error("A model is required to record questions");
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (text.length < 8) throw new Error("Paste at least one question");
      if (text.length > MAX_INGEST_CHARS)
        throw new Error(`Pasted text is ${text.length} characters; send at most ${MAX_INGEST_CHARS} per batch`);
      // Queue admission must not race the asynchronous submission snapshot.
      const submission = storagePort.read();
      return inTurn(storagePort.root, async () => {
        const submitted = await submission;
        const mode = submitted.ingest?.active ? structuredClone(submitted.ingest) : {};
        const destination = recordingDestination(submitted, a, mode);
        const kind = a.kind ?? mode.kind ?? "auto", mistakes = a.mistakes ?? mode.mistakes ?? "auto";
        if (!INGEST_KINDS.includes(kind)) throw new Error("Unknown question kind");
        if (!MISTAKES.includes(mistakes)) throw new Error("mistakes must be auto, all or none");
        const state = await storagePort.read();
        const resolved = recordingDestination(state, destination);
        const target = resolved.deckId ? get(state.decks, resolved.deckId, 'Deck') : null;
        const { deckTitle, folder, course } = destination;
        const source = {
          id: id(),
          title: String(a.title || `对话录入 · ${deckTitle} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).slice(0, 200),
          text,
          origin: "conversation",
          courses: importCourses({ course }),
          createdAt: new Date().toISOString(),
        };
        const parsed = await parseIngest(providedComplete, {
          text,
          kind,
          mistakes,
          source,
          existing: target ? target.cards.map((c) => c.objective) : [],
        });
        return storagePort.update((s) => {
          let deck = target && get(s.decks, target.id, 'Deck');
          if (deck && (deck.archived || deck.systemKind)) throw new Error('请选择未归档的普通题组');
          const created = !deck;
          const report = { added: [], duplicates: [], skipped: [], ignored: parsed.ignored };
          const fresh = [];
          for (const r of parsed.results) {
            const label = String(r.card.prompt || "").slice(0, 80);
            if (r.errors.length) {
              report.skipped.push({ prompt: label, reason: r.errors.join("; ") });
              continue;
            }
            const twin = (deck ? [deck] : [])
              .flatMap((d) => d.cards.map((c) => ({ d, c })))
              .find(({ c }) => samePrompt(c.prompt, r.card.prompt));
            if (twin || fresh.some((x) => samePrompt(x.card.prompt, r.card.prompt))) {
              report.duplicates.push({ prompt: label, deckTitle: twin?.d.title || deckTitle, topic: twin?.c.topic });
              continue;
            }
            fresh.push(r);
          }
          if (fresh.length) {
            if (!deck) {
              deck = { id: id(), title: deckTitle, folder, course, cards: [] };
              s.decks.push(deck);
            }
            s.sources.push(source);
            const timestamp = new Date().toISOString();
            for (const r of fresh) {
              const card = {
                ...r.card,
                review: initialReview(s.settings),
                capturedAt: timestamp,
                origin: "conversation",
                ...(r.inferred ? { flag: "答案由模型推断，待核对" } : {}),
              };
              deck.cards.push(card);
              if (r.wrong)
                s.attempts.push({
                  id: id(),
                  quiz_id: card.id,
                  deckId: deck.id,
                  topic: card.topic,
                  timestamp,
                  grade: 1,
                  imported: "mistake",
                });
              report.added.push({
                cardId: card.id,
                kind: card.kind,
                topic: card.topic,
                prompt: card.prompt.slice(0, 80),
                mistake: r.wrong,
                answerInferred: r.inferred,
              });
            }
            const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
            if (editing) {
              editing.cards.push(...fresh.map((r) => structuredClone(deck.cards.find((c) => c.id === r.card.id))));
              editing.draftVersion = (editing.draftVersion || 0) + 1;
            }
            if (mode.active && s.ingest?.active && (mode.id ? s.ingest.id === mode.id : s.ingest.startedAt === mode.startedAt)) {
              s.ingest.added = (s.ingest.added || 0) + fresh.length;
              if (!s.ingest.deckId && !a.deckId && !a.deckTitle) s.ingest.deckId = deck.id;
            }
          }
          return {
            deckId: deck?.id || null,
            deckTitle,
            folder,
            course,
            newDeck: !!deck && created,
            sourceId: fresh.length ? source.id : null,
            ...report,
          };
        });
      });
    }
};
const mutations = {
"ingest.start": (s, a) => {
      const kind = a.kind ?? "auto",
        mistakes = a.mistakes ?? "auto";
      if (!INGEST_KINDS.includes(kind)) throw new Error("Unknown question kind");
      if (!MISTAKES.includes(mistakes)) throw new Error("mistakes must be auto, all or none");
      if (!a.deckId && !String(a.deckTitle || '').trim()) throw new Error("Choose a deck or name a new one");
      const destination = recordingDestination(s, a);
      s.ingest = {
        id: id(),
        active: true,
        ...destination,
        kind,
        mistakes,
        added: 0,
        startedAt: new Date().toISOString(),
      };
      return ingestView(s);

    },
"ingest.stop": (s, a) => {
      const was = ingestView(s);
      if (s.ingest) s.ingest.active = false;
      return { stopped: !!was, added: was?.added || 0, deckTitle: was?.deckTitle || null };

    }
};
  return { handlers, mutations };
}

import { ui, uiFormat, errorMessage } from "./i18n.js";
import React from "react";
import Markdown from "./Markdown.jsx";
import { Badge, Button, InlineMessage, TextInput, Tooltip } from "./components/index.js";
import { useStudy } from "./study-context.jsx";
import BookQaButton, { BookQaAuto, hasCourseBook } from "./book/BookQaButton.jsx";

/* bookQa (optional): { course, mode: 'manual' | 'auto', onMode(mode), book (ui/book/BookQaButton.jsx useBookQa, shared with the page), note } — the card's
   course and the 自动加入复习全书 setting (settings.book.qaToBook). With a book for that course each Q&A has 「加入复习全书」. The automatic adds are made by
   the practice page (ui/review/QuestionRun.jsx), which is on screen even while this list is folded away; `note` says when one failed.
   noteQa (optional): { savedIn(followupId) -> noteId | '', onSave(followupId), onOpen(noteId) } — 「存进笔记」 under each Q&A (#1017): into this question's
   learning note once (note.qa.add); saved, it reads 已存进笔记 · 打开. Needs no review book. */
export default function ExplanationFollowup({ run, readOnly = false, onDerive, onAskMore = null, deriving = false, bookQa = null, noteQa = null, cardNotes = [], onOpenBookSection = null }) {
  const { call } = useStudy();
  const book = bookQa?.book;
  const withBook = !!book && book.ready && hasCourseBook(book.courses, bookQa.course ?? "");
  const canReadBookSection = run?.mode !== "exam" && !run?.complete && typeof onOpenBookSection === "function";
  const [open, setOpen] = React.useState(false);
  const [questions, setQuestions] = React.useState([]);
  const [custom, setCustom] = React.useState(false);
  const [question, setQuestion] = React.useState("");
  const [thinkingNote, setThinkingNote] = React.useState("");
  const customTriggerRef = React.useRef(null);
  const [added, setAdded] = React.useState([]);
  const [pending, setPending] = React.useState("");
  const [error, setError] = React.useState("");
  const lock = React.useRef(false);
  const ref = { deckId: run.deckId, cardId: run.card.id };
  const baseFollowups = run.solution?.followups ?? run.followups ?? [];
  const items = [...new Map([...baseFollowups, ...added].map((item) => [item.id, item])).values()];
  // Each Q&A folds. The newest starts open and the rest closed, so a card with
  // many follow-ups stays short; an answer that arrives later opens by itself.
  const [openIds, setOpenIds] = React.useState(() => new Set(items.length ? [items.at(-1).id] : []));
  const seen = React.useRef(null);
  seen.current ||= new Set(items.map((item) => item.id));
  const itemKey = items.map((item) => item.id).join("|");
  React.useEffect(() => {
    const fresh = items.filter((item) => !seen.current.has(item.id));
    if (!fresh.length) return;
    fresh.forEach((item) => seen.current.add(item.id));
    setOpenIds(new Set([fresh.at(-1).id]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids
  }, [itemKey]);
  const toggle = (id, open) => setOpenIds((previous) => {
    if (previous.has(id) === open) return previous;
    const next = new Set(previous);
    if (open) next.add(id); else next.delete(id);
    return next;
  });
  const allOpen = items.length > 0 && items.every((item) => openIds.has(item.id));
  if (readOnly && !items.length) return null;

  async function suggest() {
    setOpen(true);
    if (lock.current || questions.length) return;
    lock.current = true;
    setPending("suggest");
    setError("");
    try {
      const result = await call("card.followup.suggest", ref);
      setQuestions(result.questions);
    } catch (e) { setError(e.message); }
    finally { lock.current = false; setPending(""); }
  }

  async function ask(text, noteText = "") {
    const cleanText = String(text || "").trim();
    const cleanNote = String(noteText || "").trim().slice(0, 200);
    if (lock.current || (!cleanText && !cleanNote)) return;
    lock.current = true;
    setPending("answer");
    setError("");
    if (cleanNote) {
      Promise.resolve(call("attempt.errorReason.set", {
        ...ref,
        ...(run.id ? { runId: run.id } : {}),
        thinkingNote: cleanNote,
      })).catch(() => {});
    }
    const mergedQuestion = cleanNote
      ? (cleanText ? `${cleanText}\n\n${uiFormat("刚才卡住的思路：{0}", [cleanNote])}` : cleanNote)
      : cleanText;
    try {
      const result = await call("card.followup", { ...ref, question: mergedQuestion.slice(0, 1000) });
      setAdded((previous) => [...previous.filter((item) => item.id !== result.item.id), result.item]);
      setQuestions([]);
      setQuestion("");
      setThinkingNote("");
      setCustom(false);
      setOpen(false);
    } catch (e) { setError(e.message); }
    finally { lock.current = false; setPending(""); }
  }

  return (
    <section className="explanation-followup" aria-label={ui("讲解追问")}>
      {withBook && <div className="followup-book">
        <BookQaAuto mode={bookQa.mode} onChange={bookQa.onMode} />
        {bookQa.note && <InlineMessage tone="error">{bookQa.note}</InlineMessage>}
      </div>}
      {items.length > 1 && (
        <div className="followup-head">
          <span>{uiFormat("{0} 条问答", [items.length])}</span>
          <Button variant="link" size="sm" onClick={() => setOpenIds(allOpen ? new Set() : new Set(items.map((item) => item.id)))}>
            {allOpen ? ui("全部收起") : ui("全部展开")}
          </Button>
        </div>
      )}
      {items.map((item) => {
        const title = item.kind === "terms" && Array.isArray(item.terms) && item.terms.length
          ? uiFormat("补词：{0}", [item.terms.join(ui("、"))])
          : item.question;
        return (
        <details className="followup-item" key={item.id} open={openIds.has(item.id)}
          onToggle={(event) => toggle(item.id, event.currentTarget.open)}>
          <summary><Badge size="sm" tone="accent" className="en-mark">Q&amp;A</Badge><span className="followup-item__title">{title}</span>
            <span className="followup-state" aria-hidden="true">{openIds.has(item.id) ? ui("收起") : ui("展开")}</span></summary>
          <Markdown text={item.answer} />
          {(withBook || noteQa || canReadBookSection) && (
            <div className="followup-actions">
              {withBook && <BookQaButton refOf={{ ...ref, followupId: item.id }} book={book} />}
              {noteQa && <NoteQaButton followupId={item.id} noteQa={noteQa} cardNotes={cardNotes} />}
              {canReadBookSection && (
                <Button variant="link" size="sm" iconEnd="arrow-right" className="book-section-button" data-usage="review.book-section" data-tour="review-book-section" data-book-section-link="followup" onClick={onOpenBookSection}>
                  {ui("读全书这一节")}
                </Button>
              )}
            </div>
          )}
          {/* A long answer can be folded from its end, landing back on its question. */}
          {/* 出成题: this Q&A becomes a question of its own, as a prerequisite of this card or standalone (a background task, the result goes to the deck and the inbox). */}
          {onDerive && <div className="followup-derive" role="group" aria-label={ui("用这个问答出题")}>
            <Button variant="link" size="sm" data-usage="review.derive-prereq" disabled={deriving} onClick={() => onDerive(item.id, "prerequisite")}>{ui("出成前置题")}</Button>
            <Button variant="link" size="sm" data-usage="review.derive-standalone" disabled={deriving} onClick={() => onDerive(item.id, "standalone")}>{ui("出成独立题")}</Button>
          </div>}
          <Button variant="link" size="sm" className="followup-fold" onClick={(event) => {
            const summary = event.currentTarget.closest("details")?.querySelector("summary");
            toggle(item.id, false);
            requestAnimationFrame(() => summary?.scrollIntoView({ block: "nearest" }));
          }}>{ui("收起")}</Button>
        </details>
        );
      })}
      {readOnly && onAskMore && items.length > 0 && (
        <Button size="sm" variant="secondary" onClick={onAskMore}>{ui("继续追问")}</Button>
      )}
      {!readOnly && <><Button size="sm" aria-expanded={open} disabled={!call} lock={!!pending}
        onClick={() => open ? setOpen(false) : suggest()}>{ui("追问？")}</Button>
      {" "}
      <Button size="sm" disabled={!call} lock={!!pending}
        onClick={() => ask(ui("请重新讲清楚这道题：先解释必要概念，再从题目条件一步步推到答案，用最小例子说明最容易混淆的地方，最后告诉我下次遇到类似题该怎么判断。若原题解有错或依据不足，请明确指出。"))}>{ui("重新讲清楚")}</Button>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {open && (
        <div className="followup-picker">
          {questions.map((text) => (
            <Button key={text} className="followup-picker__choice" size="sm" wrap align="start" lock={!!pending} onClick={() => ask(text)}>{text}</Button>
          ))}
          <Button ref={customTriggerRef} className="followup-picker__choice" size="sm" lock={pending === "answer"} aria-expanded={custom}
            onClick={() => setCustom(!custom)}>{ui("你的疑问")}</Button>
          {custom && (
            <form onSubmit={(event) => { event.preventDefault(); ask(question, thinkingNote); }}>
              <label className="followup-picker__field">{ui("你的疑问")}<textarea className="followup-picker__input" autoFocus value={question} maxLength={1000} rows={3} disabled={pending === "answer"}
                  placeholder={ui("写下你想弄清楚的地方，也可以接着上面的回答问…")}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.shiftKey && !event.altKey) {
                      if (!pending && (question.trim() || thinkingNote.trim())) {
                        event.preventDefault();
                        ask(question, thinkingNote);
                      }
                      return;
                    }
                    if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !question.trim() && !thinkingNote.trim()) {
                      event.preventDefault();
                      event.stopPropagation();
                      const cardEl = event.currentTarget.closest?.(".question-card");
                      setCustom(false);
                      requestAnimationFrame(() => {
                        if (customTriggerRef.current?.focus) customTriggerRef.current.focus({ preventScroll: true });
                        else cardEl?.focus?.({ preventScroll: true });
                      });
                    }
                  }} />
              </label>
              <label className="followup-picker__field">
                {ui("刚才卡在哪一步 / 是怎么想的？（选填）")}
                <TextInput
                  type="text"
                  data-thinking-note=""
                  value={thinkingNote}
                  maxLength={200}
                  disabled={pending === "answer"}
                  placeholder={ui("用一句话记下刚才卡住的思路，便于后续精准提醒")}
                  onChange={(event) => setThinkingNote(event.target.value)}
                />
              </label>
              <div className="followup-picker__actions">
                <Button className="followup-picker__submit" type="submit" variant="primary" size="sm" busy={pending === "answer"} disabled={!!pending || (!question.trim() && !thinkingNote.trim())}>{ui("解答并添加")}</Button>
                <Button variant="quiet" size="sm" lock={pending === "answer"} onClick={() => {
                  setCustom(false);
                  requestAnimationFrame(() => { customTriggerRef.current?.focus?.({ preventScroll: true }); });
                }}>{ui("取消")}</Button>
              </div>
            </form>
          )}
          {error && !questions.length && !pending && <Button className="followup-picker__choice" size="sm" onClick={suggest}>{ui("重新推荐问题")}</Button>}
        </div>
      )}
      {pending && <p className="muted small" role="status">{pending === "suggest" ? ui("正在准备 3 个追问…") : ui("正在解答，完成后会保存到本题，可继续下一题。")}</p>}</>}
    </section>
  );
}

/** 「存进笔记」 of one Q&A: saved, 已存进笔记 · 打开 opens the note (the note badges of the snapshot say which follow-ups a note holds). */
function NoteQaButton({ followupId, noteQa, cardNotes = [] }) {
  const [working, setWorking] = React.useState(false), [error, setError] = React.useState("");
  const noteId = noteQa.savedIn(followupId);
  if (noteId) {
    const note = cardNotes.find((item) => item.noteId === noteId || item.id === noteId);
    const title = note?.title?.trim();
    const count = note?.followupIds?.length || 0;
    const tip = title && count > 0
      ? uiFormat("已存进「{0}」（含 {1} 条问答）", [title, count])
      : title
        ? uiFormat("已存进「{0}」", [title])
        : count > 0
          ? uiFormat("笔记中已保存 {0} 条问答", [count])
          : "";
    const button = (
      <Button variant="link" size="sm" iconEnd="arrow-right" className="note-qa-button" data-note-qa="saved" onClick={() => noteQa.onOpen(noteId)}>
        {ui("已存进笔记 · 打开")}
      </Button>
    );
    return tip ? <Tooltip layer content={tip}>{button}</Tooltip> : button;
  }
  const save = async () => {
    setWorking(true); setError("");
    try { await noteQa.onSave(followupId); } catch (failure) { setError(errorMessage(failure)); } finally { setWorking(false); }
  };
  return (
    <span className="note-qa-button">
      <Button variant="link" size="sm" icon="note" data-note-qa="save" busy={working} onClick={save}>{ui("存进笔记")}</Button>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </span>
  );
}

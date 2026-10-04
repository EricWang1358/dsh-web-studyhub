import { ui, uiFormat } from "./i18n.js";
import React from "react";
import Markdown from "./Markdown.jsx";
import { Button, InlineMessage } from "./components/index.js";
import { useStudy } from "./study-context.jsx";

export default function ExplanationFollowup({ run, readOnly = false, onDerive, deriving = false }) {
  const { call } = useStudy();
  const [open, setOpen] = React.useState(false);
  const [questions, setQuestions] = React.useState([]);
  const [custom, setCustom] = React.useState(false);
  const [question, setQuestion] = React.useState("");
  const [added, setAdded] = React.useState([]);
  const [pending, setPending] = React.useState("");
  const [error, setError] = React.useState("");
  const lock = React.useRef(false);
  const ref = { deckId: run.deckId, cardId: run.card.id };
  const items = [...new Map([...(run.solution.followups || []), ...added].map((item) => [item.id, item])).values()];
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

  async function ask(text) {
    if (lock.current || !text.trim()) return;
    lock.current = true;
    setPending("answer");
    setError("");
    try {
      const result = await call("card.followup", { ...ref, question: text.trim() });
      setAdded((previous) => [...previous.filter((item) => item.id !== result.item.id), result.item]);
      setQuestions([]);
      setQuestion("");
      setCustom(false);
      setOpen(false);
    } catch (e) { setError(e.message); }
    finally { lock.current = false; setPending(""); }
  }

  return (
    <section className="explanation-followup" aria-label={ui("讲解追问")}>
      {items.length > 1 && (
        <div className="followup-head">
          <span>{uiFormat("{0} 条问答", [items.length])}</span>
          <Button variant="link" size="sm" onClick={() => setOpenIds(allOpen ? new Set() : new Set(items.map((item) => item.id)))}>
            {allOpen ? ui("全部收起") : ui("全部展开")}
          </Button>
        </div>
      )}
      {items.map((item) => (
        <details className="followup-item" key={item.id} open={openIds.has(item.id)}
          onToggle={(event) => toggle(item.id, event.currentTarget.open)}>
          <summary><span className="en-tag">Q&amp;A</span><h4>{item.question}</h4>
            <span className="followup-state" aria-hidden="true">{openIds.has(item.id) ? ui("收起") : ui("展开")}</span></summary>
          <Markdown text={item.answer} />
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
      ))}
      {!readOnly && <><Button size="sm" aria-expanded={open} disabled={!call || !!pending}
        onClick={() => open ? setOpen(false) : suggest()}>{ui("追问？")}</Button>
      {" "}
      <Button size="sm" disabled={!call || !!pending}
        onClick={() => ask(ui("请重新讲清楚这道题：先解释必要概念，再从题目条件一步步推到答案，用最小例子说明最容易混淆的地方，最后告诉我下次遇到类似题该怎么判断。若原题解有错或依据不足，请明确指出。"))}>{ui("重新讲清楚")}</Button>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {open && (
        <div className="followup-picker">
          {questions.map((text) => (
            <Button key={text} size="sm" wrap align="start" disabled={!!pending} onClick={() => ask(text)}>{text}</Button>
          ))}
          <Button size="sm" disabled={pending === "answer"} aria-expanded={custom}
            onClick={() => setCustom(!custom)}>{ui("你的疑问")}</Button>
          {custom && (
            <form onSubmit={(event) => { event.preventDefault(); ask(question); }}>
              <label>{ui("你的疑问")}<textarea autoFocus value={question} maxLength={1000} rows={3} disabled={pending === "answer"}
                  placeholder={ui("写下你想弄清楚的地方，也可以接着上面的回答问…")}
                  onChange={(event) => setQuestion(event.target.value)} />
              </label>
              <Button type="submit" variant="primary" size="sm" busy={pending === "answer"} disabled={!!pending || !question.trim()}>{ui("解答并添加")}</Button>
            </form>
          )}
          {error && !questions.length && !pending && <Button size="sm" onClick={suggest}>{ui("重新推荐问题")}</Button>}
        </div>
      )}
      {pending && <p className="muted small" role="status">{pending === "suggest" ? ui("正在准备 3 个追问…") : ui("正在解答，完成后会保存到本题，可继续下一题。")}</p>}</>}
    </section>
  );
}

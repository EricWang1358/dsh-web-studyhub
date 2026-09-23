import React from "react";
import Markdown from "./Markdown.jsx";

export default function ExplanationFollowup({ run, call }) {
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
    <section className="explanation-followup" aria-label="讲解追问">
      {items.map((item) => (
        <article className="followup-item" key={item.id}>
          <div className="en-tag">Q&amp;A</div>
          <h4>{item.question}</h4>
          <Markdown text={item.answer} />
        </article>
      ))}
      <button type="button" className="pill" aria-expanded={open} disabled={!call || !!pending}
        onClick={() => open ? setOpen(false) : suggest()}>追问？</button>
      {" "}
      <button type="button" className="pill" disabled={!call || !!pending}
        onClick={() => ask("请重新讲清楚这道题：先解释必要概念，再从题目条件一步步推到答案，用最小例子说明最容易混淆的地方，最后告诉我下次遇到类似题该怎么判断。若原题解有错或依据不足，请明确指出。")}>重新讲清楚</button>
      {error && <p role="alert" className="warning">{error}</p>}
      {open && (
        <div className="followup-picker">
          {questions.map((text) => (
            <button type="button" key={text} disabled={!!pending} onClick={() => ask(text)}>{text}</button>
          ))}
          <button type="button" className="pill" disabled={pending === "answer"} aria-expanded={custom}
            onClick={() => setCustom(!custom)}>你的疑问</button>
          {custom && (
            <form onSubmit={(event) => { event.preventDefault(); ask(question); }}>
              <label>你的疑问
                <textarea autoFocus value={question} maxLength={1000} rows={3} disabled={pending === "answer"}
                  placeholder="写下你想弄清楚的地方，也可以接着上面的回答问…"
                  onChange={(event) => setQuestion(event.target.value)} />
              </label>
              <button type="submit" className="primary pill" disabled={!!pending || !question.trim()}>解答并添加</button>
            </form>
          )}
          {error && !questions.length && !pending && <button type="button" className="pill" onClick={suggest}>重新推荐问题</button>}
        </div>
      )}
      {pending && <p className="muted small" role="status">{pending === "suggest" ? "正在准备 3 个追问…" : "正在解答，完成后会保存到本题，可继续下一题。"}</p>}
    </section>
  );
}

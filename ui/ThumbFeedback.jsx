import React, { useEffect, useRef, useState } from "react";

/* 👍/👎 一键反馈。👎 立即记录并展开标签，停手 1.2 秒把新选的标签一次提交，
   服务端据此在后台改题或备更难/更基础的题。G/B 与标签数字键由这里自己处理，
   是否响应快捷键由 App 的 canShortcut 判断（焦点在面板、不在输入框）。 */

const TAGS = [
  ["stem-vague", "题干太空"],
  ["bad-options", "选项太烂"],
  ["too-easy", "太简单"],
  ["too-hard", "太难"],
  ["wrong-answer", "答案有误"],
  ["unclear-explanation", "解析不清"],
];
const IDLE_MS = 1200;

export default function ThumbFeedback({ run, call, canShortcut, onSent }) {
  const [vote, setVote] = useState(run.vote?.vote || null),
    [tags, setTags] = useState(run.vote?.tags || []),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const sent = useRef(new Set(run.vote?.tags || [])),
    submitting = useRef(new Set()),
    saved = useRef({ vote: run.vote?.vote || null, tags: run.vote?.tags || [] }),
    pending = useRef(Promise.resolve()),
    timer = useRef(null),
    flushRef = useRef(null),
    cardKey = `${run.id}:${run.card?.id}`;
  const activeKey = useRef(cardKey);
  // Each card starts from its own recorded vote.
  useEffect(() => {
    // Leaving a card mid-selection still submits what was picked for it.
    if (flushRef.current) flushRef.current();
    setVote(run.vote?.vote || null);
    setTags(run.vote?.tags || []);
    sent.current = new Set(run.vote?.tags || []);
    submitting.current = new Set();
    saved.current = { vote: run.vote?.vote || null, tags: run.vote?.tags || [] };
    setOpen(false);
    setError("");
    activeKey.current = cardKey;
    clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);
  useEffect(() => () => {
    clearTimeout(timer.current);
    flushRef.current?.();
  }, []);

  const post = (args, key = cardKey) => {
    pending.current = pending.current.catch(() => {}).then(() =>
      call("coach.feedback", { deckId: run.deckId, cardId: run.card.id, ...args }));
    return pending.current
      .then((r) => {
        if (activeKey.current === key) {
          args.tags?.forEach((tag) => submitting.current.delete(tag));
          saved.current = {
            vote: args.vote,
            tags: args.vote === "up" ? [] : [...new Set([...(saved.current.vote === "down" ? saved.current.tags : []), ...(args.tags || [])])],
          };
          sent.current = new Set(saved.current.tags);
          setVote(saved.current.vote);
          setTags((current) => args.vote === "up" ? [] : [...new Set([...current, ...saved.current.tags])]);
          setError("");
        }
        onSent?.(r);
      })
      .catch((failure) => {
        if (activeKey.current === key) {
          args.tags?.forEach((tag) => submitting.current.delete(tag));
          setError(`反馈未保存：${failure.message || String(failure)}。请重试。`);
          setVote(saved.current.vote);
          setTags(saved.current.tags);
          sent.current = new Set(saved.current.tags);
          setOpen(false);
        }
      });
  };
  function thumb(next) {
    setVote(next);
    setError("");
    if (next === "up") {
      clearTimeout(timer.current);
      flushRef.current = null;
      setOpen(false);
      setTags([]);
    } else setOpen(true);
    post({ vote: next, tags: [] });
  }
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  function toggle(tag) {
    if (sent.current.has(tag) || submitting.current.has(tag)) return;
    const list = tagsRef.current;
    const nextList = list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag];
    tagsRef.current = nextList;
    setTags(nextList);
    setVote("down");
    clearTimeout(timer.current);
    const flush = () => {
      flushRef.current = null;
      const fresh = nextList.filter((t) => !sent.current.has(t));
      fresh.forEach((tag) => submitting.current.add(tag));
      if (fresh.length) post({ vote: "down", tags: fresh });
    };
    flushRef.current = flush;
    timer.current = setTimeout(() => {
      flush();
      setOpen(false);
    }, IDLE_MS);
  }

  const latest = useRef({});
  latest.current = { open, thumb, toggle, canShortcut };
  useEffect(() => {
    function key(e) {
      const { open, thumb, toggle, canShortcut } = latest.current;
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }
      if (!canShortcut(e)) return;
      const k = e.key.toLowerCase();
      if (k === "g") {
        e.preventDefault();
        thumb("up");
      } else if (k === "b") {
        e.preventDefault();
        if (open) setOpen(false);
        else thumb("down");
      } else if (open && /^[1-6]$/.test(e.key)) {
        // Capture phase: the tray owns digits while it is open.
        e.preventDefault();
        e.stopImmediatePropagation();
        toggle(TAGS[Number(e.key) - 1][0]);
      }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  return (
    <span className="thumbs" onPointerUp={(e) => {
      // Pointer feedback should leave Enter available for the next question.
      // Keyboard activation retains normal button focus and accessibility.
      e.currentTarget.closest(".study-app")?.focus({ preventScroll: true });
    }}>
      <button className="pill" aria-pressed={vote === "up"} aria-keyshortcuts="G" title="这题不错（G）" onClick={() => thumb("up")}>👍</button>
      <button className="pill" aria-pressed={vote === "down"} aria-expanded={open} aria-keyshortcuts="B" title="这题有问题（B），选标签后自动优化" onClick={() => (open ? setOpen(false) : thumb("down"))}>👎</button>
      {error && <small className="warning" role="alert">{error}</small>}
      {open && (
        <span className="thumb-tray" role="group" aria-label="哪里不好">
          {TAGS.map(([id, label], i) => (
            <button key={id} className={"coach-chip" + (tags.includes(id) ? " on" : "")} aria-pressed={tags.includes(id)} disabled={sent.current.has(id) || submitting.current.has(id)} onClick={() => toggle(id)}>
              <kbd>{i + 1}</kbd>{label}
            </button>
          ))}
          <small>选好停一下就自动提交；已提交的标签不能撤销，改题在后台进行。</small>
        </span>
      )}
    </span>
  );
}

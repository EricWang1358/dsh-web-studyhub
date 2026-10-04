import { ui, uiFormat, errorMessage } from "./i18n.js";
import React, { useEffect, useId, useRef, useState } from "react";
import { asksWhatTheSourceSays } from "../lib/question-voice.js";
import { Chip, Icon, InlineMessage, useToast } from "./components/index.js";
import { feedbackOutcome } from "./card-fix.js";
import { useComponentCss } from "./components/css.js";
import thumbCss from "./thumb-feedback.css";

/* 👍/👎 一键反馈。👎 立即记录并展开标签，停手 1.2 秒把新选的标签一次提交，
   服务端据此备更难/更基础的题；改题类标签交给复习页的「修题」（onFix），不再静默改题。G/B 与标签数字键由这里自己处理，
   是否响应快捷键由 App 的 canShortcut 判断（焦点在面板、不在输入框）。 */

const TAGS = [
  ["stem-vague", "题干太空"],
  ["bad-options", "选项太烂"],
  ["too-easy", "太简单"],
  ["too-hard", "太难"],
  ["wrong-answer", "答案有误"],
  ["unclear-explanation", "解析不清"],
  ["source-recall", "只问资料怎么说"],
];
const IDLE_MS = 1200;

export default function ThumbFeedback({ run, call, canShortcut, onSent, onFix }) {
  const [vote, setVote] = useState(run.vote?.vote || null),
    [tags, setTags] = useState(run.vote?.tags || []),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  useComponentCss(thumbCss, "study-thumb-feedback");
  const toast = useToast(), trayId = useId(), voteId = useId();
  // The timers and queued posts outlive the render that created them: they read the latest callbacks.
  const callbacks = useRef({});
  callbacks.current = { toast, onFix, onSent };
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

  // `implicit`: the bare 👎 fallback, which only records (no tag was picked, so there is nothing to hand to 修题).
  const post = (args, key = cardKey, implicit = false) => {
    pending.current = pending.current.catch(() => {}).then(() =>
      call("coach.feedback", { deckId: run.deckId, cardId: run.card.id, ...(callbacks.current.onFix ? { rewriteVia: "assist" } : {}), ...args }));
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
        callbacks.current.onSent?.(r);
        if (activeKey.current === key) announce(args, r, implicit);
      })
      .catch((failure) => {
        if (activeKey.current === key) {
          args.tags?.forEach((tag) => submitting.current.delete(tag));
          setError(uiFormat("反馈未保存：{0}。请重试。", [errorMessage(failure)]));
          setVote(saved.current.vote);
          setTags(saved.current.tags);
          sent.current = new Set(saved.current.tags);
          setOpen(false);
        }
      });
  };
  // What the learner is told once a batch of tags is saved. A rewrite tag opens the 修题 box (its own visible feedback); difficulty tags only record.
  function announce(args, r, implicit) {
    const { fix, note } = feedbackOutcome(args, r, { implicit });
    if (fix.length) callbacks.current.onFix?.(fix);
    if (note) callbacks.current.toast.info(note);
  }
  function thumb(next) {
    setVote(next);
    setError("");
    if (next === "up") {
      clearTimeout(timer.current);
      flushRef.current = null;
      setOpen(false);
      setTags([]);
    } else {
      setOpen(true);
      clearTimeout(timer.current);
      const fallback = () => {
        if (flushRef.current !== fallback) return;
        flushRef.current = null;
        if (!tagsRef.current.length) post({ vote: "down", tags: ["general-quality"] }, cardKey, true);
        setOpen(false);
      };
      flushRef.current = fallback;
      timer.current = setTimeout(fallback, IDLE_MS);
    }
    post({ vote: next, tags: [] });
    // A stem that asks what the source says is already known to be the problem: the reason is picked for the learner (it can still be unpicked before it is sent).
    if (next === "down" && asksWhatTheSourceSays(run.card?.prompt) && !sent.current.has("source-recall") && !submitting.current.has("source-recall") && !tagsRef.current.includes("source-recall")) toggle("source-recall");
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
      } else if (open && /^[1-7]$/.test(e.key)) {
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
      <button className="tool-icon" aria-label={ui("这题不错")} aria-pressed={vote === "up"} aria-keyshortcuts="G" title={ui("这题不错（G）")} onClick={() => thumb("up")}><Icon name="thumb-up" /></button>
      <button className="tool-icon" aria-label={ui("这题有问题")} data-vote={vote === "down" ? "on" : undefined} aria-expanded={open} aria-controls={open ? trayId : undefined} aria-describedby={vote === "down" ? voteId : undefined} aria-keyshortcuts="B" title={ui("这题有问题（B），选标签说明哪里不好")} onClick={() => (open ? setOpen(false) : thumb("down"))}><Icon name="thumb-down" /></button>
      {vote === "down" && <span id={voteId} className="sh-visually-hidden">{ui("已标记这题有问题")}</span>}
      {error && <InlineMessage tone="error" className="thumbs__error">{error}</InlineMessage>}
      {open && (
        <span id={trayId} className="thumb-tray" role="group" aria-label={ui("哪里不好")}>
          {TAGS.map(([id, label], i) => (
            <Chip key={id} selected={tags.includes(id)} disabled={sent.current.has(id) || submitting.current.has(id)} onClick={() => toggle(id)}>
              <kbd>{i + 1}</kbd>{ui(label)}
            </Chip>
          ))}
          <small>{ui("选好停一下就自动提交；已提交的标签不能撤销。改题类问题会带到下方的「修题」。")}</small>
        </span>
      )}
    </span>
  );
}

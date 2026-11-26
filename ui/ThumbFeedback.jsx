import { ui, uiFormat, errorMessage } from "./i18n.js";
import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { asksWhatTheSourceSays } from "../lib/question-voice.js";
import { Button, Chip, Icon, InlineMessage, useDismiss, useToast } from "./components/index.js";
import { feedbackOutcome } from "./card-fix.js";
import { useComponentCss } from "./components/css.js";
import { hasVisibleOverlayOutside } from "./components/use-dismiss.js";
import thumbCss from "./thumb-feedback.css";
import { useStudy } from "./study-context.jsx";
import { CourseRuleConfirm } from "./course-rules/CourseRuleAdd.jsx";
import { ruleTextsForTags } from "./course-rules/tag-rules.js";

/* 👍/👎 一键反馈。👎 立即记录并展开标签，不会在尚未选标签时自动收起或静默提交；选好标签后可在托盘内从容多选，
   点「提交标签」/收起托盘/切题时提交，或指针与焦点都离开托盘后停手 4 秒再提交。改题类标签交给复习页的「修题」（onFix），不再静默改题。
   G/B 与标签数字键由这里自己处理，是否响应快捷键由 App 的 canShortcut 判断（焦点在面板、不在输入框）。 */

const TAGS = [
  ["stem-vague", "题干太空"],
  ["bad-options", "选项太烂"],
  ["too-easy", "太简单"],
  ["too-hard", "太难"],
  ["wrong-answer", "答案有误"],
  ["unclear-explanation", "解析不清"],
  ["source-recall", "只问资料怎么说"],
];
const IDLE_MS = 4000;

/* On the practice page the two thumbs are items of the toolbar's 更多 menu (ui/ReviewToolbar.jsx, #671): it passes `buttons={false}`, and this component then keeps
   the vote, the tag tray and the G / B keys, and hands the menu two calls through `ref` ({ up(), down() }) and the vote through `onVote`.
   `courseRules` (ui/course-rules/use-course-rules.js): with it the tray offers 「设为本课守则」 for the chosen tags (#889); the confirmation stays after the tray closes. */
export default forwardRef(function ThumbFeedback({ run, canShortcut, onSent, onFix, onVote, onInteract, buttons = true, courseRules = null }, ref) {
  const { call } = useStudy();
  const [vote, setVote] = useState(run.vote?.vote || null),
    [tags, setTags] = useState(run.vote?.tags || []),
    [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [ruleTexts, setRuleTexts] = useState(null);
  useComponentCss(thumbCss, "study-thumb-feedback");
  const toast = useToast(), trayId = useId(), voteId = useId();
  // The timers and queued posts outlive the render that created them: they read the latest callbacks.
  const callbacks = useRef({});
  callbacks.current = { toast, onFix, onSent, onInteract };
  const rootRef = useRef(null);
  const trayHovered = useRef(false);
  const trayFocused = useRef(false);
  const sent = useRef(new Set(run.vote?.tags || [])),
    submitting = useRef(new Set()),
    saved = useRef({ vote: run.vote?.vote || null, tags: run.vote?.tags || [] }),
    pending = useRef(Promise.resolve()),
    timer = useRef(null),
    flushRef = useRef(null),
    cardKey = `${run.id}:${run.card?.id}`;
  const activeKey = useRef(cardKey);
  const cardMeta = useRef({ deckId: run.deckId, cardId: run.card?.id, key: cardKey });
  // Each card starts from its own recorded vote.
  useEffect(() => {
    // Leaving a card mid-selection still submits what was explicitly picked for it.
    if (flushRef.current) flushRef.current();
    cardMeta.current = { deckId: run.deckId, cardId: run.card?.id, key: cardKey };
    setVote(run.vote?.vote || null);
    setTags(run.vote?.tags || []);
    sent.current = new Set(run.vote?.tags || []);
    submitting.current = new Set();
    saved.current = { vote: run.vote?.vote || null, tags: run.vote?.tags || [] };
    trayHovered.current = false;
    trayFocused.current = false;
    setOpen(false);
    setError("");
    setRuleTexts(null);
    activeKey.current = cardKey;
    clearTimeout(timer.current);
    timer.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);
  useEffect(() => () => {
    clearTimeout(timer.current);
    timer.current = null;
    flushRef.current?.();
  }, []);

  // `implicit`: the bare 👎 fallback, which only records (no tag was picked, so there is nothing to hand to 修题).
  const post = (args, meta = cardMeta.current, implicit = false) => {
    const key = typeof meta === "string" ? meta : meta.key;
    const deckId = typeof meta === "string" ? run.deckId : meta.deckId;
    const cardId = typeof meta === "string" ? run.card?.id : meta.cardId;
    pending.current = pending.current.catch(() => {}).then(() =>
      call("coach.feedback", { deckId, cardId, ...(callbacks.current.onFix ? { rewriteVia: "assist" } : {}), ...args }));
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
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const clearIdleTimer = () => {
    clearTimeout(timer.current);
    timer.current = null;
  };
  const pendingTags = () => tagsRef.current.filter((t) => !sent.current.has(t) && !submitting.current.has(t));
  const flushPickedTags = (meta = cardMeta.current) => {
    clearIdleTimer();
    flushRef.current = null;
    const fresh = pendingTags();
    if (!fresh.length) return;
    fresh.forEach((tag) => submitting.current.add(tag));
    post({ vote: "down", tags: fresh }, meta);
  };
  const scheduleIdleSubmit = () => {
    clearIdleTimer();
    if (!pendingTags().length) {
      flushRef.current = null;
      return;
    }
    const meta = { ...cardMeta.current };
    const flush = () => flushPickedTags(meta);
    flushRef.current = flush;
    // Pause auto-submit while the learner's pointer or keyboard focus is inside the tag tray.
    if (trayHovered.current || trayFocused.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      flush();
      setOpen(false);
    }, IDLE_MS);
  };
  const closeTray = () => {
    trayHovered.current = false;
    trayFocused.current = false;
    flushPickedTags();
    setOpen(false);
  };
  // #1275: clicking outside the tag tray closes it cleanly (Escape stays in the capture handler below so focus returns to the card).
  useDismiss({ open, onClose: closeTray, refs: rootRef, escape: false });
  function thumb(next) {
    callbacks.current.onInteract?.();
    setVote(next);
    setError("");
    if (next === "up") {
      clearIdleTimer();
      flushRef.current = null;
      trayHovered.current = false;
      trayFocused.current = false;
      setOpen(false);
      setTags([]);
    } else {
      clearIdleTimer();
      flushRef.current = null;
      setOpen(true);
    }
    post({ vote: next, tags: [] });
    // A stem that asks what the source says is already known to be the problem: the reason is picked for the learner (it can still be unpicked before it is sent).
    if (next === "down" && asksWhatTheSourceSays(run.card?.prompt) && !sent.current.has("source-recall") && !submitting.current.has("source-recall") && !tagsRef.current.includes("source-recall")) toggle("source-recall");
  }
  function toggle(tag) {
    if (sent.current.has(tag) || submitting.current.has(tag)) return;
    callbacks.current.onInteract?.();
    const list = tagsRef.current;
    const nextList = list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag];
    tagsRef.current = nextList;
    setTags(nextList);
    setVote("down");
    scheduleIdleSubmit();
  }

  const confirmOpen = Boolean(ruleTexts && courseRules?.course);
  const latest = useRef({});
  latest.current = { open, confirmOpen, thumb, toggle, closeTray, canShortcut };
  useImperativeHandle(ref, () => ({ up: () => latest.current.thumb("up"), down: () => (latest.current.open ? (callbacks.current.onInteract?.(), latest.current.closeTray()) : latest.current.thumb("down")) }), []);
  useEffect(() => { onVote?.(vote, tags); }, [vote, tags]); // eslint-disable-line react-hooks/exhaustive-deps -- the menu and tips read the vote and tags; the callback is not a trigger
  useEffect(() => {
    function key(e) {
      const { open, confirmOpen, thumb, toggle, closeTray, canShortcut } = latest.current;
      if (e.key === "Escape" && open) {
        if (confirmOpen || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
        const root = rootRef.current;
        if (hasVisibleOverlayOutside(root)) return;
        const t = e.target;
        if (t && typeof t.closest === "function" && (!root || !root.contains(t))
          && t.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        closeTray();
        const target = root?.closest?.(".review-body")?.querySelector?.(".question-card") || root?.closest?.(".study-app");
        target?.focus?.({ preventScroll: true });
        return;
      }
      if (!canShortcut(e)) return;
      const k = e.key.toLowerCase();
      if (k === "g") {
        e.preventDefault();
        thumb("up");
      } else if (k === "b") {
        e.preventDefault();
        callbacks.current.onInteract?.();
        if (open) closeTray();
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

  const hasUnsentTags = tags.some((t) => !sent.current.has(t) && !submitting.current.has(t));

  return (
    <span ref={rootRef} className="thumbs" data-tour={buttons ? "review-thumbs" : undefined} onPointerUp={(e) => {
      // Pointer feedback should leave Enter available for the next question.
      // Keyboard activation retains normal button focus and accessibility.
      e.currentTarget.closest(".study-app")?.focus({ preventScroll: true });
    }}>
      {buttons && <button className="tool-icon thumbs__button" aria-label={ui("这题不错")} aria-pressed={vote === "up"} aria-keyshortcuts="G" title={ui("这题不错（G）")} onClick={() => thumb("up")}><Icon name="thumb-up" /></button>}
      {buttons && <button className="tool-icon thumbs__button" aria-label={ui("这题有问题")} data-vote={vote === "down" ? "on" : undefined} aria-expanded={open} aria-controls={open ? trayId : undefined} aria-describedby={vote === "down" ? voteId : undefined} aria-keyshortcuts="B" title={ui("这题有问题（B），选标签说明哪里不好")} onClick={() => (open ? closeTray() : thumb("down"))}><Icon name="thumb-down" /></button>}
      {vote === "down" && <span id={voteId} className="sh-visually-hidden">{ui("已标记这题有问题")}</span>}
      {error && <InlineMessage tone="error" className="thumbs__error">{error}</InlineMessage>}
      {open && (
        <span
          id={trayId}
          className="thumb-tray"
          role="group"
          aria-label={ui("哪里不好")}
          onMouseEnter={() => { trayHovered.current = true; clearIdleTimer(); }}
          onMouseLeave={() => { trayHovered.current = false; scheduleIdleSubmit(); }}
          onFocusCapture={() => { trayFocused.current = true; clearIdleTimer(); }}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              trayFocused.current = false;
              scheduleIdleSubmit();
            }
          }}
        >
          {TAGS.map(([id, label], i) => (
            <Chip key={id} selected={tags.includes(id)} disabled={sent.current.has(id) || submitting.current.has(id)} onClick={() => toggle(id)}>
              <kbd>{i + 1}</kbd>{ui(label)}
            </Chip>
          ))}
          {hasUnsentTags && (
            <Button variant="secondary" size="sm" onClick={closeTray}>{ui("提交标签")}</Button>
          )}
          <small className="thumb-tray__keys">{ui("按 1–7 选标签，Esc 收起")}</small>
          <small>{ui("选好停一下就自动提交；已提交的标签不能撤销。改题类问题会带到下方的「修题」。")}</small>
          {courseRules?.course && ruleTextsForTags(tags).length > 0 && (
            <Button variant="link" size="sm" data-usage="review.course-rule" onClick={() => setRuleTexts(ruleTextsForTags(tags))}>{ui("设为本课守则")}</Button>
          )}
        </span>
      )}
      {ruleTexts && courseRules?.course && <CourseRuleConfirm courseRules={courseRules} texts={ruleTexts} onClose={() => setRuleTexts(null)} />}
    </span>
  );
});

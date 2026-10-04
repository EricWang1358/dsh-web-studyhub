import React, { useState } from "react";
import { ui, uiFormat } from "../i18n.js";
import { Button, Hint, InlineMessage } from "../components/index.js";

/** What proofreading changed in an audio source, so the learner can check it; unsure items can be given a second look. */
export function AudioCorrections({ audio, onReview }) {
  const [review, setReview] = useState({ status: "idle", error: "" });
  const applied = audio?.corrections?.applied || [];
  const lowConfidence = (audio?.corrections?.skipped || []).filter((item) => item.skipped === "low-confidence");
  const unsure = lowConfidence.filter((item) => item.review?.verdict !== "reject");
  const kept = lowConfidence.length - unsure.length, pending = unsure.filter((item) => !item.review).length;
  if (!applied.length && !unsure.length) return null;
  const start = async () => {
    setReview({ status: "running", error: "" });
    try { await onReview(); setReview({ status: "started", error: "" }); }
    catch (error) { setReview({ status: "idle", error: String(error?.message || error) }); }
  };
  const row = (item, key) => (
    <li key={key}>
      <strong>{item.wrong} → {item.right}</strong>
      {item.reviewed ? <span> · {ui("复核后采纳")}</span> : null}
      {item.reason ? <span> · {item.reason}</span> : null}
      {item.review?.verdict === "unsure" && item.review.reason ? <span> · {uiFormat("复核：{0}", [item.review.reason])}</span> : null}
      <small className="muted" style={{ display: "block" }}>…{item.context}…</small>
    </li>
  );
  return (
    <details className="audio-corrections">
      <summary>{uiFormat("校对改动 {0} 处 · 未改动的存疑处 {1} 处", [audio.corrections.appliedCount ?? applied.length, unsure.length])}</summary>
      {applied.length > 0 && <ul>{applied.map((item, index) => row(item, `a${index}`))}</ul>}
      {unsure.length > 0 && <>
        <Hint>{ui("下面这些把握不大，没有改动，需要时请对照录音核对：")}</Hint>
        {onReview && pending > 0 && <><p>
          <Button size="sm" busy={review.status === "running"} disabled={review.status !== "idle"} onClick={start}
            title={ui("用对话模型结合上下文再判一次：能确定的直接改进正稿（译文里的同一处一起改），仍拿不准的留在这里")}>
            {uiFormat("让模型复核这 {0} 处", [pending])}</Button>
          {review.status === "started" && <Hint as="small"> {ui("已开始复核，进度见音频任务卡片")}</Hint>}
        </p>
        {review.error && <InlineMessage tone="error">{review.error}</InlineMessage>}</>}
        <ul>{unsure.map((item, index) => row(item, `u${index}`))}</ul>
      </>}
      {kept > 0 && <Hint>{uiFormat("另有 {0} 处经复核判定原文无误，已不再列出", [kept])}</Hint>}
    </details>
  );
}

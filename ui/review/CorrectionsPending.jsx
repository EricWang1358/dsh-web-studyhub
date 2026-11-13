import { ui, uiFormat } from "../i18n.js";
import React from "react";
import Markdown from "../Markdown.jsx";
import { Button, Dialog, LoadingState } from "../components/index.js";
import { invalidate, useHostQuery } from "../host-query.js";
import CorrectionCard from "./CorrectionCard.jsx";

/* 「待看订正 N」 in the practice header (#1031): the misses whose AI grade landed after the learner had moved on. A press lists them during the round
   (review.lookBack {pending: true}, the same rows as 本轮题目's 待看订正 on the result page): the question, the answer given, the correction, and
   我看懂了 · 加入重练, which queues the retry at the end of the round. */
export default function CorrectionsPending({ run, onAck }) {
  const [open, setOpen] = React.useState(false);
  const args = { runId: run.id, pending: true };
  const query = useHostQuery("review.lookBack", args, { enabled: open });
  const rows = query.data?.rows || [];
  const ack = async (row) => {
    await onAck(row);
    invalidate("review.lookBack");
  };
  return (
    <>
      <Button variant="quiet" size="sm" className="corrections-pending" onClick={() => setOpen(true)}>{uiFormat("待看订正 {0}", [run.correctionsPending])}</Button>
      {open && <Dialog title={ui("待看订正")} description={ui("这些题你离开后才批完、没过关。看懂订正再加入重练，它会排到这一轮最后。")} onClose={() => setOpen(false)}>
        {query.loading && !rows.length ? <LoadingState label={ui("正在读取…")} /> : !rows.length ? <p className="muted">{ui("都看完了。")}</p> : rows.map((row) => (
          <article key={row.entryIndex} className="corrections-pending__row">
            <h4>{uiFormat("第 {0} 题", [row.number])}</h4>
            <Markdown text={String(row.card?.prompt ?? "")} />
            {row.feedback?.answer && <p className="muted small">{uiFormat("你的回答：{0}", [row.feedback.answer])}</p>}
            {row.solution?.answer && <details><summary>{ui("参考答案")}</summary><Markdown text={row.solution.answer} /></details>}
            <CorrectionCard feedback={row.feedback} withRubric onAck={() => ack(row)} />
          </article>
        ))}
      </Dialog>}
    </>
  );
}

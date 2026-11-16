import React from "react";
import { ui } from "../i18n.js";
import { Icon } from "../components/index.js";

/* What an option says about itself once the answer is in: the one you picked and got right (a tick), the one you picked and got wrong (a cross),
   a right answer you did not pick. Practice and the round look-back draw it, so the words and the icons are in one place. `multiple`: a question
   with several right answers, whose missed and wrong picks have their own words. */
export default function AnswerState({ correct, picked, multiple = false }) {
  const words = correct
    ? picked ? ui("已选 · 正确") : multiple ? ui("漏选 · 正确答案") : ui("正确答案")
    : picked ? multiple ? ui("已选 · 错选") : ui("你的选择") : "";
  const mark = picked ? (correct ? "check" : "close") : null;
  return <strong className="answer-state">{mark && <Icon name={mark} size={18} strokeWidth={2} />}{words}</strong>;
}

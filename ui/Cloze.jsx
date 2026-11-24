import { ui, uiFormat } from "./i18n.js";
import React, { useEffect, useMemo, useRef } from "react";
import css from "./graph.css";
import { useInjectCss } from "./shared.js";
import { Button, Icon, Tooltip } from "./components/index.js";
import MathText from "./MathText.jsx";
import { clozeBlankIds, clozeRuns } from "../lib/cloze-text.js";
import { clozeBlankKeyAction } from "./review/session-logic.js";

/* Fill-in-the-blank card, display only: grading lives on the server
   (review.answer → feedback.details, contract §5). `card.cloze` is the
   publicCard form {text, blanks:[{id}]}; `{{id}}` markers in text become
   inline inputs, and the text around them, the expected answers and the
   correct values draw their formulas like every other card's text
   (lib/cloze-text.js splits a formula that holds a blank). CSS shares
   ui/graph.css via the data-study-graph marker. */

// Chars that render about twice as wide as `ch` (CJK, fullwidth forms…).
const WIDE = /[\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\u3000-\u303f\u2018\u2019\u201c\u201d\u2026\u00b7]/;
const chLen = (s) => {
  let w = 0;
  for (const ch of String(s ?? "")) w += WIDE.test(ch) ? 2 : 1;
  return w;
};

export default function Cloze({ card, values, onChange, onSubmit, focusRequest = 0, disabled, details, solution, onMarkEquivalent, equivalentBusy = false }) {
  useInjectCss(css, "study-graph");
  const cloze = card?.cloze;
  const text = typeof cloze?.text === "string" ? cloze.text : "";

  const detailById = useMemo(
    () =>
      new Map(
        (Array.isArray(details) ? details : [])
          .filter((d) => d && d.id != null)
          .map((d) => [d.id, d]),
      ),
    [details],
  );

  // Split the text on {{id}} markers: text runs keep their spacing (pre-wrap
  // keeps spacing/newlines) and draw their formulas, each marker becomes a blank slot in place.
  const parts = useMemo(() => clozeRuns(text), [text]);
  const blankIds = useMemo(() => clozeBlankIds(text), [text]);
  const hasMultilineBlank = useMemo(() => parts.some((p) => p.t === "code-block" && p.runs.some((r) => r.t === "blank")), [parts]);
  const inputRefs = useRef({});
  const latest = useRef({ blankIds, values });
  latest.current = { blankIds, values };

  useEffect(() => {
    if (!focusRequest || disabled || details) return;
    const { blankIds: ids, values: currentValues } = latest.current;
    const targetId = ids.find((id) => !String(currentValues?.[id] ?? "").trim()) ?? ids[0];
    if (targetId) inputRefs.current[targetId]?.focus();
  }, [focusRequest, disabled, details]);

  if (!card || !cloze || !text)
    return <p className="cloze cloze-missing">{ui("这张卡片没有可填写的空位。")}</p>;

  const gradedDetails = Array.isArray(details) ? details.filter((d) => d && d.id != null) : [];
  const gradedCount = gradedDetails.length;
  const correctCount = gradedDetails.filter((d) => d.correct).length;
  const passed = gradedCount > 0 && correctCount === gradedCount;
  const showSummary = gradedCount > 1 || (gradedCount > 0 && !passed && typeof onMarkEquivalent === "function");

  let nth = 0;
  const renderBlank = (id, key, inCode = false) => {
    const nthBlank = (nth += 1);
    const detail = detailById.get(id);
    const val = values?.[id] ?? "";
    const codeClass = inCode ? " cloze-blank--code" : "";
    if (detail) {
      const expectedText = detail.expected == null ? "—" : String(detail.expected);
      const expectedMultiline = expectedText.includes("\n");
      return detail.correct ? (
        <Tooltip key={key} layer content={ui("回答正确")}>
          <span tabIndex={0} className={`cloze-blank cloze-right${codeClass}`}>
            {val || (inCode
              ? (solution?.cloze?.answers?.find((answer) => answer.id === id)?.value || ui("回答正确"))
              : <MathText text={solution?.cloze?.answers?.find((answer) => answer.id === id)?.value || ui("回答正确")} />)}
            <span className="cloze-mark"><Icon className="sh-icon--inline" name="check" /></span>
          </span>
        </Tooltip>
      ) : (
        <Tooltip key={key} layer content={ui("回答错误")}>
          <span tabIndex={0} className={`cloze-blank cloze-wrong${codeClass}`}>
            {Object.hasOwn(values || {}, id) && (
              <span className="cloze-yours">
                <span className="cloze-mark cloze-mark--wrong" role="img" aria-label={ui("回答错误")}>
                  <Icon className="sh-icon--inline" name="close" />
                </span>
                <span className="cloze-yours__text" data-empty={!val ? "true" : undefined}>
                  {ui("你的答案：")}{val || ui("未填写")}
                </span>
              </span>
            )}
            <span className="cloze-expected-row">
              <span className="cloze-mark cloze-mark--right" aria-hidden="true">
                <Icon className="sh-icon--inline" name="check" />
              </span>
              {expectedMultiline || inCode ? (
                <code className={`cloze-expected${expectedMultiline ? " cloze-expected--multiline" : ""}`}>{expectedText}</code>
              ) : (
                <span className="cloze-expected">{detail.expected == null ? "—" : <MathText text={expectedText} />}</span>
              )}
            </span>
          </span>
        </Tooltip>
      );
    }
    // A blank inside a fenced code block takes lines (#1403): a textarea keeps the newlines a single-line input would swallow.
    const multiline = inCode;
    const keyDown = (e) => {
      const action = clozeBlankKeyAction(
        {
          key: e.key,
          repeat: e.repeat,
          isComposing: e.isComposing || e.nativeEvent?.isComposing,
          keyCode: e.keyCode || e.nativeEvent?.keyCode,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        },
        { blankIds, currentId: id, values, multiline },
      );
      if (!action) return;
      if (action.type === "blur") {
        const cardEl = e.currentTarget.closest?.(".question-card");
        if (cardEl?.focus) cardEl.focus({ preventScroll: true });
        else e.currentTarget.blur();
        return;
      }
      e.preventDefault();
      if (action.type === "focus") inputRefs.current[action.id]?.focus();
      else if (action.type === "submit") onSubmit?.();
    };
    const shared = {
      ref: (el) => {
        if (el) inputRefs.current[id] = el;
        else delete inputRefs.current[id];
      },
      autoComplete: "off",
      autoCapitalize: "off",
      spellCheck: false,
      value: val,
      disabled,
      "aria-label": uiFormat("第 {0} 个空", [nthBlank]),
      onChange: (e) => onChange?.(id, e.target.value),
      onKeyDown: keyDown,
    };
    if (multiline)
      return (
        <textarea
          key={key}
          {...shared}
          className={`cloze-blank cloze-blank--input cloze-blank--multiline${codeClass}`}
          rows={Math.min(10, Math.max(2, String(val).split("\n").length + (String(val).endsWith("\n") ? 1 : 0)))}
          wrap="off"
        />
      );
    return (
      <input
        key={key}
        {...shared}
        className={`cloze-blank cloze-blank--input${codeClass}`}
        type="text"
        style={{ width: `${Math.min(40, Math.max(6, chLen(val) + 2))}ch` }}
      />
    );
  };

  return (
    <div className="cloze">
      {!details && (
        <div className="cloze-hint">
          {!onSubmit
            ? ui("把空格补全")
            : hasMultilineBlank
              ? ui("把空格补全 · 代码块里的空可填多行：Enter 换行，Ctrl/⌘+Enter 提交 · Esc 退回题目")
              : blankIds.length > 1
                ? <>{ui("把空格补全 · 按 Enter 跳到下一空或提交 · Esc 退回题目")}{" · "}{ui("Shift+Enter 回上一空")}</>
                : ui("把空格补全 · 按 Enter 提交 · Esc 退回题目")}
        </div>
      )}
      {showSummary && (
        <div className="cloze-summary" role="status">
          {gradedCount > 1 && (
            <span className={"cloze-summary__count " + (passed ? "cloze-summary__count--ok" : "cloze-summary__count--bad")} data-passed={passed ? "true" : "false"}>
              <Icon className="sh-icon--inline" name={passed ? "check" : "close"} />
              {uiFormat("答对 {0}/{1} 空", [correctCount, gradedCount])}
            </span>
          )}
          {!passed && typeof onMarkEquivalent === "function" && (
            <Button
              size="sm"
              variant="secondary"
              className="cloze-equivalent-btn"
              busy={equivalentBusy}
              disabled={equivalentBusy}
              onClick={() => onMarkEquivalent()}
            >
              {ui("表述等价 · 算我答对")}
            </Button>
          )}
        </div>
      )}
      <div className="cloze-text">
        {parts.map((p, i) => {
          if (p.t === "text") return <span key={i}><MathText text={p.v} /></span>;
          if (p.t === "code") return <code key={i} className="cloze-code">{p.v}</code>;
          if (p.t === "code-block") {
            return (
              <div key={i} className="cloze-code-block" data-lang={p.lang || undefined}>
                {p.lang && <div className="cloze-code-block__lang">{p.lang}</div>}
                <pre className="cloze-code-block__pre">
                  <code>
                    {p.runs.map((run, j) => (run.t === "blank"
                      ? renderBlank(run.id, `${i}-${j}`, true)
                      : <React.Fragment key={`${i}-${j}`}>{run.v}</React.Fragment>))}
                  </code>
                </pre>
              </div>
            );
          }
          return renderBlank(p.id, i, false);
        })}
      </div>
    </div>
  );
}

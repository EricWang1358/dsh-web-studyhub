import React, { useMemo } from "react";
import css from "./graph.css";
import { useInjectCss } from "./shared.js";

/* Fill-in-the-blank card, display only: grading lives on the server
   (review.answer → feedback.details, contract §5). `card.cloze` is the
   publicCard form {text, blanks:[{id}]}; `{{id}}` markers in text become
   inline inputs. CSS shares ui/graph.css via the data-study-graph marker. */

const MARK = /\{\{\s*([^{}\s]+)\s*\}\}/g;
// Chars that render about twice as wide as `ch` (CJK, fullwidth forms…).
const WIDE = /[\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\u3000-\u303f\u2018\u2019\u201c\u201d\u2026\u00b7]/;
const chLen = (s) => {
  let w = 0;
  for (const ch of String(s ?? "")) w += WIDE.test(ch) ? 2 : 1;
  return w;
};

export default function Cloze({ card, values, onChange, disabled, details, solution }) {
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

  // Split the text on {{id}} markers: text runs stay verbatim (pre-wrap keeps
  // spacing/newlines), each marker becomes a blank slot in place.
  const parts = useMemo(() => {
    const out = [];
    let last = 0,
      m;
    MARK.lastIndex = 0;
    while ((m = MARK.exec(text))) {
      if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
      out.push({ t: "blank", id: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: "text", v: text.slice(last) });
    return out;
  }, [text]);

  if (!card || !cloze || !text)
    return <p className="cloze cloze-missing">这张卡片没有可填写的空位。</p>;

  let nth = 0;
  return (
    <div className="cloze">
      {!details && <div className="cloze-hint">把空格补全</div>}
      <div className="cloze-text">
        {parts.map((p, i) => {
          if (p.t === "text") return <span key={i}>{p.v}</span>;
          const id = p.id;
          const nthBlank = (nth += 1);
          const detail = detailById.get(id);
          const val = values?.[id] ?? "";
          // Graded feedback replaces the input with coloured text; blanks the
          // server did not judge stay as (disabled) inputs.
          if (detail)
            return detail.correct ? (
              <span key={i} className="cloze-blank cloze-right" title="回答正确">
                {val || solution?.cloze?.answers?.find((answer) => answer.id === id)?.value || "回答正确"}
                <span className="cloze-mark">✓</span>
              </span>
            ) : (
              <span key={i} className="cloze-blank cloze-wrong" title="回答错误">
                <span className="cloze-expected">{detail.expected ?? "—"}</span>
                <span className="cloze-mark" aria-label="回答错误">✗</span>
                {Object.hasOwn(values || {}, id) && <span className="cloze-yours">你的答案：{val || "未填写"}</span>}
              </span>
            );
          return (
            <input
              key={i}
              className="cloze-blank"
              type="text"
              value={val}
              disabled={disabled}
              style={{ width: `${Math.min(40, Math.max(6, chLen(val) + 2))}ch` }}
              aria-label={`第 ${nthBlank} 个空`}
              onChange={(e) => onChange?.(id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault(); // never submit the form
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

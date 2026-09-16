import React from "react";
import Markdown from "./Markdown.jsx";

/* 闪卡翻面。两面叠在同一个 grid 格里，默认高度取两面中较高者；答案加载
   或翻面后若背面更长，卡片会在一帧内撑高、把下面的评分区挤下去。这里改为
   只按当前朝上那一面定高，并用 ResizeObserver 跟随内容变化（答案载入、
   字体加载、容器变宽），高度变化交给 CSS transition 与翻转同步完成。 */
export default function FlipCard({ run, busy, showBack, flipCard, enOn }) {
  const front = React.useRef(null),
    back = React.useRef(null),
    [height, setHeight] = React.useState(null);

  React.useLayoutEffect(() => {
    const measure = () => {
      const face = (showBack ? back : front).current;
      if (face) setHeight(face.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const face of [front.current, back.current]) if (face) observer.observe(face);
    return () => observer.disconnect();
    // The answer arriving re-measures in the same commit; the observer covers
    // later reflows (fonts, width changes) that happen without a render.
  }, [showBack, run.solution]);

  return (
    <button
      className={"flashcard" + (showBack ? " flipped" : "")}
      disabled={busy && !run.revealed}
      aria-pressed={showBack}
      aria-label={showBack ? "翻回题目" : "翻面查看答案"}
      onClick={flipCard}
    >
      <div className="flip-inner" style={height == null ? undefined : { height }}>
        <div ref={front} className="flip-face flip-front" aria-hidden={showBack}>
          <Markdown
            links={false}
            className={"flash-prompt" + (run.card.prompt.length > 90 ? " long" : "")}
            text={run.card.prompt}
          />
          {enOn && run.card.translation?.prompt && (
            <div className="en-block">
              <span className="en-tag">EN</span>
              <Markdown links={false} className="md-compact" text={run.card.translation.prompt} />
            </div>
          )}
          <span className="flip-label">
            {run.revealed ? "点击看答案 · Space" : "点击翻面 · Space"}
          </span>
        </div>
        <div ref={back} className="flip-face flip-back" aria-hidden={!showBack}>
          <Markdown links={false} className="flip-question" text={run.card.prompt} />
          {run.solution ? (
            <>
              <Markdown
                links={false}
                className={"flash-prompt" + ((run.solution.answer || "").length > 120 ? " long" : "")}
                text={run.solution.answer}
              />
              {enOn && run.solution.translation?.answer && (
                <div className="en-block">
                  <span className="en-tag">EN</span>
                  <Markdown links={false} className="md-compact" text={run.solution.translation.answer} />
                </div>
              )}
            </>
          ) : (
            <div className="flash-prompt">
              <span className="flip-loading" aria-label="正在载入答案" />
            </div>
          )}
          <span className="flip-label">参考答案 · 再点翻回题目</span>
        </div>
      </div>
    </button>
  );
}

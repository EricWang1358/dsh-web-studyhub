import React, { useMemo, useRef } from "react";
import { skeletonSpine } from "./skeleton-spine.js";

/* 脉络：一条横向学习主线。主线上的每一站是一个顶层概念，站下垂直展开
   它的要点，要点再向右分出细节。从左到右、从上到下读一遍，就是学习顺序。 */

function Branch({ items, onPractice }) {
  if (!items.length) return null;
  return (
    <ul className="spine-branch">
      {items.map((item) => (
        <li key={item.id} className={"spine-point d" + Math.min(item.depth, 3)}>
          <div className="spine-point-body">
            <strong>{item.term}</strong>
            {item.meaning && <span className="spine-meaning">{item.meaning}</span>}
            {item.contrasts.length > 0 && (
              <span className="spine-contrast">对比 · {item.contrasts.join("、")}</span>
            )}
            {item.subtreeCards.length > 0 && (
              <button type="button" className="link-btn spine-practice" onClick={() => onPractice(item.subtreeCards)}>
                练 {item.subtreeCards.length} 题
              </button>
            )}
          </div>
          <Branch items={item.children} onPractice={onPractice} />
        </li>
      ))}
    </ul>
  );
}

export default function SkeletonSpine({ skeleton, onPractice }) {
  const stations = useMemo(() => skeletonSpine(skeleton), [skeleton]);
  const scroller = useRef(null);
  const points = useMemo(() => {
    const count = (list) => list.reduce((n, s) => n + 1 + count(s.children), 0);
    return count(stations) - stations.length;
  }, [stations]);
  const step = (dir) => {
    const el = scroller.current;
    const station = el?.querySelector(".spine-station");
    if (el && station) el.scrollBy({ left: dir * (station.offsetWidth + 40), behavior: "smooth" });
  };
  if (!stations.length) return null;
  return (
    <section className="spine" aria-label={`学习脉络：${skeleton.title}`}>
      <div className="spine-head">
        <span>
          {stations.length} 站 · {points} 个要点
        </span>
        {stations.length > 3 && (
          <span className="spine-steps">
            <button type="button" aria-label="上一站" onClick={() => step(-1)}>←</button>
            <button type="button" aria-label="下一站" onClick={() => step(1)}>→</button>
          </span>
        )}
      </div>
      <div
        className="spine-scroll"
        ref={scroller}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            step(event.key === "ArrowRight" ? 1 : -1);
          }
        }}
      >
        <ol className="spine-track">
          {stations.map((station) => (
            <li key={station.id} className="spine-station">
              <div className="spine-stop">
                <span className="spine-marker" aria-hidden="true">{station.step}</span>
                <div className="spine-stop-text">
                  <h4>{station.term}</h4>
                  {station.meaning && <p>{station.meaning}</p>}
                  {station.subtreeCards.length > 0 && (
                    <button type="button" className="link-btn spine-practice" onClick={() => onPractice(station.subtreeCards)}>
                      学这一站 · {station.subtreeCards.length} 题 →
                    </button>
                  )}
                </div>
              </div>
              <Branch items={station.children} onPractice={onPractice} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

import React from "react";

/* 让一块会换内容的区域（闪卡下方的作答框 → 评分区 → 消失）平滑地改变高度，
   而不是在一帧内把下面的工具栏挤开。内层用 flow-root 包住子元素的外边距，
   保证量到的高度与实际占位一致。 */
export default function SmoothHeight({ className = "", children }) {
  const inner = React.useRef(null),
    [height, setHeight] = React.useState(null);
  React.useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className={"smooth-height" + (className ? " " + className : "")}
      style={height == null ? undefined : { height }}
    >
      <div ref={inner} className="smooth-height-inner">
        {children}
      </div>
    </div>
  );
}

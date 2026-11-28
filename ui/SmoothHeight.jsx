import React from "react";

/* 让一块会换内容的区域（闪卡下方的作答框 → 评分区 → 消失、助教表单展开/收起）
   在支持 interpolate-size: allow-keywords 的宿主上由浏览器原生插值高度，
   不再依赖 ResizeObserver + offsetHeight 轮询触发首帧延迟与每帧布局重排。
   ref 落在外层这块区域上（闪卡评分区贴在窗口底部时，量它的高度给焦点留位，#1678）。 */
const SmoothHeight = React.forwardRef(function SmoothHeight({ className = "", children }, ref) {
  return (
    <div ref={ref} className={"smooth-height" + (className ? " " + className : "")}>
      <div className="smooth-height-inner">
        {children}
      </div>
    </div>
  );
});
export default SmoothHeight;

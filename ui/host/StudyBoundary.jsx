import React from "react";
import { ui } from "../i18n.js";

// One render error anywhere in App would otherwise blank the whole study tab;
// the boundary keeps the slot alive and offers a fresh remount.
export default class StudyBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, nonce: 0 };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[study-workspace] render failed:", error);
  }
  render() {
    const { error, nonce } = this.state;
    if (!error) return <React.Fragment key={nonce}>{this.props.children}</React.Fragment>;
    return (
      <div className="study-app">
        <div className="empty">
          <span className="empty-icon">⚠️</span>
          <h2>{ui("学习工作台渲染出错")}</h2>
          <p>{String(error?.message || error)}</p>
          <button
            className="ghost-btn"
            type="button"
            onClick={() => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))}
          >{ui("重新加载")}</button>
        </div>
      </div>
    );
  }
}

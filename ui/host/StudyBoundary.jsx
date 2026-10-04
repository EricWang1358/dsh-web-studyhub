import React from "react";
import { ui } from "../i18n.js";
import { CrashFallback } from "../components/index.js";

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
        <CrashFallback error={error} title={ui("学习工作台渲染出错")} retryLabel={ui("重新加载")}
          onRetry={() => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))} />
      </div>
    );
  }
}

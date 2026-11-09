import React from 'react';
import { ui } from '../i18n.js';
import { CrashFallback } from '../components/index.js';
import { DiagnosticContext } from '../components/diagnostic-context.js';

/**
 * The error boundary of a page (#893): a render error in the page shows the crash notice in its place and nothing else changes, so the sidebar and
 * the top bar stay and the learner can open another page. PageView keys it by the page, so leaving a crashed page and coming back starts clean;
 * 重试 draws the same page again. `describe(error)` gives the text 复制诊断信息 copies (ui/diagnostics.js); it also goes down by context, so a boundary
 * inside the page (deferredView, a settings pane) offers the button in its own notice.
 */
export class PageBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    console.error('[study-workspace] page render failed:', error);
  }
  render() {
    const { error } = this.state;
    if (!error) return <DiagnosticContext.Provider value={this.props.describe}>{this.props.children}</DiagnosticContext.Provider>;
    return <CrashFallback error={error} title={ui('这个页面没能显示')} retryLabel={ui('重试')} diagnostic={this.props.describe}
      onRetry={() => this.setState({ error: null })} />;
  }
}

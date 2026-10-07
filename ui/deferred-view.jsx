import React, { lazy, Suspense } from 'react';
import { ui } from './i18n.js';
import { CrashFallback, LoadingState } from './components/index.js';

export function deferredView(load) {
  const View = lazy(load);
  return class DeferredView extends React.Component {
    constructor(props) {
      super(props);
      this.state = { View, error: null };
    }
    static getDerivedStateFromError(error) { return { error }; }
    render() {
      if (this.state.error) return <CrashFallback error={this.state.error} title={ui('这个页面没能打开')} retryLabel={ui('重新加载')}
        onRetry={() => this.setState({ View: lazy(load), error: null })} />;
      const CurrentView = this.state.View;
      // A view kept mounted out of sight (LiveClass keeps recording on every page) takes no room while its chunk loads:
      // a bar above the page that vanishes on arrival moves everything below it (46 px at 420 px).
      const fallback = this.props.visible === false ? null : <LoadingState label={ui('正在打开学习工作区…')} />;
      return <Suspense fallback={fallback}><CurrentView {...this.props} /></Suspense>;
    }
  };
}

import React, { lazy, Suspense } from 'react';
import { ui } from './i18n.js';

export function deferredView(load) {
  const View = lazy(load);
  return class DeferredView extends React.Component {
    constructor(props) {
      super(props);
      this.state = { View, error: null };
    }
    static getDerivedStateFromError(error) { return { error }; }
    render() {
      if (this.state.error) return <div role="alert">
        <p>{String(this.state.error?.message || this.state.error)}</p>
        <button type="button" onClick={() => this.setState({ View: lazy(load), error: null })}>{ui('重新加载')}</button>
      </div>;
      const CurrentView = this.state.View;
      return <Suspense fallback={<p role="status">{ui('正在打开学习工作区…')}</p>}><CurrentView {...this.props} /></Suspense>;
    }
  };
}

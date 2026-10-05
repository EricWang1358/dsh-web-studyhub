import { ui } from './i18n.js';
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { audioFocusPending } from './audio-focus.js';
import { hasContext } from './capabilities.js';
import { KEY_FIELDS } from '../lib/audio-providers.js';
import { SETTINGS_GROUPS, categoriesFor, categoryForAnchor, initialCategory, settingsGroupState } from './settings-groups.js';
import { CrashFallback, LoadingState, PageHeader } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { useComponentCss } from './components/css.js';
import fieldsCss from './components/fields.css';
import { useInjectCss } from './shared.js';
import css from './settings.css';
import { loadMineruSettings } from './use-mineru.js';
import { loadRetrievalStatus } from './retrieval-status.js';
import { readText, writeText } from './storage.js';
import { useHostQuery } from './host-query.js';
import { useLiveEffect } from './use-async.js';

/* App names the file of an export with this; it lives in its own module so the page does not load the backup section for it. */
export { backupFileName } from './settings/backup-name.js';

/* 设置视图: a list of categories on the left and one category on the right. Which categories exist, what each needs from the host and
   which pane it shows is declared once in ui/settings-groups.js; this page keeps what they share (what is set up, what is selected,
   the services every pane may use) and renders <category.Component {...services} />. */

/* ---------- categories: a list on the left, one category on the right ---------- */

const CATEGORY_KEY = 'study-settings-category';
const readCategory = () => readText(CATEGORY_KEY);
const writeCategory = (value) => { writeText(CATEGORY_KEY, value); /* the choice still applies this session */ };

/** The list of categories under the three group headings; the selected one is marked, and one that needs attention says so in words (not by colour alone). */
export function SettingsNav({ available, active, missing, onSelect }) {
  return (
    <nav className="settings-nav" aria-label={ui('设置分类')}>
      {SETTINGS_GROUPS.map((group) => {
        const items = available.filter((category) => category.group === group.id);
        if (!items.length) return null;
        return (
          <div className="settings-nav__group" key={group.id}>
            <p className="settings-nav__label">{ui(group.title)}</p>
            <ul>
              {items.map((category) => (
                <li key={category.id}>
                  <button type="button" className="settings-nav__item" data-category={category.id} aria-current={active === category.id ? 'page' : undefined} onClick={() => onSelect(category.id)}>
                    <span>{ui(category.title)}</span>
                    {missing.includes(category.id) && <span className="settings-nav__todo">{ui('待设置')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** One pane, loaded on demand: a quiet loading line while its module arrives, and a retry if it cannot be loaded. */
class PaneBoundary extends React.Component {
  state = { error: null, Pane: this.props.category.Component };
  static getDerivedStateFromError(error) { return { error }; }
  retry = () => this.setState({ error: null, Pane: lazy(this.props.category.load) });
  render() {
    if (this.state.error) return <CrashFallback error={this.state.error} title={ui('这个页面没能打开')} retryLabel={ui('重新加载')} onRetry={this.retry} />;
    const { Pane } = this.state;
    return <Suspense fallback={<LoadingState />}><Pane {...this.props.services} /></Suspense>;
  }
}
const Pane = ({ category, services }) => <PaneBoundary key={category.id} category={category} services={services} />;

/* ---------- the page ---------- */

/** The services (call, act, busy, host, notify) come from useStudy(); the panels of the model, course and sample panes are drawn by the panes. */
export default function Settings({
  data,
  settings,
  setSettings,
  legacy,
  setLegacy,
  exportData,
  onRestored,
  initialProfile = null,
  appearance = null,
  tourActive = false,
  focusSection = '',
  onFocused,
}) {
  useInjectCss(css, 'study-settings');
  const { call, act, busy, host } = useStudy();
  // The section shell is a shared component; sections still written by hand elsewhere borrow its stylesheet.
  useComponentCss(fieldsCss, 'study-fields');
  const [profile, setProfile] = useState(initialProfile);
  useEffect(() => {
    act('coach.profile', {}, setProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the host says is set up: read once, quietly (no model is called). It only decides which group starts open.
  const [loaded, setStatus] = useState({});
  // The audio keys are one of the host's shared answers (ui/host-query.js): a key saved in the audio pane changes this page's "set up" mark at once.
  const audioSettings = useHostQuery('audio.settings.get', {}, { enabled: typeof call === 'function' && hasContext(data, 'audio') }).data;
  const status = audioSettings ? { ...loaded, audio: { configured: KEY_FIELDS.some((field) => audioSettings[field]?.set) } } : loaded;
  useLiveEffect((live) => {
    if (typeof call !== 'function') return;
    const keep = (name) => (value) => { if (live() && value) setStatus((current) => ({ ...current, [name]: value })); };
    if (hasContext(data, 'audio')) loadMineruSettings(call).then((value) => keep('mineru')(value && !value.unavailable && { configured: !!value.token?.set }), () => {});
    if (hasContext(data, 'generation')) loadRetrievalStatus(call).then((value) => keep('retrieval')(value && { status: value, plan: null }), () => {});
  }, []);

  // What the host can show, what needs attention, and which category is selected: a deep link (the audio key, the search extension, the model) or the tour
  // points at one; otherwise the first that needs attention, otherwise the one used last.
  const capabilities = { audio: hasContext(data, 'audio'), generation: hasContext(data, 'generation'), system: hasContext(data, 'system') };
  const available = categoriesFor(capabilities);
  const state = settingsGroupState({ data, status });
  const missing = state.common.missing.concat(state.once.missing);
  const [active, setActive] = useState(() => initialCategory({ available, focusSection: focusSection || (audioFocusPending() ? 'settings-audio' : ''), missing, last: readCategory() }));
  const select = (id) => { setActive(id); writeCategory(id); };
  useEffect(() => {
    if (!focusSection) return undefined;
    const linked = categoryForAnchor(focusSection);
    if (linked && available.some((item) => item.id === linked)) setActive(linked);
    // The linked pane is lazy: wait (up to ~2 s of frames) until its section exists, then scroll and clear the request.
    let frame = 0, tries = 0;
    const seek = () => {
      const anchor = document.querySelector(`[data-tour="${focusSection}"]`);
      if (!anchor && tries++ < 120) { frame = requestAnimationFrame(seek); return; }
      anchor?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      onFocused?.();
    };
    frame = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSection]);
  // Everything a pane may need. Panes take what they use and nothing else.
  const services = { data, busy, act, call, host, settings, setSettings, legacy, setLegacy,
    exportData, onRestored, appearance, profile, setProfile, capabilities, status };
  const selected = available.find((item) => item.id === active) || available[0];
  return (
    <section className="page settings-page">
      <PageHeader title={ui('工作区设置')} description={ui('资料、题库、调度与模型，由你掌控。')} />
      {tourActive ? (
        /* The tour points at sections anywhere on the page: show every category, one after another. */
        <div className="settings-all">{available.map((item) => <Pane key={item.id} category={item} services={services} />)}</div>
      ) : (
        <div className="settings-layout">
          <SettingsNav available={available} active={selected?.id} missing={missing} onSelect={select} />
          <div className="settings-pane" role="region" aria-label={ui(selected?.title || '')}>{selected && <Pane category={selected} services={services} />}</div>
        </div>
      )}
    </section>
  );
}

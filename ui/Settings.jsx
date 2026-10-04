import { ui } from './i18n.js';
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { audioFocusPending } from './audio-focus.js';
import { hasContext } from './capabilities.js';
import { KEY_FIELDS } from '../lib/audio-providers.js';
import { SETTINGS_GROUPS, categoriesFor, categoryForAnchor, initialCategory, settingsGroupState } from './settings-groups.js';
import { CrashFallback, LoadingState } from './components/index.js';
import { useComponentCss } from './components/css.js';
import fieldsCss from './components/fields.css';
import { useInjectCss } from './shared.js';
import css from './settings.css';

/* App names the file of an export with this; it lives in its own module so the page does not load the backup section for it. */
export { backupFileName } from './settings/backup-name.js';

/* 设置视图: a list of categories on the left and one category on the right. Which categories exist, what each needs from the host and
   which pane it shows is declared once in ui/settings-groups.js; this page keeps what they share (what is set up, what is selected,
   the services every pane may use) and renders <category.Component {...services} />. */

/* ---------- categories: a list on the left, one category on the right ---------- */

const CATEGORY_KEY = 'study-settings-category';
const readCategory = () => { try { return localStorage.getItem(CATEGORY_KEY) || ''; } catch { return ''; } };
const writeCategory = (value) => { try { localStorage.setItem(CATEGORY_KEY, value); } catch { /* the choice still applies this session */ } };

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

export default function Settings({
  data,
  busy,
  act,
  call,
  host,
  setNotice,
  settings,
  setSettings,
  legacy,
  setLegacy,
  workspacePanel,
  coursePanel,
  onboardingPanel,
  exportData,
  onRestored,
  initialProfile = null,
  appearance = null,
  tourActive = false,
  focusSection = '',
  onFocused,
}) {
  useInjectCss(css, 'study-settings');
  // The section shell is a shared component; sections still written by hand elsewhere borrow its stylesheet.
  useComponentCss(fieldsCss, 'study-fields');
  const [profile, setProfile] = useState(initialProfile);
  useEffect(() => {
    act('coach.profile', {}, setProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the host says is set up: read once, quietly (no model is called). It only decides which group starts open.
  const [status, setStatus] = useState({});
  useEffect(() => {
    if (typeof call !== 'function') return undefined;
    let live = true;
    const keep = (name) => (value) => { if (live && value) setStatus((current) => ({ ...current, [name]: value })); };
    if (hasContext(data, 'audio')) {
      Promise.resolve(call('audio.settings.get', {})).then((value) => keep('audio')(value && { configured: KEY_FIELDS.some((field) => value[field]?.set) }), () => {});
      Promise.resolve(call('mineru.settings.get', {})).then((value) => keep('mineru')(value && !value.unavailable && { configured: !!value.token?.set }), () => {});
    }
    if (hasContext(data, 'generation')) {
      Promise.resolve(call('retrieval.status', {})).then((value) => keep('retrieval')(value && { status: value, plan: null }), () => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // The pane for the linked category renders on the next frame: scroll to the section then.
    const frame = requestAnimationFrame(() => {
      document.querySelector(`[data-tour="${focusSection}"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      onFocused?.();
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSection]);
  // Everything a pane may need. Panes take what they use and nothing else; App still hands in the three built panels.
  const services = { data, busy, act, call, host, setNotice, settings, setSettings, legacy, setLegacy, workspacePanel, coursePanel, onboardingPanel,
    exportData, onRestored, appearance, profile, setProfile, capabilities, status };
  const selected = available.find((item) => item.id === active) || available[0];
  return (
    <section className="page settings-page">
      <h1>{ui('工作区设置')}</h1>
      <p className="muted">{ui('资料、题库、调度与模型，由你掌控。')}</p>
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

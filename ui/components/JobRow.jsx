import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import css from './feedback.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import { InlineMessage } from './Feedback.jsx';
import { Disclosure } from './Panel.jsx';
import Icon from './Icon.jsx';
import { ProgressBar } from './Progress.jsx';
import { Spinner } from './Loading.jsx';

/* How each status looks: its tone (colour) and the mark that says the same in
   shape. Completed work is jade, never the cinnabar of the primary action. */
const STATUS = {
  queued: { tone: 'info', icon: 'info' },
  running: { tone: 'accent', spinner: true },
  complete: { tone: 'success', icon: 'success' },
  failed: { tone: 'error', icon: 'error' },
  partial: { tone: 'warning', icon: 'warning' },
  cancelled: { tone: 'neutral', icon: 'close' },
  interrupted: { tone: 'warning', icon: 'warning' },
};
const statusOf = status => Object.hasOwn(STATUS, status) ? status : 'running';
const STATUS_WORDS = () => ({ queued: ui('排队中'), running: ui('处理中'), complete: ui('已完成'), failed: ui('失败'),
  partial: ui('部分完成'), cancelled: ui('已取消'), interrupted: ui('已中断') });

/**
 * What a screen reader should hear when a job changes, or '' for nothing. Only
 * a new status or a new stage counts: elapsed time, counters and progress never
 * do, so a minute of ticking is silent. `silent` marks a state that something
 * else already announces (a failure alert). The first state announces nothing.
 */
export function jobAnnouncement(previous, current) {
  if (!previous || !current) return '';
  if (previous.status === current.status && (previous.stage || '') === (current.stage || '')) return '';
  if (current.silent) return '';
  const status = statusOf(current.status);
  const words = status === 'running' && current.stage ? current.stage : STATUS_WORDS()[status];
  return typeof current.title === 'string' && current.title ? uiFormat('{0}：{1}', [current.title, words]) : words;
}

/**
 * One background job in a list: title, status mark, progress, failure with its
 * fixes, actions, dismiss. The row is not a live region (a ticking timer would
 * be read every second); a visually hidden status node speaks only when the
 * status or `stage` changes. The caller passes the elapsed/meta text in.
 *   status: queued | running | complete | failed | partial | cancelled | interrupted
 *   progress: { value, max, label, ahead?, indeterminate?, summary? }
 *   dismissTitle: what 知道了 does, as a tooltip.
 *   failure: { title, hint, detail }   actions: [{ label, onClick, variant?, icon?, disabled?, busy?, title? }]
 */
export function JobRow({ status = 'running', stage, title, meta, progress, failure, actions, onDismiss, dismissLabel, dismissTitle, leaving = false, className, children, ...rest }) {
  useComponentCss(css, 'study-feedback');
  const kind = statusOf(status), look = STATUS[kind];
  const [announced, setAnnounced] = useState('');
  const previous = useRef(null), name = useRef('');
  name.current = typeof title === 'string' ? title : '';
  const covered = kind === 'failed' && !!failure;
  useEffect(() => {
    const state = { status: kind, stage, title: name.current, silent: covered };
    const text = jobAnnouncement(previous.current, state);
    previous.current = state;
    if (text) setAnnounced(text);
  }, [kind, stage, covered]);
  const loud = kind === 'failed' ? 'error' : 'warning';
  return (
    <article className={cx('sh-job', `sh-job--${kind}`, leaving && 'is-leaving', className)} data-tone={look.tone}
      aria-hidden={leaving ? 'true' : undefined} inert={leaving || undefined} {...rest}>
      <span className="sh-job__mark" aria-hidden="true">{look.spinner ? <Spinner /> : <Icon name={look.icon} size={20} />}</span>
      <div className="sh-job__body">
        <strong className="sh-job__title">{title}</strong>
        {meta && <small className="sh-job__meta" aria-live="off">{meta}</small>}
        {progress && <div className="sh-job__progress">
          <ProgressBar value={progress.value} max={progress.max} label={progress.label} ahead={progress.ahead}
            indeterminate={progress.indeterminate} title={progress.title} size="sm" />
          {progress.summary && <div className="sh-job__summary">{progress.summary}</div>}
        </div>}
        {failure && <div className="sh-job__failure">
          {(failure.title || failure.hint) && <InlineMessage tone={loud} title={failure.title}>{failure.hint}</InlineMessage>}
          {failure.detail && <Disclosure className="sh-job__detail" summary={ui('技术详情')}><code className="sh-job__raw">{failure.detail}</code></Disclosure>}
        </div>}
        {children}
      </div>
      {(actions?.length > 0 || onDismiss) && <div className="sh-job__actions">
        {actions?.map((action, index) => <Button key={action.key ?? index} size="sm" variant={action.variant || 'secondary'} icon={action.icon}
          disabled={action.disabled} busy={action.busy} title={action.title} onClick={action.onClick}>{action.label}</Button>)}
        {onDismiss && <Button size="sm" variant="quiet" className="sh-job__dismiss" title={dismissTitle} onClick={onDismiss}>{dismissLabel || ui('知道了')}</Button>}
      </div>}
      <span className="sh-visually-hidden" role="status">{announced}</span>
    </article>
  );
}

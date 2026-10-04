import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import { InlineMessage } from './Feedback.jsx';
import Icon from './Icon.jsx';
import { formatBytes } from '../format.js';
import { extensionOf } from '../file-names.js';

export { formatBytes };

const DRAG_EVENTS = ['dragenter', 'dragover', 'dragleave', 'drop'];


/* Accept entries are extensions (".pdf", "md") or MIME types ("audio/*"). */
const rulesOf = accept => (accept || []).map(item => String(item).trim().toLowerCase()).filter(Boolean)
  .map(item => item.includes('/') || item.startsWith('.') ? item : `.${item}`);
function accepts(file, rules) {
  if (!rules.length) return true;
  const extension = extensionOf(file.name), type = String(file.type || '').toLowerCase();
  return rules.some(rule => !rule.includes('/') ? extension === rule
    : rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : type === rule);
}
const FORMAT_NAMES = { '.md': 'Markdown', '.markdown': 'Markdown', '.htm': 'HTML', '.jpeg': 'JPG' };
/** "PDF · Markdown · 音频" for hints and rejection messages. */
export function describeAccept(accept) {
  const names = rulesOf(accept).map(rule => rule.startsWith('.') ? FORMAT_NAMES[rule] || rule.slice(1).toUpperCase()
    : rule.startsWith('audio/') ? ui('音频') : rule.startsWith('image/') ? ui('图片') : rule);
  return [...new Set(names)].join(' · ');
}

/**
 * Split chosen files into accepted ones and rejections with a reason
 * ('type' | 'size' | 'empty' | 'count') and a readable message. Identical files
 * dropped twice collapse into one.
 */
export function partitionFiles(files, { accept = [], maxBytes, multiple = true } = {}) {
  const rules = rulesOf(accept), accepted = [], rejected = [], seen = new Set();
  for (const file of Array.from(files || [])) {
    const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reject = (reason, message) => rejected.push({ file, name: file.name, reason, message });
    if (!accepts(file, rules)) reject('type', uiFormat('不支持这种文件；可以选择 {0}', [describeAccept(accept)]));
    else if (maxBytes && file.size > maxBytes) reject('size', uiFormat('文件超过 {0} 的上限', [formatBytes(maxBytes)]));
    else if (!file.size) reject('empty', ui('文件是空的'));
    else if (!multiple && accepted.length) reject('count', ui('一次只能添加一个文件'));
    else accepted.push(file);
  }
  return { accepted, rejected };
}

const isFileDrag = event => {
  const types = event?.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
};
const claim = event => { event.preventDefault(); event.stopPropagation(); };

/**
 * Native drag handlers for a drop zone. A file drag is claimed at the zone
 * itself (preventDefault + stopPropagation), so neither the browser (opening
 * the file) nor a host handler further up (DSH's chat composer) receives it.
 * Text and element drags pass through untouched.
 */
export function createDropHandlers({ getOptions, onFiles, onDragState }) {
  let depth = 0;
  const blocked = () => { const options = getOptions?.() || {}; return !!(options.disabled || options.busy); };
  return {
    dragenter(event) {
      if (!isFileDrag(event)) return;
      claim(event);
      if (depth++ === 0 && !blocked()) onDragState?.(true);
    },
    dragover(event) {
      if (!isFileDrag(event)) return;
      claim(event);
      event.dataTransfer.dropEffect = blocked() ? 'none' : 'copy';
    },
    dragleave(event) {
      if (!isFileDrag(event)) return;
      event.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (!depth) onDragState?.(false);
    },
    drop(event) {
      if (!isFileDrag(event)) return;
      claim(event);
      depth = 0;
      onDragState?.(false);
      if (blocked()) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) { const { accepted, rejected } = partitionFiles(files, getOptions?.() || {}); onFiles?.(accepted, rejected); }
    },
  };
}

/**
 * Keep stray file drops inside `element` (for example the whole Study seat)
 * away from host handlers: the cursor shows "not allowed" instead of the file
 * landing in the chat. Returns a function that removes the guard.
 */
export function guardFileDrag(element) {
  const swallow = event => {
    if (!isFileDrag(event)) return;
    claim(event);
    if (event.type !== 'drop' && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  };
  const types = ['dragenter', 'dragover', 'drop'];
  types.forEach(type => element.addEventListener(type, swallow));
  return () => types.forEach(type => element.removeEventListener(type, swallow));
}

const statusLabel = status => ({ pending: ui('等待中'), working: ui('处理中'), done: ui('已完成'), error: ui('失败') })[status] || ui('等待中');
const STATUSES = new Set(['pending', 'working', 'done', 'error']);
const fileIcon = name => /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm|aiff?)$/i.test(name || '') ? 'audio' : 'file';

/**
 * The one way to hand files to StudyHub. A real, localized button opens a
 * hidden picker; files can also be dropped (several when `multiple`). Rejected
 * files are listed with the reason; `items` shows per-file progress.
 * onFiles(acceptedFiles, rejections) is called for every pick or drop.
 * items: [{ id, name, status: 'pending'|'working'|'done'|'error', detail?, action?: { label, onClick } }]
 */
export default function FileDrop({ accept = [], multiple = false, maxBytes, label, hint, buttonLabel, disabled = false, busy = false,
  onFiles, items, compact = false, icon = 'upload', className, ...rest }) {
  useComponentCss(css);
  const zone = useRef(null), input = useRef(null), latest = useRef(null);
  const labelId = useId(), hintId = useId();
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState([]);
  latest.current = { options: { accept, multiple, maxBytes, disabled, busy }, onFiles };
  useEffect(() => {
    const element = zone.current;
    if (!element) return;
    const handlers = createDropHandlers({
      getOptions: () => latest.current.options,
      onDragState: setOver,
      onFiles: (accepted, rejections) => { setRejected(rejections); latest.current.onFiles?.(accepted, rejections); },
    });
    DRAG_EVENTS.forEach(type => element.addEventListener(type, handlers[type]));
    return () => DRAG_EVENTS.forEach(type => element.removeEventListener(type, handlers[type]));
  }, []);
  const blocked = disabled || busy;
  const open = () => { if (!blocked) input.current?.click(); };
  const limits = [hint ?? describeAccept(accept), maxBytes ? uiFormat('最大 {0}', [formatBytes(maxBytes)]) : ''].filter(Boolean).join(' · ');
  return (
    <div className={cx('sh-filedrop', className)}>
      <div ref={zone} role="group" aria-labelledby={labelId} aria-describedby={limits ? hintId : undefined}
        aria-disabled={disabled || undefined} aria-busy={busy || undefined}
        className={cx('sh-drop', compact && 'sh-drop--compact', over && 'is-over')}
        onClick={event => { if (!event.target.closest('button, a, input')) open(); }} {...rest}>
        <span className="sh-drop__icon" aria-hidden="true"><Icon name={icon} size={compact ? 18 : 22} /></span>
        <div className="sh-drop__text">
          <p id={labelId} className="sh-drop__label">{label || (multiple ? ui('把文件拖到这里，可以一次放多个') : ui('把文件拖到这里'))}</p>
          {limits && <p id={hintId} className="sh-drop__hint">{limits}</p>}
        </div>
        <Button variant="secondary" icon="plus" busy={busy} disabled={disabled} aria-describedby={limits ? hintId : undefined} onClick={open}>
          {buttonLabel || (multiple ? ui('选择文件') : ui('选择一个文件'))}
        </Button>
        <input ref={input} type="file" hidden tabIndex={-1} accept={rulesOf(accept).join(',') || undefined} multiple={multiple} disabled={blocked}
          onChange={event => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (!files.length) return;
            const result = partitionFiles(files, { accept, multiple, maxBytes });
            setRejected(result.rejected);
            onFiles?.(result.accepted, result.rejected);
          }} />
      </div>
      {rejected.length > 0 && <InlineMessage tone="warning" boxed className="sh-drop__rejects" onDismiss={() => setRejected([])}
        title={uiFormat('{0} 个文件没有添加', [rejected.length])}>
        <ul>{rejected.map((item, index) => <li key={`${item.name}:${index}`}><span className="sh-drop__reject-name">{item.name}</span>{item.message}</li>)}</ul>
      </InlineMessage>}
      {items?.length > 0 && <ul className="sh-file-list" aria-live="polite" aria-label={ui('已选择的文件')}>
        {items.map(item => {
          const status = STATUSES.has(item.status) ? item.status : 'pending';
          return (
            <li key={item.id ?? item.name} className={`sh-file sh-file--${status}`}>
              <Icon name={fileIcon(item.name)} size={18} className="sh-file__icon" />
              <span className="sh-file__text">
                <span className="sh-file__name" title={item.name}>{item.name}</span>
                {item.detail && <span className="sh-file__detail">{item.detail}</span>}
              </span>
              <span className={`sh-file-chip sh-file-chip--${status}`}>
                {status === 'working' && <span className="sh-spinner" aria-hidden="true" />}
                {status === 'done' && <Icon name="check" size={14} strokeWidth={2} />}
                {statusLabel(status)}
              </span>
              {item.action && <Button variant="quiet" size="sm" disabled={item.action.disabled} onClick={item.action.onClick}>{item.action.label}</Button>}
            </li>
          );
        })}
      </ul>}
    </div>
  );
}

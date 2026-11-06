import React, { useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, DisclosureToggle, Popover, foldLabel } from '../../components/index.js';
import { HandOff } from '../../hand-off/HandOff.jsx';
import { useInjectCss } from '../../shared.js';
import { mapOutlineText, openByDefault } from './mind-map.js';
import css from './reader-slim.css';

/* 思维导图 of the reader: the current chapter as a tree (chapter → sections → sub-sections), drawn from its headings (reader/mind-map.js), no model call and no
   tokens. Plain nested lists with their lines drawn in CSS, so it reads at 420 px (a vertical tree). A node jumps to its place; the arrow folds its branch; the
   top two levels start open. 交给主会话细化 hands the tree to the main chat to refine from the chapter's pages (registry id reader.map). */

function Branch({ nodes, open, onToggle, onJump }) {
  return <ul className="reader-map__list">
    {nodes.map(node => {
      const foldable = node.children.length > 0, shown = open.has(node.id);
      return <li key={node.id} className="reader-map__item" data-depth={Math.min(node.depth, 5)}>
        <div className="reader-map__row">
          {foldable ? <DisclosureToggle className="reader-map__twisty" open={shown} label={foldLabel(shown, node.title)} onToggle={() => onToggle(node.id)} />
            : <span className="reader-map__twisty reader-map__twisty--none" aria-hidden="true" />}
          <Button variant="quiet" size="sm" align="start" wrap className="reader-map__node" onClick={() => onJump(node)}>{node.title}</Button>
        </div>
        {foldable && shown && <Branch nodes={node.children} open={open} onToggle={onToggle} onJump={onJump} />}
      </li>;
    })}
  </ul>;
}

/** The body, mounted when the panel opens (so a new chapter starts with the top two levels open). */
function MapBody({ map, document, pages, onJump }) {
  const [open, setOpen] = useState(() => openByDefault(map));
  const toggle = id => setOpen(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  return <div className="reader-map__body">
    <p className="reader-map__root">{map.title}</p>
    {map.count > 0 ? <Branch nodes={map.children} open={open} onToggle={toggle} onJump={onJump} />
      : <p className="reader-map__empty" role="status">{ui('这一章里没有可用的标题。')}</p>}
    {map.truncated && <p className="reader-map__empty">{uiFormat('标题很多，只画了前 {0} 个。', [map.count])}</p>}
    <div className="reader-map__foot">
      <HandOff id="reader.map" shape="secondary" label={ui('交给主会话细化')} what={ui('让主会话照这一章的页面把这张图补全。')}
        input={() => ({ title: document, chapter: map.title, from: pages?.from, to: pages?.to, outline: mapOutlineText(map) })} />
    </div>
  </div>;
}

/**
 * The 思维导图 button of the toolbar and its panel. map: buildMindMap's tree of the current chapter; document: the material's name; pages: { from, to } of the chapter;
 * onJump(node): where a node leads (the panel closes after it).
 */
export default function MindMapPanel({ map, document, pages, onJump }) {
  useInjectCss(css, 'study-reader-slim');
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen} label={ui('思维导图')} className="reader-popover reader-map" panelClassName="reader-popover__panel reader-map__panel"
    boundsSelector=".study-document-viewer" flip={false} data-tour="reader-map"
    trigger={({ props, ref }) => <Button ref={ref} size="sm" variant="quiet" icon="nav-skeleton" iconClassName="reader-toolbar__word-icon" className="reader-toolbar__action" {...props}>{ui('思维导图')}</Button>}>
    <MapBody key={map.title} map={map} document={document} pages={pages} onJump={node => { setOpen(false); onJump(node); }} />
  </Popover>;
}

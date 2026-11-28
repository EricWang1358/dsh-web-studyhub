import React, { useEffect, useRef, useState } from 'react';
import { ui } from './i18n.js';
import { ARCHIFY, installCommand } from './archify.js';
import { useCopyFeedback } from './use-copy-feedback.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, Icon } from './components/index.js';
import css from './skeleton-companion.css';

/* 推荐 Archify (docs/companions.md). One quiet line on the 知识骨架 page, closed until the learner opens it (#1705); inside: what the open-source
   plugin does, who made it under what licence (a fact, not a partnership), where to read more, and the one DSH command that installs it in a field
   that copies. StudyHub neither bundles nor rebuilds Archify. "以后再说" is remembered by the page (ui/archify.js); the line never blocks anything.
   `hasSkeletons`: when the first saved skeleton appears (false to true) an open line folds again, so the page's own work is what is left to look at. */

function OutsideLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}<Icon name="external" className="sh-icon--inline sh-icon--trail" /><span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a>
  );
}

export default function ArchifyCard({ onLater, profile = 'web', hasSkeletons = false }) {
  useInjectCss(css, 'study-skeleton-companion');
  const [open, setOpen] = useState(false);
  const had = useRef(hasSkeletons);
  useEffect(() => { if (hasSkeletons && !had.current) setOpen(false); had.current = hasSkeletons; }, [hasSkeletons]);
  const command = installCommand(profile);
  const { copied, copy } = useCopyFeedback(command);
  return (
    <aside className="sk-archify" aria-label={ui('想要更漂亮、可以交互的图？推荐开源插件 Archify')} data-archify-card="">
    <Disclosure summary={ui('想要更漂亮、可以交互的图？推荐开源插件 Archify')} open={open} onToggle={setOpen} summaryClassName="sk-archify__summary" bodyClassName="sk-archify__body">
      <p className="sk-archify__text">{ui('Archify 能把描述、方案或代码库画成一份自包含的交互式 HTML 图，有架构图、流程图、时序图、数据流图和生命周期图五种，离线也能在浏览器里打开。')}</p>
      <p className="sk-archify__credit muted small">
        {ui('MIT 开源，作者 tt-a1i；与 StudyHub 没有合作关系。')}{' '}
        <OutsideLink href={ARCHIFY.repo}>{ui('Archify 项目主页')}</OutsideLink>{' · '}
        <OutsideLink href={ARCHIFY.gallery}>{ui('在线示例')}</OutsideLink>
      </p>
      <div className="sk-archify__install">
        <span className="sk-archify__label">{ui('安装到 DSH')}</span>
        {/* The whole command stays readable at any width (it wraps); one click selects all of it. */}
        <code className="sk-archify__command" tabIndex={0} role="group" aria-label={ui('Archify 安装命令')}>{command}</code>
        <Button size="sm" icon={copied ? 'check' : undefined} onClick={copy}>{copied ? ui('已复制') : ui('复制')}</Button>
      </div>
      <p className="sk-archify__note muted small">{ui('命令里的 web 是 DSH 的 profile 名；桌面版通常是 desktop，请换成你正在用的。')}</p>
      {onLater && <Button variant="link" size="sm" className="sk-archify__later" onClick={onLater}>{ui('以后再说')}</Button>}
    </Disclosure>
    </aside>
  );
}

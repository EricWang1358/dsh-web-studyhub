import React, { useEffect, useId, useRef, useState } from 'react';
import { ui } from './i18n.js';
import { ARCHIFY, installCommand } from './archify.js';
import { useCopyFeedback } from './use-copy-feedback.js';
import { useInjectCss } from './shared.js';
import { Button, Icon } from './components/index.js';
import css from './skeleton-companion.css';

/* 推荐 Archify (docs/companions.md). One quiet hairline hint at the end of the 知识骨架 page, collapsed by default so
   the page's own topic picker and saved outlines stay primary and no CLI command is exposed until the learner asks for
   more. StudyHub neither bundles nor rebuilds Archify. "以后再说" is remembered by the page (ui/archify.js). */

function OutsideLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}<Icon name="external" className="sh-icon--inline sh-icon--trail" /><span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a>
  );
}

export default function ArchifyCard({ onLater, profile = 'web', hasSkeletons = false }) {
  useInjectCss(css, 'study-skeleton-companion');
  const [expanded, setExpanded] = useState(false);
  const prevHasSkeletons = useRef(hasSkeletons);
  useEffect(() => {
    if (hasSkeletons && !prevHasSkeletons.current) setExpanded(false);
    prevHasSkeletons.current = hasSkeletons;
  }, [hasSkeletons]);
  const panelId = useId();
  const command = installCommand(profile);
  const { copied, copy } = useCopyFeedback(command);
  return (
    <aside
      className="sk-archify"
      aria-label={ui('想要更漂亮、可以交互的图？推荐开源插件 Archify')}
      data-archify-card=""
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div className="sk-archify__bar">
        <span className="sk-archify__hint">{ui('想要更漂亮、可以交互的图？推荐开源插件 Archify')}</span>
        <div className="sk-archify__actions">
          <Button
            variant="link"
            size="sm"
            aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? ui('收起') : ui('了解更多')}
          </Button>
          {onLater && <Button variant="link" size="sm" className="sk-archify__later" onClick={onLater}>{ui('以后再说')}</Button>}
        </div>
      </div>
      {expanded && (
        <div id={panelId} className="sk-archify__details">
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
        </div>
      )}
    </aside>
  );
}

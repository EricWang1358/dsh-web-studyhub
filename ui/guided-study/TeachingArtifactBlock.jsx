import React, { useState } from 'react';
import { Button } from '../components/Button.jsx';
import Markdown from '../Markdown.jsx';
import { ReadingBlock } from '../reading-settings/ReadingSettings.jsx';
import { ui, uiFormat } from '../i18n.js';

function sanitizeTeachingMarkdown(markdown) {
  if (typeof markdown !== 'string') return '';
  let clean = markdown;
  clean = clean.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  clean = clean.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
  clean = clean.replace(/\son\w+\s*=\s*[^>\s]+/gi, '');
  clean = clean.replace(/javascript\s*:/gi, 'about:blank#blocked-');
  return clean;
}

export function TeachingArtifactBlock({ artifact, onAnchorClick }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!artifact) {
    return (
      <div className="teaching-artifact-block teaching-artifact-empty">
        <span>{ui('还没有讲解内容')}</span>
      </div>
    );
  }

  const cleanMd = sanitizeTeachingMarkdown(artifact.markdown || '');
  const collapsible = cleanMd.length > 240;

  return (
    <div className="teaching-artifact-block" data-artifact-id={artifact.id}>
      <div className="teaching-artifact-header">
        <span className="teaching-artifact-title">{artifact.title || ui('讲解')}</span>
        <div className="teaching-artifact-header-meta">
          {artifact.topic && <span className="teaching-artifact-topic">{artifact.topic}</span>}
          {collapsible && (
            <Button variant="quiet" size="sm" onClick={() => setCollapsed((current) => !current)}>
              {collapsed ? ui('展开') : ui('收起')}
            </Button>
          )}
        </div>
      </div>

      <ReadingBlock
        prose
        measure={false}
        className={`teaching-artifact-content${collapsed ? ' is-collapsed' : ''}`}
      >
        <Markdown text={cleanMd} />
      </ReadingBlock>

      {Array.isArray(artifact.sourceAnchors) && artifact.sourceAnchors.length > 0 && (
        <div className="teaching-artifact-anchors">
          {artifact.sourceAnchors.map((anchor, idx) => (
            <Button
              key={idx}
              variant="quiet"
              size="sm"
              className="teaching-anchor-tag"
              onClick={() => onAnchorClick?.(anchor)}
            >
              {anchor.page ? uiFormat('出处：{0} 第 {1} 页', [anchor.sourceId, anchor.page]) : uiFormat('出处：{0}', [anchor.sourceId])}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

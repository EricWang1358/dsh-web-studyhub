import React from 'react';
import { Button } from '../components/Button.jsx';
import { renderNoteMarkdown } from '../note-markdown.js';
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
  if (!artifact) {
    return (
      <div className="teaching-artifact-block teaching-artifact-empty">
        <span className="teaching-artifact-muted">{ui('还没有讲解内容')}</span>
      </div>
    );
  }

  const cleanMd = sanitizeTeachingMarkdown(artifact.markdown || '');
  const renderedHtml = renderNoteMarkdown(cleanMd);

  return (
    <div className="teaching-artifact-block" data-artifact-id={artifact.id}>
      <div className="teaching-artifact-header">
        <span className="teaching-artifact-title">{artifact.title || ui('讲解')}</span>
        {artifact.topic && <span className="teaching-artifact-topic">{artifact.topic}</span>}
      </div>

      <div
        className="teaching-artifact-content markdown-body"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />

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

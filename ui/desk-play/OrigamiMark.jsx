import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Tooltip } from '../components/index.js';

/**
 * Geometric 5-stage origami progress mark (pure SVG, crisp across all 5 themes).
 * Unfolds smoothly as today's completed/goal ratio climbs from 0 (unfolded sheet)
 * to 4 (settled paper crane). Zero guilt on stage 0; static under reduced motion.
 */
export default function OrigamiMark({ stage = 0, done = 0, goal = 20, label = '', caption = '' }) {
  const safeStage = Math.max(0, Math.min(4, Math.floor(Number(stage) || 0)));
  const tip = `${ui(label || '素笺待折')} · ${uiFormat('今日已完成 {0} / {1} 题', [done, goal])}${caption ? ` — ${ui(caption)}` : ''}`;

  return (
    <Tooltip layer content={tip}>
      <div
        className="desk-play-origami"
        data-stage={safeStage}
        tabIndex={0}
        role="img"
        aria-label={tip}
      >
        <svg className="desk-play-origami__svg" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true">
          {safeStage === 0 && (
            <g className="desk-play-origami__group">
              <polygon className="desk-play-origami__paper" points="16,14 50,14 50,48 16,48" />
              <polygon className="desk-play-origami__shade" points="50,14 50,48 36,48 50,34" />
              <line className="desk-play-origami__crease" x1="18" y1="46" x2="48" y2="16" />
            </g>
          )}
          {safeStage === 1 && (
            <g className="desk-play-origami__group">
              <polygon className="desk-play-origami__shade" points="12,48 52,48 52,14" />
              <polygon className="desk-play-origami__paper" points="12,48 34,24 52,14 38,48" />
              <line className="desk-play-origami__ridge" x1="12" y1="48" x2="52" y2="14" />
              <line className="desk-play-origami__crease" x1="34" y1="24" x2="38" y2="48" />
            </g>
          )}
          {safeStage === 2 && (
            <g className="desk-play-origami__group">
              <polygon className="desk-play-origami__paper" points="32,8 12,34 32,56" />
              <polygon className="desk-play-origami__shade" points="32,8 52,34 32,56" />
              <polygon className="desk-play-origami__highlight" points="32,16 19,34 32,44" />
              <line className="desk-play-origami__ridge" x1="32" y1="8" x2="32" y2="56" />
              <line className="desk-play-origami__crease" x1="12" y1="34" x2="52" y2="34" />
            </g>
          )}
          {safeStage === 3 && (
            <g className="desk-play-origami__group">
              <polygon className="desk-play-origami__shade" points="32,30 56,14 42,42" />
              <polygon className="desk-play-origami__paper" points="32,30 8,16 22,42" />
              <polygon className="desk-play-origami__highlight" points="32,14 22,42 32,54 42,42" />
              <line className="desk-play-origami__ridge" x1="32" y1="14" x2="32" y2="54" />
              <circle className="desk-play-origami__seal" cx="32" cy="14" r="2.6" />
            </g>
          )}
          {safeStage === 4 && (
            <g className="desk-play-origami__group">
              <polygon className="desk-play-origami__shade" points="26,38 42,10 46,34" />
              <polygon className="desk-play-origami__shade" points="38,40 56,22 46,44" />
              <polygon className="desk-play-origami__paper" points="22,40 12,18 7,22 15,24 20,45" />
              <polygon className="desk-play-origami__paper" points="20,40 54,24 41,45" />
              <polygon className="desk-play-origami__highlight" points="20,40 31,34 41,45 28,50" />
              <line className="desk-play-origami__ridge" x1="20" y1="40" x2="41" y2="45" />
              <circle className="desk-play-origami__seal" cx="12" cy="18" r="2.4" />
            </g>
          )}
        </svg>
      </div>
    </Tooltip>
  );
}

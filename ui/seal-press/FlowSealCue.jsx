/* Quiet Flow Cadence & Leech Conquest Seal for QuestionRun.jsx.
   - Header variant: calm inline cadence badge at 3+, 5+, 8+ consecutive correct answers;
     disappears quietly on miss (zero guilt, docs/voice-and-tone.md Rule 7).
   - Verdict variant: crisp vermilion 破顽 carved seal stamp + editorial ink underline when
     conquering a stubborn/leech card, or subtle ochre ink highlight on flow milestones. */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { uiRich } from '../i18n-rich.jsx';
import { useInjectCss } from '../shared.js';
import { isPassed } from '../review/session-logic.js';
import InkMark from './InkMark.jsx';
import { buildSealSvg, computeFlowStreak, isLeechConquered, SEAL_CATALOG, svgToDataUri } from './seal-generator.js';
import { recordConqueredLeech } from './seal-storage.js';
import { useSealPalette } from './use-seal-palette.js';
import sealPressCss from './seal-press.css';

function flowLabel(flow) {
  if (flow.tier === 3) return uiFormat('连对 {0} · 如鱼得水', [flow.streak]);
  if (flow.tier === 2) return uiFormat('连对 {0} · 渐入佳境', [flow.streak]);
  return uiFormat('连对 {0} · 手感渐稳', [flow.streak]);
}

function flowTagline(flow) {
  if (flow.tier === 3) return ui('如鱼得水');
  if (flow.tier === 2) return ui('渐入佳境');
  return ui('手感渐稳');
}

export default function FlowSealCue({ run, variant = 'header' }) {
  useInjectCss(sealPressCss, 'study-seal-press');
  const hostRef = React.useRef(null);
  const { palette } = useSealPalette(hostRef);

  const conquered = isLeechConquered(run);
  const flow = computeFlowStreak(run);

  React.useEffect(() => {
    if (conquered && run?.id && run?.card?.id) {
      recordConqueredLeech(run.id, run.card.id);
    }
  }, [conquered, run?.id, run?.card?.id]);

  if (!run || run.mode === 'exam' || run.complete) return null;

  if (variant === 'header') {
    if (!flow) return null;
    return (
      <span
        ref={hostRef}
        key={`flow-${flow.tier}`}
        className="sh-seal-flow-cue"
        data-tier={flow.tier}
        data-streak={flow.streak}
        data-testid="flow-seal-cue"
        role="status"
      >
        <span className="sh-seal-flow-cue__ring" aria-hidden="true" />
        <span>{flowLabel(flow)}</span>
      </span>
    );
  }

  if (variant === 'verdict') {
    if (conquered) {
      const leechSeal = {
        ...SEAL_CATALOG['leech-cleared'],
        seed: (run.card?.id ? run.card.id.length * 7919 : 97) + 31,
      };
      const stampUri = svgToDataUri(buildSealSvg(leechSeal, {
        style: 'yin',
        size: 48,
        ink: palette.accent,
        paper: palette.paper,
      }));
      return (
        <div ref={hostRef} className="sh-seal-verdict-row" data-testid="leech-conquered-seal" role="status">
          <span className="sh-seal-verdict-stamp" aria-hidden="true">
            <img className="sh-seal-verdict-stamp__img" src={stampUri} alt="" draggable={false} />
          </span>
          <span className="sh-seal-verdict-copy">
            <InkMark type="underline" tone="accent" padding={2} strokeWidth={1.8}>
              <span className="sh-seal-verdict-lead">{ui('破顽')}</span>
            </InkMark>
            <span>{ui('这道曾反复出错的题，这次稳稳过关')}</span>
          </span>
        </div>
      );
    }

    if (run.feedback && flow && flow.isMilestone && isPassed(run)) {
      return (
        <div ref={hostRef} className="sh-seal-verdict-flow" data-testid="flow-milestone-mark" role="status">
          {uiRich(
            '已连对 {0} 题，{1}',
            flow.streak,
            <InkMark type="highlight" tone="warning" padding={2}>
              <span className="sh-seal-verdict-flow__phrase">{flowTagline(flow)}</span>
            </InkMark>,
          )}
        </div>
      );
    }
  }

  return null;
}

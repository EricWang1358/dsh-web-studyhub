/* 3D tactile tilt showcase for Collectible Ex-Libris Postcards using `react-parallax-tilt` (MIT)
   plus a clean-room subtle CSS matte-cotton specular sheen.
   Strictly disabled under SSR, OS `prefers-reduced-motion: reduce`, and StudyHub `[data-motion="reduced"|"off"]`. */
import React from 'react';
import ParallaxTiltModule from 'react-parallax-tilt';
import { cx } from '../components/css.js';
import { useInjectCss } from '../shared.js';
import studioCss from './postcard-studio.css';

const Tilt = ParallaxTiltModule?.default || ParallaxTiltModule;

export default function PostcardTilt({ reducedMotion = false, edition = 'letterpress', className, children }) {
  useInjectCss(studioCss, 'study-seal-press-studio');
  const stageRef = React.useRef(null);
  const canTilt = typeof window !== 'undefined' && !reducedMotion && typeof Tilt === 'function';
  const sizeClass = edition === 'archival-slip' ? 'sh-postcard-stage--slip' : 'sh-postcard-stage--wide';

  const handleMove = React.useCallback((info) => {
    const el = stageRef.current;
    if (!el || !info) return;
    const px = Math.max(0, Math.min(100, 50 + (Number(info.tiltAngleYPercentage) || 0) * 0.42));
    const py = Math.max(0, Math.min(100, 50 - (Number(info.tiltAngleXPercentage) || 0) * 0.42));
    el.style.setProperty('--sh-sheen-x', `${px.toFixed(1)}%`);
    el.style.setProperty('--sh-sheen-y', `${py.toFixed(1)}%`);
    el.style.setProperty('--sh-sheen-op', '0.18');
  }, []);

  const handleLeave = React.useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    el.style.setProperty('--sh-sheen-op', '0');
  }, []);

  const cardBody = (
    <div ref={stageRef} className={cx('sh-postcard-stage', sizeClass, className)} data-tilt-active={canTilt ? 'true' : 'false'}>
      {children}
      {canTilt && <span className="sh-postcard-stage__sheen" aria-hidden="true" />}
    </div>
  );

  if (!canTilt) {
    return <div className="sh-postcard-stage-wrap">{cardBody}</div>;
  }

  return (
    <div className="sh-postcard-stage-wrap">
      <Tilt
        tiltEnable
        tiltMaxAngleX={9}
        tiltMaxAngleY={9}
        perspective={1100}
        scale={1.015}
        transitionSpeed={420}
        glareEnable={false}
        onMove={handleMove}
        onLeave={handleLeave}
      >
        {cardBody}
      </Tilt>
    </div>
  );
}

import React from "react";
import { ui } from "../i18n.js";
import { Button, Icon } from "../components/index.js";
import { useAppearance, useAppearanceAttrs } from "../use-appearance.js";
import { appearanceStyle } from "../appearance-prefs.js";

/** The StudyHub mark for DSH's own sidebar, where the study tokens are absent. */
export function StudyHubGlyph({ size = 16 }) {
  return <Icon name="brand-compact" size={size} />;
}

/** The page before DSH has selected any session: the library lives in a session's workspace. */
export function NoSessionNotice({ onStart }) {
  /* The same preferences and attributes as App's root: the theme (following the OS live), size, typeface and motion. */
  const prefs = useAppearance()[0], attrs = useAppearanceAttrs(prefs);
  return (
    <div className="study-seat">
      <div className="study-app" {...attrs} style={appearanceStyle(prefs)}>
        <div className="studyhub-page-empty">
          <StudyHubGlyph size={40} />
          <h1>{ui("先打开一个会话")}</h1>
          <p>{ui("StudyHub 的学习库存放在会话的工作区里。新建或打开一个会话后，这里会直接显示你的学习库。")}</p>
          {onStart && <Button variant="primary" onClick={onStart}>{ui("新建会话")}</Button>}
        </div>
      </div>
    </div>
  );
}

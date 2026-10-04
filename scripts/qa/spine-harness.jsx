/* Spine QA harness (built by scripts/qa/spine-layout.mjs): the 本次脉络 panel exactly as the learning flow mounts it
   (SpinePeek, or the skeleton step's own spine) followed by a stand-in for the lesson that sits below it.
   Query: ?lang=zh|en&theme=dark|light&mode=peek|subject */
import React from "react";
import { createRoot } from "react-dom/client";
import styleCss from "../../ui/styles.js";
import skeletonCss from "../../ui/skeleton.css";
import workflowsCss from "../../ui/workflows.css";
import { setUiLanguage } from "../../ui/i18n.js";
import SkeletonSpine from "../../ui/SkeletonSpine.jsx";
import { SpinePeek } from "../../ui/WorkflowPortal.jsx";
import { spineFixture } from "./spine-fixture.mjs";

const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "en" ? "en" : "zh";
const theme = params.get("theme") === "light" ? "light" : "dark";
const mode = params.get("mode") === "subject" ? "subject" : "peek";
setUiLanguage(lang);
const style = document.createElement("style");
style.textContent = `${styleCss}\n${skeletonCss}\n${workflowsCss}\nhtml, body, #root { margin: 0; }`;
document.head.appendChild(style);

const skeleton = spineFixture(lang);
const session = { skeletonJob: { status: "done" }, status: "active" };
const resources = { skeleton, cardCount: 40, modelReady: true };

function App() {
  return (
    <div className="study-app" data-theme={theme} style={{ minHeight: "100vh", background: "var(--bg-canvas)", color: "var(--text)", containerType: "inline-size", containerName: "study" }}>
      <main><section className="page workflow-page wf-portal">
        <ol className="wf-portal-route" aria-label="route"><li>01</li><li className="is-current">02</li></ol>
        {mode === "peek"
          ? <SpinePeek session={session} resources={resources} stepKind="lesson" late={false} disabled={false} onGenerate={() => {}} />
          : <div className="wf-skeleton"><h3>{skeleton.title}</h3><SkeletonSpine skeleton={skeleton} stepKind="skeleton" onPractice={() => {}} /></div>}
        <article className="wf-activity" id="lesson-marker"><div className="wf-section-head"><h2>{lang === "en" ? "Concepts and examples" : "概念与例子"}</h2></div><p>{lang === "en" ? "The lesson text starts here." : "讲解正文从这里开始。"}</p></article>
      </section></main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);

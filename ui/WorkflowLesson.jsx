import { ui, uiFormat } from "./i18n.js";
import React, { useMemo } from "react";
import { renderNoteMarkdown } from "./note-markdown.js";
import { TokenUsage } from "./TokenUsage.jsx";
import { ReadingBlock, ReadingSettingsButton } from "./reading-settings/ReadingSettings.jsx";
import { useInjectCss } from "./shared.js";
import scopeCss from "./workflow-scope.css";

export const TeachingArticle = React.memo(function TeachingArticle({ content, className = "" }) {
  const html = useMemo(() => renderNoteMarkdown(content), [content]);
  return <ReadingBlock prose className={`wf-prose ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
});

const HELP_LABELS = { example: "换个例子", steps: "拆开讲", prerequisite: "补前置" };

function TeachingCitations({ citations, sources }) {
  if (!citations?.length) return null;
  return (
    <details className="wf-readings">
      <summary>{uiFormat("这篇讲解的资料依据 · {0} 处", [citations.length])}</summary>
      {citations.map((ref, index) => (
        <blockquote key={index}>
          <p>{ref.quote}</p>
          <cite>{sources?.find((source) => source.id === ref.sourceId)?.title || ui("关联资料")}</cite>
        </blockquote>
      ))}
    </details>
  );
}

/* Read-only historical lesson view for archived learning-flow sessions (#779). */
export default function WorkflowLesson({ content, record, resources }) {
  useInjectCss(scopeCss, "study-workflow-scope");
  const teaching = record?.teaching;
  const help = record?.help || [];
  const remedy = help.findLast((item) => item.kind === "remedy");
  const others = remedy ? help.filter((item) => item !== remedy) : help;
  const gaps = (remedy?.request || "").split("；").map((gap) => gap.trim()).filter(Boolean);
  return (
    <section className="wf-teaching" aria-label={ui("学习讲解")}>
      {remedy && (
        <aside className="wf-remedy" aria-label={ui("针对复述补讲")}>
          <p className="wf-eyebrow">{ui("针对你复述里漏掉的地方")}</p>
          {gaps.length > 0 && (
            <ul className="wf-remedy-gaps">
              {gaps.map((gap) => <li key={gap}>{/[？?]$/.test(gap) ? uiFormat("想一想：{0}", [gap]) : gap}</li>)}
            </ul>
          )}
          <TeachingArticle content={remedy.content} />
          <TeachingCitations citations={remedy.citations} sources={resources?.sources} />
        </aside>
      )}
      <header className="wf-teaching-heading">
        <div>
          <span className="wf-eyebrow">{ui("围绕主题，连起来学")}</span>
          <h3>{content ? ui("本步讲解") : ui("本步未保存讲解")}</h3>
        </div>
        {content && <span className="wf-reading-label">{ui("阅读 · 理解 · 应用")}</span>}
        <ReadingSettingsButton className="wf-reading" />
      </header>
      {content ? <TeachingArticle content={content} /> : <p className="muted">{ui("该历史步骤没有已保存的讲解正文。")}</p>}
      <TeachingCitations citations={record?.citations} sources={resources?.sources} />
      {teaching?.status === "done" && teaching.tokenUsage && (
        <details className="wf-teaching-usage">
          <summary>{ui("本次讲解的用量")}</summary>
          <TokenUsage usage={teaching.tokenUsage} />
        </details>
      )}
      {others.length > 0 && (
        <section className="wf-teaching-help" aria-label={ui("补充讲解")}>
          <h4>{ui("再换一种方式理解")}</h4>
          {others.map((item, index) => (
            <details key={item.id || index} open={index === others.length - 1}>
              <summary>{item.title || (HELP_LABELS[item.kind] ? ui(HELP_LABELS[item.kind]) : ui("补充讲解"))}</summary>
              <TeachingArticle content={item.content} />
              <TeachingCitations citations={item.citations} sources={resources?.sources} />
            </details>
          ))}
        </section>
      )}
    </section>
  );
}

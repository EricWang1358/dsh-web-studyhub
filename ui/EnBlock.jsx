import React from "react";
import { ui, useUiLanguage } from "./i18n.js";
import Markdown from "./Markdown.jsx";
import { Badge } from "./components/index.js";

/** Bilingual EN translation block with a local collapse/expand toggle on its EN badge. */
export default function EnBlock({ text, inline = false, mediaInteractive = false, className = "" }) {
  useUiLanguage();
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    setCollapsed(false);
  }, [text]);
  if (!text) return null;

  const toggle = (event) => {
    event.stopPropagation();
    setCollapsed((prev) => !prev);
  };
  const onKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed((prev) => !prev);
    }
  };

  const Tag = inline ? "p" : "div";
  const classes = [
    "en-block",
    inline ? "en-inline-line" : "",
    collapsed ? "is-collapsed" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes}>
      <span
        role="button"
        tabIndex={0}
        className="en-block__toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? ui("展开译文") : ui("收起译文")}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <Badge size="sm" tone="accent" className="en-mark">EN</Badge>
        {collapsed && <span className="en-block__hint">{ui("展开译文")}</span>}
      </span>
      {!collapsed && (
        inline
          ? text
          : <Markdown links={false} mediaInteractive={mediaInteractive} className="md-compact" text={text} />
      )}
    </Tag>
  );
}

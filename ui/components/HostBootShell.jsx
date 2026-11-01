import React from "react";

/* Self-contained boot shell for ui/host.jsx (#630).
   Keep this file imported ONLY by ui/host.jsx and importing ONLY "react":
   scripts/build.mjs requires client.js to expose apply(ctx) with zero static
   chunk imports, so client.js must never share a chunk with workspace.jsx. */

const COMPOSER_FRAME_STYLE = {
  boxSizing: "border-box",
  height: "100%",
  minHeight: 0,
  paddingBottom: "calc(var(--dsh-composer-height, 152px) + 12px)",
};

const SHELL_STYLE = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "center",
  gap: "10px",
  maxWidth: "460px",
  margin: "24px auto",
  padding: "20px 22px",
  borderRadius: "10px",
  border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
  background: "color-mix(in srgb, currentColor 3%, transparent)",
  color: "inherit",
  fontSize: "14px",
  lineHeight: 1.55,
};

const LOADING_STYLE = {
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "140px",
  padding: "24px",
  color: "inherit",
  opacity: 0.72,
  fontSize: "13px",
};

const RETRY_BUTTON_STYLE = {
  appearance: "none",
  cursor: "pointer",
  padding: "6px 14px",
  borderRadius: "7px",
  border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
  background: "color-mix(in srgb, currentColor 8%, transparent)",
  color: "inherit",
  font: "inherit",
  fontSize: "13px",
  fontWeight: 500,
};

const DETAILS_PRE_STYLE = {
  margin: "6px 0 0",
  padding: "8px 10px",
  maxWidth: "100%",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  borderRadius: "6px",
  background: "color-mix(in srgb, currentColor 6%, transparent)",
  fontSize: "12px",
};

/** The StudyHub mark for DSH's left sidebar, rendered without loading workspace chunks. */
export function StudyHubBrandGlyph({ size = 16 }) {
  return (
    <svg
      className="sh-icon"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="7" y="4" width="20" height="24" rx="2.5" strokeWidth="2" />
      <path d="M4.5 9h4.5M4.5 16h4.5M4.5 23h4.5" strokeWidth="2" />
      <path d="M15.5 10h7.5M15.5 14h5" strokeWidth="1.6" opacity="0.7" />
      <path d="m15.5 20.5 2.4 2.4 4.9-5.4" strokeWidth="2.2" style={{ stroke: "var(--accent-soft, #c93d22)" }} />
    </svg>
  );
}

export function HostBootFallback({ status = "loading", error = null, copy, onRetry, composerOverlay = false }) {
  const detail = typeof error?.message === "string" && error.message ? error.message : error ? String(error) : "";
  const content = status === "error" ? (
    <div role="alert" style={SHELL_STYLE}>
      <strong style={{ fontSize: "15px", fontWeight: 600 }}>{copy.failedTitle}</strong>
      <p style={{ margin: 0, opacity: 0.82 }}>{copy.failedHint}</p>
      {typeof onRetry === "function" && (
        <button type="button" onClick={onRetry} style={RETRY_BUTTON_STYLE}>
          {copy.retry}
        </button>
      )}
      {detail && (
        <details style={{ width: "100%", opacity: 0.78, fontSize: "12px" }}>
          <summary style={{ cursor: "pointer" }}>{copy.details}</summary>
          <pre style={DETAILS_PRE_STYLE}>{detail}</pre>
        </details>
      )}
    </div>
  ) : (
    <div role="status" aria-live="polite" style={LOADING_STYLE}>
      <span>{copy.loading}</span>
    </div>
  );
  return composerOverlay ? (
    <div className="study-seat-frame" data-conversation-composer-overlay="" style={COMPOSER_FRAME_STYLE}>
      {content}
    </div>
  ) : content;
}

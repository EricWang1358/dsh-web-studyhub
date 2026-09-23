import React from "react";

/* 顶栏信箱：会话或后台替某道题做完的事（提升质量、前置题、按反馈改题、
   陪学回复、定制题、讲解追问）都投递到这里。点一条直接跳回那道题；
   「全部已读」只清角标，不删记录。数据来自 snapshot.inbox，随轮询刷新。 */

const ago = (at) => {
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

const NO_ITEMS = [];

function MailboxIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="m4 7.5 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export default function Inbox({ inbox, busy, onOpen, onReadAll }) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef(null),
    list = React.useRef(null);
  const unread = inbox?.unread || 0,
    items = inbox?.items || NO_ITEMS;

  // Show at most three letters, scrolling the rest. Letters differ in height
  // (a detail line is optional and clamps at two), so measure the first three.
  React.useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    const rows = [...el.children];
    if (rows.length <= 3) {
      el.style.maxHeight = "";
      return;
    }
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    el.style.maxHeight = `${rows[3].offsetTop - el.offsetTop + pad}px`;
  }, [open, items]);

  React.useEffect(() => {
    if (!open) return;
    const outside = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    const escape = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        root.current?.querySelector(".inbox-toggle")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return (
    <div className="inbox" ref={root}>
      <button
        type="button"
        className={"inbox-toggle" + (unread ? " has-unread" : "")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread ? `信箱，${unread} 条未读` : "信箱"}
        title={unread ? `${unread} 条后台结果待查看` : "信箱"}
        onClick={() => setOpen((v) => !v)}
      >
        <MailboxIcon />
        {unread > 0 && <span className="inbox-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label="信箱">
          <div className="inbox-head">
            <strong>信箱</strong>
            <small className="muted">{unread ? `${unread} 条未读` : "都看过了"}</small>
            <button type="button" className="inbox-read-all" disabled={!unread || busy} onClick={onReadAll}>
              全部已读
            </button>
          </div>
          {items.length ? (
            <ul className="inbox-list" ref={list}>
              {items.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className={"inbox-item" + (m.read ? "" : " unread")}
                    disabled={busy || m.missing}
                    title={m.missing ? "这道题已经不在题库里了" : "跳到这道题"}
                    onClick={() => {
                      setOpen(false);
                      onOpen(m);
                    }}
                  >
                    <span className="inbox-item-top">
                      <span className={"inbox-kind k-" + m.kind}>{m.label}</span>
                      {m.count > 1 && <span className="inbox-count">×{m.count}</span>}
                      <small>{m.deckTitle}</small>
                      <small className="inbox-time">{ago(m.at)}</small>
                    </span>
                    <span className="inbox-prompt">{m.missing ? "（题目已删除）" : m.prompt}</span>
                    {m.detail && <span className="inbox-detail">{m.detail}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="inbox-empty muted">
              暂无消息。你去做下一题时，会话和后台做完的改题、前置题、陪学回复和讲解追问会投递到这里，点一下就能跳回那道题。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

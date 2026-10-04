import { ui, uiFormat, uiLocale } from "./i18n.js";
import { formatAgo } from "./format.js";
import React from "react";
import { Badge, Button, EmptyState, Icon, InlineMessage, ScrollWindow, useNow } from "./components/index.js";
import { useDismiss } from "./components/use-dismiss.js";
import { useInjectCss } from "./shared.js";
import { inboxMissingPrompt, inboxOpenHint, inboxTone, inboxTopics } from "../lib/inbox-kinds.js";
import css from "./inbox.css";

/* 顶栏信箱：会话或后台替学习者做完的事（改题、前置题、陪学回复、讲解追问、笔记草稿、
   音频转写、PDF 转换、译文、批改、原文补题）都投递到这里。点一条直接跳回那道题或那份
   结果；「全部已读」只清角标，不删记录。数据来自 snapshot.inbox，随轮询刷新。
   每种信件的名称、语气、点开提示都在 lib/inbox-kinds.js。 */

const NO_ITEMS = [];
const PANEL_ROWS = { "--sh-scroll-max": "min(360px, 55vh)" };

function EmptyMailbox() {
  const topics = new Intl.ListFormat(uiLocale(), { style: "long", type: "conjunction" }).format(inboxTopics().map((topic) => ui(topic)));
  return <EmptyState size="sm" icon="mail" className="mailbox__empty" title={ui("暂无消息")}
    description={uiFormat("{0}的结果会投递到这里，点一下就能跳回对应的地方。", [topics])} />;
}

function Letter({ m, busy, now, onOpen, onUndo, close }) {
  const tone = inboxTone(m.kind);
  return (
    <>
      <button
        type="button"
        className={"mailbox__item" + (m.read ? "" : " is-unread")}
        disabled={busy || m.missing}
        title={ui(inboxOpenHint(m.kind, { missing: m.missing }))}
        onClick={() => {
          close();
          onOpen(m);
        }}
      >
        <span className="mailbox__top">
          {!m.read && <span className="sh-visually-hidden">{ui("未读")}</span>}
          <Badge tone={tone} size="sm" icon={tone === "error" || tone === "warning"}>{ui(m.label)}</Badge>
          {m.count > 1 && <span className="mailbox__multi">×{m.count}</span>}
          <small className="mailbox__deck">{m.deckTitle}</small>
          <small className="mailbox__time">{formatAgo(m.at, now)}</small>
        </span>
        <span className="mailbox__prompt">{m.missing ? ui(inboxMissingPrompt(m.kind)) : m.prompt}</span>
        {m.detail && <span className="mailbox__detail">{m.detail}</span>}
      </button>
      {m.canRevert && onUndo && <Button variant="link" size="sm" className="mailbox__undo"
        disabled={busy} onClick={() => onUndo(m)}>{ui("回退这次改题")}</Button>}
    </>
  );
}

export default function Inbox({ inbox, busy, onOpen, onReadAll, onUndo, readError = "", defaultOpen = false }) {
  useInjectCss(css, "study-inbox");
  const [open, setOpen] = React.useState(defaultOpen);
  const root = React.useRef(null);
  const unread = inbox?.unread || 0,
    items = inbox?.items || NO_ITEMS;

  const toggle = React.useRef(null), panel = React.useRef(null), wasOpen = React.useRef(false);
  const now = useNow(30_000, { enabled: open });
  useDismiss({ open, onClose: () => setOpen(false), refs: root, returnFocusRef: toggle });
  // The panel is a dialog: focus goes into it on open and, unless the learner already went elsewhere, back to the toggle on close.
  React.useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const element = panel.current;
      (element?.querySelector("button:not(:disabled)") || element)?.focus({ preventScroll: true });
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const active = document.activeElement;
      if (!active || active === document.body) toggle.current?.focus({ preventScroll: true });
    }
  }, [open]);

  return (
    <div className="mailbox" ref={root}>
      <button
        ref={toggle}
        type="button"
        className={"mailbox__toggle" + (unread ? " has-unread" : "")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread ? uiFormat("信箱，{0} 条未读", [unread]) : ui("信箱")}
        title={unread ? uiFormat("{0} 条后台结果待查看", [unread]) : ui("信箱")}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="mail" size={18} />
        {unread > 0 && <span className="mailbox__count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="mailbox__panel" ref={panel} tabIndex={-1} role="dialog" aria-label={ui("信箱")}>
          <div className="mailbox__head">
            <strong>{ui("信箱")}</strong>
            <small className="mailbox__sub">{unread ? uiFormat("{0} 条未读", [unread]) : ui("都看过了")}</small>
            <Button variant="link" size="sm" className="mailbox__read-all" disabled={!unread} onClick={onReadAll}>{ui("全部已读")}</Button>
          </div>
          {readError && <InlineMessage tone="error" className="mailbox__error">{uiFormat("没能标为已读：{0}", [readError])}</InlineMessage>}
          {items.length ? (
            <ScrollWindow className="mailbox__scroll" label={ui("信箱消息")} items={items} itemKey={(m) => m.id}
              listClassName="mailbox__list" itemClassName="mailbox__row" style={PANEL_ROWS}
              renderItem={(m) => <Letter m={m} busy={busy} now={now} onOpen={onOpen} onUndo={onUndo} close={() => setOpen(false)} />} />
          ) : <EmptyMailbox />}
        </div>
      )}
    </div>
  );
}

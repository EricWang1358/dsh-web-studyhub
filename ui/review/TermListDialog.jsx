import { ui, uiFormat, uiMessage } from "../i18n.js";
import React from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  InlineMessage,
  LoadingState,
  Menu,
} from "../components/index.js";

const COURSE_TERMS_MAX_ITEMS = 200;

export const TERM_GROUPS = Object.freeze([
  { state: "unknown", label: "不认识", tone: "warning" },
  { state: "learned", label: "学过", tone: "info" },
  { state: "known", label: "会了", tone: "success" },
]);

export function groupCourseTerms(items = []) {
  const byState = { unknown: [], learned: [], known: [] };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || !item.term) continue;
    const key = Object.hasOwn(byState, item.state) ? item.state : "unknown";
    byState[key].push(item);
  }
  return TERM_GROUPS
    .map((group) => ({ ...group, items: byState[group.state] }))
    .filter((group) => group.items.length > 0);
}

/**
 * Per-course unfamiliar word list (`#1203`), grouped by mastery state (`unknown`, `learned`, `known`).
 * Each entry can be removed individually; clearing the entire list lives in the `⋯` menu behind a confirmation dialog.
 */
export default function TermListDialog({
  courseName = "",
  items = [],
  loading = false,
  error = "",
  onRemove,
  onClear,
  onClose,
  menuDefaultOpen = false,
  confirmClearDefaultOpen = false,
}) {
  const [removingKey, setRemovingKey] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [confirmClear, setConfirmClear] = React.useState(confirmClearDefaultOpen);

  const list = Array.isArray(items) ? items : [];
  const groups = React.useMemo(() => groupCourseTerms(Array.isArray(items) ? items : []), [items]);
  const hasItems = list.length > 0;
  const displayError = actionError || error;

  const handleRemove = async (term) => {
    if (removingKey || !onRemove) return;
    setActionError("");
    setRemovingKey(term.toLowerCase());
    try {
      await onRemove(term);
    } catch (failure) {
      setActionError(uiMessage(failure?.message) || ui("移除失败，请再试一次。"));
    } finally {
      setRemovingKey("");
    }
  };

  const title = courseName ? uiFormat("{0} · 生词表", [courseName]) : ui("生词表");

  return (
    <>
      <Dialog
        size="md"
        title={title}
        description={ui("按课程记住标过的词，状态会随检查题掌握度自动更新。")}
        onClose={onClose}
        busy={!!removingKey}
        footer={<Button variant="quiet" onClick={() => onClose?.("button")}>{ui("关闭")}</Button>}
      >
        <div className="term-list-dialog">
          <div className="term-list-head">
            <span className="term-list-head__count">
              {list.length >= Math.floor(COURSE_TERMS_MAX_ITEMS * 0.8)
                ? uiFormat("共 {0} / {1} 个词", [list.length, COURSE_TERMS_MAX_ITEMS])
                : uiFormat("共 {0} 个词", [list.length])}
            </span>
            <Menu
              label={ui("更多操作")}
              defaultOpen={menuDefaultOpen}
              items={[
                {
                  id: "clear",
                  label: ui("清空生词表"),
                  danger: true,
                  disabled: !hasItems || !!removingKey,
                },
              ]}
              onSelect={(id) => {
                if (id === "clear") setConfirmClear(true);
              }}
            />
          </div>
          {displayError && <InlineMessage tone="error">{displayError}</InlineMessage>}
          {loading && !hasItems ? (
            <div className="term-list-loading">
              <LoadingState label={ui("正在读取生词表…")} />
            </div>
          ) : !hasItems ? (
            <EmptyState
              icon="book"
              title={ui("还没有标过生词")}
              body={ui("做题或看答案时点「标生词」，标过的词会按课程记在这里。")}
            />
          ) : (
            <div className="term-list-groups">
              {groups.map((group) => (
                <section key={group.state} className="term-list-group" aria-label={ui(group.label)}>
                  <h4 className="term-list-group__title">
                    <span>{ui(group.label)}</span>
                    <span className="term-list-group__count">{group.items.length}</span>
                  </h4>
                  <ul className="term-list-items">
                    {group.items.map((item) => {
                      const key = item.term.toLowerCase();
                      const busy = removingKey === key;
                      return (
                        <li key={key} className="term-list-row">
                          <div className="term-list-row__main">
                            <div className="term-list-row__head">
                              <span className="term-list-row__term">{item.term}</span>
                              {item.alt && <span className="term-list-row__alt">{item.alt}</span>}
                              <Badge tone={group.tone} size="sm">{ui(group.label)}</Badge>
                            </div>
                            {item.fromPrompt && (
                              <p className="term-list-row__prompt">
                                {uiFormat("出自：{0}", [item.fromPrompt])}
                              </p>
                            )}
                          </div>
                          <IconButton
                            icon="close"
                            size="sm"
                            label={uiFormat("从生词表移除「{0}」", [item.term])}
                            disabled={!!removingKey}
                            busy={busy}
                            onClick={() => handleRemove(item.term)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </Dialog>
      {confirmClear && (
        <ConfirmDialog
          title={ui("清空这门课的生词表？")}
          description={ui("会移除这门课记录的所有生词；题组里已生成的检查题和作答记录会保留。")}
          confirmLabel={ui("清空生词表")}
          tone="danger"
          onConfirm={async () => {
            await onClear?.();
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </>
  );
}

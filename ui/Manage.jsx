import { ui, uiFormat } from "./i18n.js";
import React, { useContext, useState } from "react";
import Markdown from "./Markdown.jsx";
import { kinds, useInjectCss } from "./shared.js";
import css from "./manage.css";
import { useStudy } from "./study-context.jsx";
import { AppContext, useOptionalAppSelector } from "./app/app-context.js";
import PaceMeta from "./pace/PaceMeta.jsx";
import { cardMatchesReview, reviewedCardStatus } from "../lib/review-integrity.js";
import { aiDraftedCitedCardCount, selfCitedCardCount } from "../lib/source-provenance.js";
import { Badge, Banner, Button, CheckboxInput, Combobox, ConfirmDialog, InlineConfirm, PageHeader, Panel, SegmentedControl, Tooltip, useToast } from "./components/index.js";
import { suggestDeckOrder } from "./deck-order-suggest.js";
import { partOf, partsOf } from "../lib/deck-parts.js";
import { partLabel, partsLine } from "./deck-parts.js";
import { formatDateTime } from './format.js';
import { deckChoices, deckEntries } from './deck-picker-entries.js';
import { offerDeckArchived } from './archive-entries.js';
import { companionSlideButtonLabel, openCompanionTarget, resolveCompanionTarget } from './companions/companion-ref.js';
import CourseField from './CourseField.jsx';
import { deckCourseOf } from './deck-course.js';

/** Pure filter for deck question rows by keyword and card status (flagged / suspended). */
export function filterManageCards(cards = [], { query = "", filter = "all" } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  return cards.filter((card) => {
    if (filter === "flagged" && !card.flag) return false;
    if (filter === "suspended" && !card.suspended) return false;
    if (!needle) return true;
    const haystack = [card.prompt, card.topic, card.answer, card.flag].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

/** The question before a merge removes the source deck: an in-app confirmation (host webviews may block the browser's own). */
export function MergeDeckDialog({ deck, target, onConfirm, onClose }) {
  return <ConfirmDialog title={uiFormat("合并到「{0}」？", [target.title])} confirmLabel={ui("合并到目标题组")}
    description={uiFormat("将「{0}」的 {1} 道题全部并入目标题组？来源题组会移除。", [deck.title, deck.cards.length])}
    onConfirm={onConfirm} onClose={onClose} />;
}

/* 题组管理视图：编辑先进入草稿（deck.edit → openDraft），归档/暂停/标记
   与目录移动就地生效。managedDeck 由 App 在进入本视图时 deck.get 取得。 */
export default function Manage({
  openDraft,
  setPage,
  managedDeck,
  decks = [],
  focus,
  sources,
  setManagedDeck,
  folderDraft,
  setFolderDraft,
  onRemoveDeck,
  runs = [],
  paceForecast: propPaceForecast,
}) {
  useInjectCss(css, "study-manage");
  const { call, busy, act, openModal } = useStudy();
  const appCtx = useContext(AppContext);
  const storePaceForecast = useOptionalAppSelector((state) => state.data?.paceForecast);
  const paceForecast = propPaceForecast ?? storePaceForecast ?? appCtx?.data?.paceForecast;
  const refreshLibrary = appCtx?.core?.refresh;
  const courses = appCtx?.data?.courses;
  const toast = useToast();
  const [targetId, setTargetId] = useState("");
  const [merging, setMerging] = useState(false);
  const [confirmRecommend, setConfirmRecommend] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [splitTitle, setSplitTitle] = useState("");
  const [splitTopics, setSplitTopics] = useState([]);
  const [query, setQuery] = useState("");
  const [cardFilter, setCardFilter] = useState("all");
  // The parts of the deck (lib/deck-parts.js): 「第一部分 12 题 · 第二部分 9 题」 and one part at a time on screen. Practice and mastery read the whole deck.
  const parts = partsOf(managedDeck), [shownPart, setShownPart] = useState(0);
  const showing = parts.length > 1 && parts.some((part) => part.n === shownPart) ? shownPart : 0;
  const shownCards = showing ? managedDeck.cards.filter((card) => partOf(card) === showing) : managedDeck.cards;
  const flaggedCount = shownCards.filter((card) => Boolean(card.flag)).length;
  const suspendedCount = shownCards.filter((card) => Boolean(card.suspended)).length;
  const filteredCards = filterManageCards(shownCards, { query, filter: cardFilter });
  const hasFilterPills = flaggedCount > 0 || suspendedCount > 0 || cardFilter !== "all";
  const topics = [...new Set(managedDeck.cards.map((c) => c.topic || ui("未分类")))];
  const peers = decks.filter((d) => d.id !== managedDeck.id && !d.systemKind && !d.archived);
  const deckIndex = decks.findIndex((d) => d.id === managedDeck.id);
  const siblings = decks.filter((d) => !d.systemKind && !d.archived && deckCourseOf(d) === deckCourseOf(managedDeck));
  const siblingIndex = siblings.findIndex((d) => d.id === managedDeck.id);
  const moveOrder = (delta) => {
    const ids = decks.map((d) => d.id);
    const other = decks.findIndex((d) => d.id === siblings[siblingIndex + delta]?.id);
    [ids[deckIndex], ids[other]] = [ids[other], ids[deckIndex]];
    act("deck.reorder", { ids }, () => toast.success(ui("题组顺序已保存")));
  };
  const recommendedOrder = siblings.length > 1 ? suggestDeckOrder(siblings) : null;
  const applyRecommendedOrder = async () => {
    if (!recommendedOrder?.changed || reordering) { setConfirmRecommend(false); return; }
    const siblingIds = new Set(siblings.map((d) => d.id));
    let cursor = 0;
    const ids = decks.map((d) => (siblingIds.has(d.id) ? recommendedOrder.ids[cursor++] : d.id));
    setReordering(true);
    try {
      await act("deck.reorder", { ids }, () => {
        setConfirmRecommend(false);
        toast.success(ui("已按推荐顺序保存题组排序"));
      });
    } finally {
      setReordering(false);
    }
  };
  const unreviewed = reviewedCardStatus(managedDeck)?.changed ?? managedDeck.editorial?.uncheckedAtPublish ?? 0;
  const selfCited = selfCitedCardCount(managedDeck.cards, sources);
  const marks = managedDeck.editorial?.reviewedCards;
  const slainView = managedDeck.systemKind === "slain";
  const splitReady = !!splitTitle.trim() && splitTopics.length > 0 && splitTopics.length < topics.length;
  /* 归档题组并结束练习: the host also ends the open practice runs on the deck (study/operations.js deck.archive); the notice says how many, offers 撤销 (the deck
     comes back; an ended run stays ended) and the second step of archive-first, 永久删除…, which opens the same dialog as the button on this page. */
  const reload = (id) => async () => setManagedDeck(await call("deck.get", { id }));
  async function archiveDeck() {
    const deck = managedDeck, archiving = !deck.archived;
    const done = await act("deck.archive", { id: deck.id, archived: archiving }, reload(deck.id));
    if (!done || !archiving) return;
    // The words and the two buttons are the deck row menu's too (ui/archive-entries.js): the host counts what it ended, the notice names it.
    offerDeckArchived({ toast, deck, done, runs,
      // A plain call (not the single-flight act(): 撤销 stays usable while another write runs, and must not be dropped by it), then the page and the library read again.
      restore: async () => { await call("deck.archive", { id: deck.id, archived: false }); await reload(deck.id)(); Promise.resolve(refreshLibrary?.()).catch(() => {}); return true; },
      // The keyboard focus after 撤销 is this page's archive button again; after 永久删除… is closed it comes back to it too (ui/app/AppModalHost.jsx).
      focus: () => document.querySelector(".manage-page [data-manage-archive]"), onRemove: onRemoveDeck, returnFocus: ".manage-page [data-manage-archive]" });
  }
  return (
    <section className="page manage-page">
      <PageHeader className="manage-head" back={{ label: ui("返回学习库"), onClick: () => setPage("library") }} title={managedDeck.title}
        description={slainView ? ui("本工作区唯一的斩题组。这里的题不参与复习，作答历史和复习进度保留，可恢复到原题组。")
          : ui("编辑先进入草稿；重新发布时，未改动题目保留复习进度，内容变更的题目重新开始调度。历史作答始终保留。")}
        actions={<>
          <Button variant="primary" disabled={slainView} lock={busy} onClick={() => act("deck.edit", { id: managedDeck.id }, openDraft)}>{ui("编辑题组")}</Button>
          <Button data-manage-archive disabled={slainView} lock={busy} onClick={archiveDeck}>
            {managedDeck.archived ? ui("恢复题组") : ui("归档题组并结束练习")}
          </Button>
          {managedDeck.archived && !managedDeck.systemKind && <Button variant="danger" lock={busy}
            onClick={() => onRemoveDeck(managedDeck.id)}>{ui("永久删除")}</Button>}
        </>}>
        <div className="manage-meta">
          <Badge size="sm">{uiFormat("{0} 题", [managedDeck.cards.length])}</Badge>
          {managedDeck.archived && <Badge size="sm" tone="warning">{ui("已归档")}</Badge>}
          {parts.length > 1 && <span className="manage-parts" data-deck-parts>{partsLine(parts)}</span>}
        </div>
        {!slainView && !managedDeck.archived && paceForecast?.decks?.[managedDeck.id] && (
          <PaceMeta variant="deck" forecast={paceForecast.decks[managedDeck.id]} pace={paceForecast.pace} asOf={paceForecast.asOf} />
        )}
        {managedDeck.originalTitle && managedDeck.originalTitle !== managedDeck.title &&
          <p className="muted">{ui("导入原标题：")}{managedDeck.originalTitle}</p>}
      </PageHeader>
      {!slainView && (unreviewed > 0 || selfCited > 0) && (
        <Banner tone="warning" role="status">
          {unreviewed > 0 && <p>{uiFormat("{0} 题尚未自动审阅。学习时可正常作答，发现问题可点题目标记或「这题有问题」交给后台修题。", [unreviewed])}</p>}
          {selfCited > 0 && <p>{uiFormat("{0} 题只引用导入题目自身；请先在草稿中换成原始资料引用。", [selfCited])}</p>}
        </Banner>
      )}
      {!managedDeck.systemKind && <details className="manage-organize-fold">
        <summary className="manage-organize-fold__summary">
          <span className="manage-organize-fold__title">{ui("整理题组")}</span>
          <span className="manage-organize-fold__hint">
            {managedDeck.archived ? ui("课程归属") : ui("课程归属、排序、合并与拆分")}
          </span>
        </summary>
        <div className="manage-organize-fold__body">
          <form
            className="manage-folder"
            onSubmit={(e) => {
              e.preventDefault();
              act(
                "deck.course",
                { id: managedDeck.id, course: folderDraft.trim() },
                (moved) => {
                  setManagedDeck({ ...managedDeck, course: moved.course, folder: "" });
                  setFolderDraft(moved.course);
                  toast.success(moved.course ? uiFormat("已归入课程「{0}」", [moved.course]) : ui("已移回未分类"));
                },
              );
            }}
          >
            <CourseField
              courses={focus?.courses || courses || []}
              value={folderDraft}
              onChange={setFolderDraft}
              label={ui("所属课程")}
              current={deckCourseOf(managedDeck)}
              disabled={busy}
            />
            <div className="manage-folder__actions">
              <Button className="manage-row__action" disabled={folderDraft.trim() === deckCourseOf(managedDeck).trim()} lock={busy} type="submit">{ui("保存课程")}</Button>
            </div>
          </form>
          {!managedDeck.archived && <Panel className="manage-panel"
            description={ui("合并保留全部题目；拆分按主题移动。题目复习记录和前置题关联会一起保留。")}>
            {siblings.length > 1 && <div className="manage-section">
              <span className="manage-label">{ui("题组顺序")}</span>
              <p className="muted small">{uiFormat("当前在课程学习顺序中第 {0} / {1} 个（用于课程进度与推荐下一步；学习库目录按最近发布排序）。", [siblingIndex + 1, siblings.length])}</p>
              <div className="manage-row manage-row--pair">
                <Button className="manage-row__action" disabled={siblingIndex <= 0} lock={busy} onClick={() => moveOrder(-1)}>{ui("上移题组")}</Button>
                <Button className="manage-row__action" disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1} lock={busy} onClick={() => moveOrder(1)}>{ui("下移题组")}</Button>
                <Tooltip layer content={ui("按「前置筑基 → 章节精讲 → 源码实验 → 综合大卷」给出建议顺序；仅在你确认后才写入，不会自动改写已排好的顺序。")}>
                  <Button className="manage-row__action" variant="quiet" disabled={!recommendedOrder?.changed} lock={busy} onClick={() => setConfirmRecommend(true)}>
                    {recommendedOrder?.changed ? ui("按推荐顺序排…") : ui("已符合推荐顺序")}
                  </Button>
                </Tooltip>
              </div>
              {confirmRecommend && recommendedOrder?.changed && (
                <InlineConfirm tone="primary" title={ui("按推荐学习顺序重排当前课程的题组？")} confirmLabel={ui("确认应用推荐顺序")} busy={reordering}
                  onConfirm={applyRecommendedOrder} onCancel={() => setConfirmRecommend(false)}>
                  <p className="muted small">{ui("仅调整当前课程题组的顺序，不改动任何题目或复习记录；取消后保持原顺序不变。")}</p>
                  <ol className="manage-recommend-list">
                    {recommendedOrder.items.map((item) => <li key={item.id}>{item.title}</li>)}
                  </ol>
                </InlineConfirm>
              )}
            </div>}
            <form className="manage-section" onSubmit={(e) => {
              e.preventDefault();
              if (targetId) setMerging(true);
            }}>
              <label className="manage-label" htmlFor="manage-merge-target">{ui("合并到题组")}</label>
              <div className="manage-row">
                <Combobox id="manage-merge-target" className="manage-row__control" value={targetId} onChange={setTargetId} placeholder={ui("选择合并目标")} label={ui("合并到题组")} searchPlaceholder={ui("搜索题组")}
                  emptyText={(query) => uiFormat("没有叫「{0}」的题组", [query])}
                  options={deckEntries(deckChoices(peers, { focus }))} />
                <Button className="manage-row__action" disabled={!targetId} lock={busy} type="submit">{ui("合并到目标题组")}</Button>
              </div>
            </form>
            {topics.length > 1 && <form className="manage-section" onSubmit={(e) => {
              e.preventDefault();
              if (!splitReady) return;
              act("deck.split", { id: managedDeck.id, title: splitTitle, topics: splitTopics }, async (result) => {
                setManagedDeck(await call("deck.get", { id: managedDeck.id }));
                setSplitTopics([]); setSplitTitle("");
                toast.success(uiFormat("已拆出 {0} 道题到新题组",[result.moved]));
              });
            }}>
              <span className="manage-label">
                {ui("按主题拆分")}
                <small>{uiFormat("已选 {0} / {1} 个主题", [splitTopics.length, topics.length])}</small>
              </span>
              <div className="manage-topics">{topics.map((topic) => <label key={topic} className="manage-topic">
                <CheckboxInput className="manage-topic__check" checked={splitTopics.includes(topic)} onChange={(e) => setSplitTopics((old) => e.target.checked ? [...old, topic] : old.filter((x) => x !== topic))} />
                <span>{topic}</span>
              </label>)}</div>
              <div className="manage-row">
                <input className="manage-row__control" aria-label={ui("新题组名称")} value={splitTitle} onChange={(e) => setSplitTitle(e.target.value)} placeholder={ui("新题组名称")} />
                <Button className="manage-row__action" disabled={!splitReady} lock={busy} type="submit">{ui("拆出所选主题")}</Button>
              </div>
            </form>}
          </Panel>}
        </div>
      </details>}
      {merging && targetId && <MergeDeckDialog deck={managedDeck} target={peers.find((d) => d.id === targetId) || { title: "" }}
        onClose={() => setMerging(false)} onConfirm={async () => {
          const result = await act("deck.merge", { sourceIds: [managedDeck.id], targetId }, (moved) => {
            setPage("library"); toast.success(uiFormat("已合并 {0} 道题，全部保留", [moved.moved]));
          }, { rethrow: true });
          if (result === undefined) throw new Error(ui("上一个操作还没结束，这次点击没有生效。等它结束后再点一次。"));
        }} />}
      {!managedDeck.cards.length && <p className="muted">{slainView ? ui("斩题组为空。练习时点击“斩”，题目会收纳到这里。") : ui("当前题组没有题目。已斩的题可从斩题组恢复。")}</p>}
      {parts.length > 1 && <SegmentedControl size="sm" className="manage-part-filter" label={ui("按部分查看")} value={showing} onChange={setShownPart} data-part-filter
        options={[{ value: 0, label: ui("全部") }, ...parts.map((part) => ({ value: part.n, label: partLabel(part.n) }))]} />}
      {managedDeck.cards.length > 0 && <div className="manage-filter-bar" data-manage-filter>
        <input type="search" className="manage-search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={ui("搜索题目或主题")} aria-label={ui("搜索题目")} />
        {hasFilterPills && <SegmentedControl size="sm" className="manage-status-filter" label={ui("筛选题目")} value={cardFilter} onChange={setCardFilter}
          options={[
            { value: "all", label: ui("全部") },
            { value: "flagged", label: flaggedCount > 0 ? uiFormat("已标记 ({0})", [flaggedCount]) : ui("已标记") },
            { value: "suspended", label: suspendedCount > 0 ? uiFormat("已暂停 ({0})", [suspendedCount]) : ui("已暂停") },
          ]} />}
      </div>}
      {shownCards.length > 0 && !filteredCards.length && <div className="manage-filter-empty">
        <p className="muted">{ui("当前筛选下没有匹配的题目。")}</p>
        <Button size="sm" variant="link" onClick={() => { setQuery(""); setCardFilter("all"); }}>{ui("清除筛选")}</Button>
      </div>}
      <div className="manage-cards">
        {filteredCards.map((card) => {
          const companionTarget = resolveCompanionTarget({
            card,
            courses,
            sources,
            fallbackCourse: managedDeck.course || managedDeck.folder || "",
          });
          return (
          <Panel as="article" density="compact" className={`manage-card${card.suspended ? " is-suspended" : ""}`} key={card.id}>
            <div className="manage-card__body">
              <div className="manage-card__meta">
                <Badge size="sm">{card.topic || ui("未分类")}</Badge>
                <span>{kinds[card.kind] || card.kind}</span>
                {card.suspended && <Badge size="sm" tone="warning">{ui("已暂停")}</Badge>}
                {marks && !cardMatchesReview(marks[card.id], card) && <Badge size="sm" tone="warning">{ui("未自动审阅")}</Badge>}
                {selfCitedCardCount([card], sources) > 0 && <Badge size="sm" tone="warning">{ui("仅有导入题目引用")}</Badge>}
                {aiDraftedCitedCardCount([card], sources) > 0 && <Badge size="sm" tone="warning">{ui("AI 撰写 · 未核对")}</Badge>}
              </div>
              <Markdown className="md-title manage-card__prompt" text={card.prompt} />
              {card.flag && <p className="muted">{ui("标记：")}{card.flag}</p>}
              {card.slain && <p className="muted">{ui("原题组：")}{card.slain.deckTitle} · {formatDateTime(card.slain.at, 'date')}</p>}
            </div>
            <div className="manage-card__actions">
              {companionTarget && openModal && (
                <Button size="sm" variant="quiet" iconEnd="arrow-right" className="manage-card__action" onClick={() => openCompanionTarget(openModal, companionTarget)}>
                  {companionSlideButtonLabel(companionTarget)}
                </Button>
              )}
              <Button className="manage-card__action" lock={busy} onClick={() => act(
                slainView ? "card.restore" : "card.slay",
                { deckId: managedDeck.id, cardId: card.id },
                async (result) => {
                  setManagedDeck(await call("deck.get", { id: managedDeck.id }));
                  toast.success(slainView ? uiFormat("已恢复到「{0}」",[result.title]) : ui("已移入斩题组，不再参与复习，可在斩题组恢复。"));
                },
              )}>{slainView ? ui("恢复原题组") : ui("斩")}</Button>
              <Button
                className="manage-card__action"
                disabled={slainView} lock={busy}
                onClick={() =>
                  act(
                    "card.suspend",
                    {
                      deckId: managedDeck.id,
                      cardId: card.id,
                      suspended: !card.suspended,
                    },
                    async () =>
                      setManagedDeck(
                        await call("deck.get", { id: managedDeck.id }),
                      ),
                  )
                }
              >
                {card.suspended ? ui("恢复学习") : ui("暂停此题")}
              </Button>
              {card.flag && (
                <Button
                  className="manage-card__action"
                  lock={busy}
                  onClick={() =>
                    act(
                      "card.flag",
                      {
                        deckId: managedDeck.id,
                        cardId: card.id,
                        reason: "",
                      },
                      async () =>
                        setManagedDeck(
                          await call("deck.get", {
                            id: managedDeck.id,
                          }),
                        ),
                    )
                  }
                >{ui("清除标记")}</Button>
              )}
            </div>
          </Panel>
          );
        })}
      </div>
    </section>
  );
}

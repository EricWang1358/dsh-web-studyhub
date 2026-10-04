import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { DisclosureToggle, foldLabel } from '../components/index.js';
import { courseRelative } from '../../lib/course-tree.js';
import { courseNamesOf } from '../PageScope.jsx';
import { ParkedChip } from '../CourseActive.jsx';
import DeckRow from './DeckRow.jsx';
import MasteryBar from './MasteryBar.jsx';
import { mergeProgress, topicKey } from './map-model.js';

/**
 * The catalogue as a tree: a row per course (the current one first) with its
 * decks under it, a deck per row with its topics. `folders` is the grouping
 * from useCourseFolders; `tree` is useDeckTree's folds and selection.
 */
export default function DeckTree({ data, folders, tree, query, showArchived, singleCourse, inFocus, parkedByName, progress, runFor, busy, actions }) {
  const [showAll, setShowAll] = useState(false);
  const isOpen = (id) => !!query || tree.expanded.has(id);
  const deckRow = (deck) => <DeckRow key={deck.id} deck={deck} progress={progress[deck.id]} open={isOpen(deck.id)} tree={tree} runFor={runFor} busy={busy} actions={actions} />;
  return (
    <ul className={`map-tree${singleCourse ? ' single-course' : ''}`}>
      {folders.map(([folder, decks]) => {
        if (!folder) return decks.map(deckRow);
        // The arrow alone opens and closes a course. When the course is the
        // only one on screen its header is hidden, so it is always open.
        const id = `folder:${folder}`, open = singleCourse || isOpen(id);
        const truncated = inFocus(folder) && !query && !showArchived && decks.length > 3;
        const shown = truncated && !showAll ? decks.slice(0, 3) : decks;
        const parked = parkedByName.get(folder);
        const name = courseRelative(folder, data.focus?.course, courseNamesOf(data)) ?? folder;
        return (
          <li key={id} className={`map-folder${parked ? ' is-parked-row' : ''}`}>
            <div className="map-row folder-row">
              <DisclosureToggle className="map-fold" open={open} label={foldLabel(open, name)} onToggle={() => tree.toggleOpen(id)} />
              {!showArchived && <input type="checkbox" aria-label={uiFormat('选择目录 {0}', [folder])}
                checked={decks.every((deck) => tree.selected.has(topicKey(deck.id)))}
                onChange={(event) => tree.toggleSelect(decks.filter((deck) => !deck.archived).map((deck) => topicKey(deck.id)), event.target.checked)} />}
              <button className="map-name" onClick={() => tree.toggleOpen(id)}>
                <strong title={folder}>{name}</strong>
                <small>{decks.length}{ui(' 个题组')}</small>
              </button>
              {parked && <ParkedChip course={parked} />}
              {!showArchived && <MasteryBar node={mergeProgress(decks.map((deck) => progress[deck.id]).filter(Boolean))} />}
            </div>
            {open && (
              <ul className="map-children">
                {shown.map(deckRow)}
                {truncated && (
                  <li className="map-more">
                    <button className="show-other-courses" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
                      {showAll ? ui('收起，只看最近 3 个题组') : uiFormat('查看全部题组 · {0}', [decks.length])}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

import React, { memo } from 'react';
import { ui } from '../i18n.js';
import { Badge, Button } from '../components/index.js';

/* The review book's live 目录: every heading of the stitched book (lib/course-book-links.js bookIndex), indented by level, the one the learner is reading
   marked 你在这里. A click opens its chapter and goes to the heading. */

/** entries: [{ id, level, title }] (the book's own title left out); here: the heading id being read; onGo(id). */
export default memo(function BookToc({ entries, here, onGo }) {
  return (
    <ol className="book-toc__list">
      {entries.map(entry => (
        <li key={entry.id} className="book-toc__item" data-level={Math.min(4, entry.level)}>
          <Button variant="quiet" size="sm" wrap className="book-toc__go" aria-current={entry.id === here ? 'location' : undefined} onClick={() => onGo(entry.id)}>
            {entry.title}
          </Button>
          {entry.id === here && <Badge size="sm" tone="info" className="book-toc__here">{ui('你在这里')}</Badge>}
        </li>
      ))}
    </ol>
  );
});

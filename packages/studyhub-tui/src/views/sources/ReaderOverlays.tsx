import React, { Suspense, lazy } from 'react';
import type { HostClient } from '../../types/contracts.js';
import type { PageProjection, ReaderSubMode } from './reader-model.js';

const ReaderOutlineDrawer = lazy(() =>
  import('./ReaderOutlineDrawer.js').then((m) => ({ default: m.ReaderOutlineDrawer })),
);
const ReaderNotesDrawer = lazy(() =>
  import('./ReaderNotesDrawer.js').then((m) => ({ default: m.ReaderNotesDrawer })),
);
const MarkPassageModal = lazy(() =>
  import('./MarkPassageModal.js').then((m) => ({ default: m.MarkPassageModal })),
);
const TranslationGlossaryModal = lazy(() =>
  import('./TranslationGlossaryModal.js').then((m) => ({ default: m.TranslationGlossaryModal })),
);

export interface ReaderOverlaysProps {
  host: HostClient;
  subMode: ReaderSubMode;
  pageData: PageProjection | null;
  documentId?: string;
  sourceId?: string;
  initialTitle: string;
  currentPage: number;
  readChapterIds: Set<string>;
  width: number;
  height: number;
  isActive: boolean;
  onToggleRead: (
    chapter: { id: string; title: string; startPage: number; endPage: number },
    allChapters?: Array<{ id: string; title: string; startPage: number; endPage: number }>,
  ) => void;
  onOutlineSaved: () => void;
  onJumpPage: (page: number) => void;
  onCloseOverlay: () => void;
}

export function ReaderOverlays({
  host,
  subMode,
  pageData,
  documentId,
  sourceId,
  initialTitle,
  currentPage,
  readChapterIds,
  width,
  height,
  isActive,
  onToggleRead,
  onOutlineSaved,
  onJumpPage,
  onCloseOverlay,
}: ReaderOverlaysProps): React.ReactElement {
  const resolvedDocId = pageData?.documentId || documentId;
  const resolvedSrcId = pageData?.sourceId || sourceId;
  const resolvedTitle = pageData?.title || initialTitle;
  const activePage = pageData?.page ?? currentPage;

  return (
    <Suspense fallback={null}>
      {subMode === 'outline' ? (
        <ReaderOutlineDrawer
          host={host}
          documentId={resolvedDocId}
          sourceId={resolvedSrcId}
          revision={pageData?.revision}
          title={resolvedTitle}
          currentPage={activePage}
          currentPageText={pageData?.text}
          readChapterIds={readChapterIds}
          onToggleRead={onToggleRead}
          onOutlineSaved={onOutlineSaved}
          width={width}
          height={height}
          isActive={isActive}
          onJumpPage={onJumpPage}
          onClose={onCloseOverlay}
        />
      ) : null}

      {subMode === 'notes' ? (
        <ReaderNotesDrawer
          host={host}
          documentId={resolvedDocId}
          sourceId={resolvedSrcId}
          revision={pageData?.revision}
          title={resolvedTitle}
          currentPage={activePage}
          width={width}
          height={height}
          isActive={isActive}
          onJumpPage={onJumpPage}
          onClose={onCloseOverlay}
        />
      ) : null}

      {subMode === 'mark' ? (
        <MarkPassageModal
          host={host}
          documentId={resolvedDocId}
          sourceId={resolvedSrcId}
          revision={pageData?.revision}
          title={resolvedTitle}
          currentPage={activePage}
          pageText={pageData?.text ?? ''}
          isActive={isActive}
          onClose={onCloseOverlay}
        />
      ) : null}

      {subMode === 'glossary' ? (
        <TranslationGlossaryModal
          host={host}
          documentId={resolvedDocId}
          sourceId={resolvedSrcId}
          revision={pageData?.revision}
          title={resolvedTitle}
          pageText={pageData?.text ?? ''}
          isActive={isActive}
          onClose={onCloseOverlay}
        />
      ) : null}
    </Suspense>
  );
}

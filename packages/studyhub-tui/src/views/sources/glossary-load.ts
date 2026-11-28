/**
 * Loading what the translation glossary dialog shows (#1419).
 *
 * The reader hands the dialog `revision` (for some sources `documentId` too) only when its page has arrived, so a dialog opened before
 * that is asked to load the same document again while it is open. Such a load is quiet: it covers nothing, so a half-typed term stays
 * where it is, and its failure is a notice. Only the newest load's answer is used.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostClient, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';

export interface GlossaryEntry {
  term: string;
  to: string;
}

export interface SavedTranslationItem {
  key: string;
  kind?: 'paragraph' | 'selection' | string;
  sourceId: string;
  start: number;
  end: number;
  ordinal?: number;
  hash: string;
  quote: string;
  target: 'zh' | 'en' | string;
  text: string;
  version?: number;
  outdated?: boolean;
  at?: string;
  updatedAt?: string;
}

export interface StaleRevisionGroup {
  revision: string;
  count: number;
  savedAt?: string;
}

interface GlossaryGetResponse {
  documentId?: string;
  target?: 'zh' | 'en';
  targetSource?: string;
  glossary?: GlossaryEntry[];
}

export interface TranslationListResponse {
  documentId?: string;
  revision?: string;
  target?: 'zh' | 'en';
  targetSource?: string;
  glossary?: GlossaryEntry[];
  items?: SavedTranslationItem[];
  stale?: StaleRevisionGroup[];
  otherTarget?: number;
  modelAvailable?: boolean;
}

export interface GlossaryData {
  target: 'zh' | 'en';
  glossary: GlossaryEntry[];
  saved: SavedTranslationItem[];
  stale: StaleRevisionGroup[];
  otherTarget: number;
  modelAvailable: boolean;
}

type GlossaryAnswer = { ok: true; data: GlossaryData } | { ok: false; reason: string };

const isTarget = (value: unknown): value is 'zh' | 'en' => value === 'zh' || value === 'en';

/** The glossary and the saved translations of one document. One of the two reads is enough: each carries the glossary. */
async function readGlossary(
  host: HostClient,
  identity: Record<string, string>,
  lang: UiLanguage,
  explicitTarget?: 'zh' | 'en',
): Promise<GlossaryAnswer> {
  const [glossaryRes, listRes] = await Promise.all([
    tryAction<GlossaryGetResponse>(host, 'materials.translation.glossary.get', identity),
    tryAction<TranslationListResponse>(host, 'materials.translation.list', {
      ...identity,
      ...(explicitTarget ? { target: explicitTarget } : {}),
    }),
  ]);
  if (!glossaryRes.ok && !listRes.ok) {
    const reason =
      glossaryRes.error?.message ||
      listRes.error?.message ||
      t(lang, '无法加载术语表与译文', 'Failed to load glossary and saved translations');
    return { ok: false, reason };
  }
  const stored = [glossaryRes.value?.target, listRes.value?.target].find(isTarget);
  const glossary = [glossaryRes.value?.glossary, listRes.value?.glossary].find((list) => Array.isArray(list)) ?? [];
  return {
    ok: true,
    data: {
      target: explicitTarget ?? stored ?? (lang === 'en' ? 'en' : 'zh'),
      glossary,
      saved: Array.isArray(listRes.value?.items) ? listRes.value.items : [],
      stale: Array.isArray(listRes.value?.stale) ? listRes.value.stale : [],
      otherTarget: Number(listRes.value?.otherTarget ?? 0) || 0,
      modelAvailable:
        typeof listRes.value?.modelAvailable === 'boolean'
          ? listRes.value.modelAvailable
          : Boolean(host.getConfig()?.effective?.ready || useTuiStore.getState().snapshot?.modelReady),
    },
  };
}

export function useGlossaryLoad({
  host,
  documentId,
  sourceId,
  identity,
  lang,
  onData,
}: {
  host: HostClient;
  documentId?: string;
  sourceId?: string;
  /** The identity fields sent with every read. A new object loads again. */
  identity: Record<string, string>;
  lang: UiLanguage;
  onData: (data: GlossaryData) => void;
}) {
  const notify = useTuiStore((s) => s.notify);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  /** Which document a load has put on screen. */
  const shownRef = useRef<{ documentId?: string; sourceId?: string } | null>(null);
  /** Loads are numbered, and only the newest one's answer is used. */
  const seqRef = useRef(0);
  /** The number of the load still on its way, else null. */
  const pendingRef = useRef<number | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (explicitTarget?: 'zh' | 'en', { quiet = false }: { quiet?: boolean } = {}) => {
      if (!documentId && !sourceId) {
        setLoading(false);
        setLoadError(t(lang, '缺少文档标识，无法加载术语表与译文', 'Missing document identifier'));
        return;
      }
      const seq = ++seqRef.current;
      pendingRef.current = seq;
      const superseded = () => !mountedRef.current || seqRef.current !== seq;
      const fail = (reason: string) => {
        if (!quiet) setLoadError(reason);
        else notify(t(lang, `术语表没能刷新，下面还是刚才的内容：${reason}`, `Glossary not refreshed; still showing the earlier content: ${reason}`), 'warning');
      };
      if (!quiet) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const answer = await readGlossary(host, identity, lang, explicitTarget);
        if (superseded()) return;
        if (!answer.ok) {
          fail(answer.reason);
          return;
        }
        onDataRef.current(answer.data);
        setLoadError(null);
        shownRef.current = { documentId, sourceId };
      } catch (err) {
        if (!superseded()) fail(errorMessage(err));
      } finally {
        if (!superseded()) {
          pendingRef.current = null;
          setLoading(false);
        }
      }
    },
    [documentId, host, identity, lang, notify, sourceId],
  );

  const loadRef = useRef(load);
  loadRef.current = load;
  /** A change that was just saved is newer than the answer of a load still on its way: ask again, which also drops that answer. */
  const refreshIfLoading = useCallback(() => {
    if (pendingRef.current !== null) void loadRef.current(undefined, { quiet: shownRef.current !== null });
  }, []);

  useEffect(() => {
    const shown = shownRef.current;
    const sameDocument = Boolean(
      shown && ((documentId && shown.documentId === documentId) || (sourceId && shown.sourceId === sourceId)),
    );
    void load(undefined, { quiet: sameDocument });
    // `load` is a new function whenever the identity changes, which is what runs this again.
  }, [load, documentId, sourceId]);

  return { loading, loadError, reload: load, refreshIfLoading };
}

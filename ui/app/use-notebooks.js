import { useCallback, useEffect } from 'react';
import { errorMessage } from '../i18n.js';

/* The cross-workspace notebook directory on the library home: loaded once per library and again whenever the learner
   returns to the library page, so due counts stay honest. A request that was in flight when the library changed is dropped
   (the notebookRequest counter, bumped by the library reset). */
export function useNotebooks({ core, lib, nav, host, root }) {
  const { call, act, setError, refs } = core;
  const { setNotebooks, setNotebookError } = lib.set;
  const loadNotebooks = useCallback(async () => {
    const request = ++refs.notebookRequest.current;
    try {
      const next = await call('notebook.list');
      if (request !== refs.notebookRequest.current) return;
      setNotebooks(next);
      setNotebookError('');
    } catch (failure) {
      if (request !== refs.notebookRequest.current) return;
      setNotebookError(errorMessage(failure));
    }
  }, [call, refs, setNotebooks, setNotebookError]);
  useEffect(() => { if (root && nav.page === 'library') loadNotebooks(); }, [root, nav.page, loadNotebooks]);
  const toggle = useCallback((publish) => act(publish ? 'notebook.publish' : 'notebook.unpublish', {}, (result) => {
    refs.notebookRequest.current++;
    setNotebooks(result);
    setNotebookError('');
  }), [act, refs, setNotebooks, setNotebookError]);
  const open = useCallback(async (notebook) => {
    setError('');
    try { await host.openWorkspaceNotebook?.(notebook.workspace); }
    catch (failure) { setError(errorMessage(failure)); }
  }, [host, setError]);
  const search = useCallback((query) => call('notebook.search', { query }), [call]);
  return { notebooks: lib.state.notebooks, notebookError: lib.state.notebookError, loadNotebooks, publish: () => toggle(true), unpublish: () => toggle(false), open, search };
}

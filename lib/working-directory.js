import { isAbsolute } from 'node:path';

/**
 * The folder a path the learner gives (relative, or an @ mention) is relative to.
 *
 * DSH 0.2.1 lets a conversation change its folder (the host-wide `working_directory` tool). The
 * effective folder lives in the session projection "workingDirectory" (@deepseek-ai/dsh-working-directory
 * 0.2.1-rc.2 lib/index.js: `sessionProjections.stateOf(session, "workingDirectory")`), and DSH resolves
 * @ mentions and file tools against it; the session header keeps the folder the conversation started in.
 * StudyHub keeps its library bound to that original folder (header.cwd), which never moves, but reads a
 * path the learner names the way DSH does. DSH 0.2.0 has no such projection: the header is the folder.
 */
export function effectiveDirectory(ctx, session, fallback = session?.header?.cwd) {
  try {
    if (!session || !ctx?.get?.('workingDirectory')) return fallback;
    const current = ctx.get('sessionProjections')?.stateOf?.(session, 'workingDirectory');
    return typeof current === 'string' && isAbsolute(current) ? current : fallback;
  } catch { return fallback; }
}

/**
 * The same folder for a request that names a session id, live or not (a StudyHub panel can be open on a conversation
 * that is not loaded). A live session reads its projection directly. A cold one reads the "workingDirectory" row DSH
 * 0.2.1 checkpoints when a session detaches (@deepseek-ai/dsh-session-projection-cache 0.2.1-rc.2
 * `cachedSnapshot(header, keys)`: zero I/O beyond the header stat, never a replay of the whole log). Without that row,
 * on DSH 0.2.0, or on any failure, the folder the conversation started in (`fallback`) is used.
 */
export async function currentDirectory(ctx, sessionId, fallback) {
  try {
    const live = ctx?.sessions?.get?.(sessionId);
    if (live) return effectiveDirectory(ctx, live, fallback);
    if (!ctx?.get?.('workingDirectory')) return fallback;
    const cache = ctx.get('sessionProjectionCache');
    const persistence = ctx.get('sessionPersistence');
    if (typeof cache?.cachedSnapshot !== 'function' || typeof persistence?.stat !== 'function') return fallback;
    const header = (await persistence.stat(sessionId))?.header;
    if (!header) return fallback;
    const current = cache.cachedSnapshot(header, ['workingDirectory'])?.values?.workingDirectory;
    return typeof current === 'string' && isAbsolute(current) ? current : fallback;
  } catch { return fallback; }
}

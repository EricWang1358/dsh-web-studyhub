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

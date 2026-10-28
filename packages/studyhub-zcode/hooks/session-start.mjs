/* SessionStart hook: one line with today's review load, so a ZCode session opens with it in view.
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   The count is lib/'s (host/due.mjs: the dashboard's 到期待复习), the library is the one the panel uses
   (host/workspace.mjs), and nothing is written. It stops itself well inside ZCode's 10 s limit and says nothing at all
   when anything fails: a session start is never blocked or cluttered by StudyHub. */
import { readConfig, resolveHome } from '../host/workspace.mjs';
import { dueLine, dueSummary } from '../host/due.mjs';

const HOOK_BUDGET_MS = 8000;

async function main() {
  const { home } = resolveHome(process.env);
  const { libraryRoot } = readConfig({ env: process.env, home });
  return dueLine(await dueSummary(libraryRoot));
}

const timer = setTimeout(() => process.exit(0), HOOK_BUDGET_MS);
timer.unref();
try {
  const line = await main();
  if (line) process.stdout.write(line);
} catch { /* an unreadable library stays silent */ }
clearTimeout(timer);

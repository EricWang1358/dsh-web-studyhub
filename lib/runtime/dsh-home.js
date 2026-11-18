import { homedir } from 'node:os';
import { join } from 'node:path';

/** Trimmed `DSH_HOME` override when configured, or empty string. */
export const dshHomeOverride = () => process.env.DSH_HOME?.trim() || '';

/** The DSH user home directory (`DSH_HOME` when set, otherwise `~/.dsh`). */
export const dshHome = () => dshHomeOverride() || join(homedir(), '.dsh');

/** A path under `<DSH home>/study/`. */
export const studyHomePath = (...segments) => join(dshHome(), 'study', ...segments);

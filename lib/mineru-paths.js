import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* Where cloud PDF conversion keeps its temporary files: the DSH home (DSH_HOME when set), never the study library
   (which is exported, backed up and shown to the panel). One folder per library, named by a hash of its path. */

const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const sha16 = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

/** The folder holding every conversion of one library: jobs/, results/ (finished pieces by file hash) and uploads/. */
export const convertHome = root => join(dshHome(), 'study', 'tmp', 'pdf-convert', sha16(root));
export const uploadsHome = root => join(convertHome(root), 'uploads');
export const resultsDir = (root, sourceHash) => join(convertHome(root), 'results', String(sourceHash).slice(0, 16));
const JOB_ID = /^[\w-]{8,64}$/;
export function jobDir(root, jobId) {
  if (!JOB_ID.test(String(jobId))) throw new Error('无效的转换任务');
  return join(convertHome(root), 'jobs', jobId);
}

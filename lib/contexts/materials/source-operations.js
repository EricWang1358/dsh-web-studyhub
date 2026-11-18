import { importCourses, assignSourceCourses } from "../../source-courses.js";
import { currentCourse } from "../../focus.js";
import { importSourceFile } from "../../documents.js";
import { fileNameOf } from "../../document-title.js";
import { id, required } from "../../util.js";
import { MAX_SELECTED_CHARS } from "../../batch.js";
import { archiveSources } from '../../source-archive.js';
import { normalizeSourceProvenance } from "../../source-provenance.js";
import {
  createMaterialFolder,
  setMaterialFolder,
  renameMaterialFolder,
  deleteMaterialFolder,
  applyMaterialFolderAssignments,
} from './material-folders.js';
import { suggestMaterialFolders } from './folder-suggest.js';



/** materials operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, light, complete, language, tokenMeter } = ports;
const handlers = {
"source.import": (a) => importSourceFile(storagePort, a),
"source.folder.suggest": async (a) => suggestMaterialFolders(await storagePort.read(), a, { light, complete, language, tokenMeter }),
};
const mutations = {
"source.folder.create": (s, a) => createMaterialFolder(s, a),
"source.folder.set": (s, a) => setMaterialFolder(s, a),
"source.folder.rename": (s, a) => renameMaterialFolder(s, a),
"source.folder.delete": (s, a) => deleteMaterialFolder(s, a),
"source.folder.apply": (s, a) => applyMaterialFolderAssignments(s, a),
"source.archive": archiveSources,
"source.courses.set": (s, a) => assignSourceCourses(s, a.assignments),
"source.add": (s, a) => {
      const provenance = normalizeSourceProvenance(a.provenance);
      const source = {
        id: a.id || id(),
        // A caller that names a material by the file's path (the host's attachment storage) gets the file name (#207).
        title: fileNameOf(required(a.title, "Source title")),
        text: required(a.text, "Source text"),
        createdAt: new Date().toISOString(),
        courses: importCourses(a, currentCourse(s)),
        ...(['md', 'markdown'].includes(a.format) ? { format: 'md' } : {}),
        ...(provenance ? { provenance } : {}),
      };
      if (source.text.length > MAX_SELECTED_CHARS)
        throw new Error(`Source must be at most ${MAX_SELECTED_CHARS} characters`);
      if (s.sources.some((x) => x.id === source.id))
        throw new Error("Source id already exists");
      s.sources.push(source);
      return source;

    }
};
  return { handlers, mutations };
}

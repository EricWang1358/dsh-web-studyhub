export { SourcesView } from './SourcesView.js';
export { DocumentReader, type DocumentReaderProps } from './DocumentReader.js';
export { ImportModal, type ImportModalProps } from './ImportModal.js';
export { FolderModal, type FolderModalProps, type FolderModalMode } from './FolderModal.js';
export { CompanionsModal, type CompanionsModalProps } from './CompanionsModal.js';
export { completeFsPath, expandHomePath, type PathCompletionResult, type PathCompleteOptions } from './path-complete.js';
export {
  groupSourcesFromSnapshot,
  materialFoldersFromSnapshot,
  normalizeFolderName,
  type DocumentGroup,
  type MaterialFoldersState,
} from './source-helpers.js';

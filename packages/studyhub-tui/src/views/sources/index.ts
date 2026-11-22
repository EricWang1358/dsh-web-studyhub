export { SourcesView } from './SourcesView.js';
export { DocumentReader, type DocumentReaderProps } from './DocumentReader.js';
export { ImportModal, type ImportModalProps } from './ImportModal.js';
export { FolderModal, type FolderModalProps, type FolderModalMode } from './FolderModal.js';
export { CompanionsModal, type CompanionsModalProps } from './CompanionsModal.js';
export {
  OrganizeSourcesModal,
  collectOrganizeSourceIds,
  MAX_ORGANIZE_SUGGEST_SOURCES,
  type OrganizeSourcesModalProps,
} from './OrganizeSourcesModal.js';
export { SourceCoverageModal, type SourceCoverageModalProps } from './SourceCoverageModal.js';
export { completeFsPath, expandHomePath, type PathCompletionResult, type PathCompleteOptions } from './path-complete.js';
export {
  groupSourcesFromSnapshot,
  materialFoldersFromSnapshot,
  normalizeFolderName,
  type DocumentGroup,
  type MaterialFoldersState,
} from './source-helpers.js';

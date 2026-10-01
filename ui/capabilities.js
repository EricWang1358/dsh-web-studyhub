const pageContexts = {
  library: ['bank', 'study'], manage: ['bank'],
  review: ['bank', 'study'], wrongbook: ['bank', 'study'],
  exam: ['bank', 'study'], dashboard: ['bank', 'study'], graph: ['bank', 'study'],
  generate: ['materials', 'bank', 'authoring', 'generation'], draft: ['bank', 'authoring'],
  sources: ['materials'], audio: ['audio'], live: ['audio', 'recording'],
  workflows: ['workflows', 'bank', 'study'], skeleton: ['skeleton'], notes: ['notes'],
};

// Older hosts and the offline demo do not publish a capability list.
export function hasContext(data, id) {
  return !Array.isArray(data?.contexts) || data.contexts.includes(id);
}
export function pageAvailable(data, page) {
  return (pageContexts[page] || []).every(id => hasContext(data, id));
}

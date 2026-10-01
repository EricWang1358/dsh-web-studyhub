export const inject = ["slots", "locale"];

// The host awaits plugin activation. Both native seats and preview actions
// arrive through its official package-local classic-module chunk loader.
export async function apply(ctx) {
  const [workspace, documents] = await Promise.all([
    import("./host/workspace.jsx"),
    import("./document-preview/native.jsx"),
  ]);
  return workspace.apply(ctx, documents.registerDocumentLearning);
}

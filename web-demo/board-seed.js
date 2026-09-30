export function sampleBoard() {
  const at = new Date().toISOString();
  const entries = [
    ['demo-task-recall', 'Explain the three Memento roles without notes', 'todo', 'Review', 'Name the Originator, Memento and Caretaker, then explain who may read the snapshot.'],
    ['demo-task-bridge', 'Sketch a report system with two rendering backends', 'doing', 'Apply', 'Use composition. Explain how a new backend can be added without changing every report type.'],
    ['demo-task-notes', 'Turn the snapshot example into study notes', 'done', 'Notes', 'The sample note is available under Study notes. Edit it or connect it to your own practice.'],
  ];
  return { version: 1, revision: 1, demoSeedVersion: 2, archived: [],
    columns: [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']].map(([id, title]) => ({ id, title, done: id === 'done', cardIds: entries.filter(e => e[2] === id).map(e => e[0]) })),
    cards: Object.fromEntries(entries.map(([id, title, , label, note]) => [id, { id, title, note: `Sample task.\n\n${note}`, due: '', labels: [label], createdAt: at, updatedAt: at, origin: { workspace: '/demo', workspaceTitle: 'Design patterns demo' } }])) };
}

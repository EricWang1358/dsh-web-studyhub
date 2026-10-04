export async function existingNoteMaterial(call, material) {
  try { return await call('source.get', { id: material.id, limit: 1 }); }
  catch (error) { if (error.code === 'not-found') return null; throw error; }
}

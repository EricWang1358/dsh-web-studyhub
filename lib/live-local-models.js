/** Stable model identifiers are also saved with each local class. */
export const DEFAULT_LOCAL_MODEL = 'sense-voice';
export const LOCAL_MODELS = Object.freeze([
  Object.freeze({ id: DEFAULT_LOCAL_MODEL, name: 'SenseVoice Small int8', tier: 'speed', modelMb: 228 }),
  Object.freeze({ id: 'whisper-turbo', name: 'Whisper large-v3-turbo int8', tier: 'quality', modelMb: 989 }),
]);

export function localModelOf(id = DEFAULT_LOCAL_MODEL) {
  const model = LOCAL_MODELS.find(item => item.id === id);
  if (!model) throw new Error('未知的本地转写模型');
  return model;
}

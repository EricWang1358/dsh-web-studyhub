import type { BindingSnapshot, DesktopConfigSnapshot, StudySnapshot } from '../types/contracts.js';

/** Pure selectors over the loose StudySnapshot shape (shared by shell widgets). */

export interface CourseEntry {
  key: string;
  label: string;
  dueCount: number;
  deckCount: number;
}

export function courseKey(c: { name?: string; id?: string; title?: string }): string {
  return String(c.name ?? c.id ?? c.title ?? '');
}

export function listCourses(snapshot: StudySnapshot | null | undefined): CourseEntry[] {
  const out: CourseEntry[] = [];
  const seen = new Set<string>();
  for (const c of snapshot?.courses ?? []) {
    const key = courseKey(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: String(c.title ?? c.name ?? c.id ?? key),
      dueCount: Number(c.dueCount ?? 0) || 0,
      deckCount: Number(c.deckCount ?? 0) || 0,
    });
  }
  return out;
}

export function currentCourse(snapshot: StudySnapshot | null | undefined): string | null {
  const c = snapshot?.focus?.course;
  return typeof c === 'string' && c ? c : null;
}

export function dueToday(snapshot: StudySnapshot | null | undefined): number {
  const direct = Number(snapshot?.today?.due);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  return (snapshot?.decks ?? []).reduce((n, d) => n + (Number(d.dueCount) || 0), 0);
}

export function wrongCount(snapshot: StudySnapshot | null | undefined): number {
  return (snapshot?.decks ?? []).reduce((n, d) => n + (Number(d.wrongCount) || 0), 0);
}

const RUNNING = new Set(['running', 'queued', 'pending', 'active', 'in_progress', 'started', 'processing']);

export function runningJobs(snapshot: StudySnapshot | null | undefined): number {
  return (snapshot?.jobs ?? []).filter((j) => RUNNING.has(String(j.status ?? '').toLowerCase())).length;
}

export function draftCount(snapshot: StudySnapshot | null | undefined): number {
  return (snapshot?.drafts ?? []).filter((d) => !d.status || d.status === 'draft' || d.status === 'ready').length;
}

export function isLibraryEmpty(snapshot: StudySnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return (snapshot.decks?.length ?? 0) === 0 && (snapshot.sources?.length ?? 0) === 0 && (snapshot.courses?.length ?? 0) === 0;
}

export interface ModelBadgeInfo {
  icon: string;
  provider: string;
  model: string;
  ready: boolean;
  reason: string;
  mode: 'agy' | 'openai' | 'codex' | 'unknown';
}

export function modelInfo(
  cfg: DesktopConfigSnapshot | null | undefined,
  binding?: BindingSnapshot | null,
  snapshot?: StudySnapshot | null,
): ModelBadgeInfo {
  const ready = Boolean(cfg?.effective?.ready ?? binding?.modelStatus?.ready ?? snapshot?.modelReady ?? false);
  const reason = String(cfg?.effective?.reason ?? binding?.modelStatus?.reason ?? '');
  if (!cfg) {
    const route = binding?.route;
    return {
      icon: '◌',
      provider: route?.provider ?? '模型',
      model: route?.model ?? '',
      ready,
      reason,
      mode: 'unknown',
    };
  }
  if (cfg.mode === 'agy') {
    return { icon: '⚡', provider: 'agy', model: cfg.agy?.model || cfg.effective?.model || '', ready, reason, mode: 'agy' };
  }
  if (cfg.mode === 'codex') {
    return { icon: '◇', provider: 'codex', model: cfg.codex?.model || cfg.effective?.model || '', ready, reason, mode: 'codex' };
  }
  const preset = cfg.presets?.find((p) => p.id === cfg.openai?.providerId);
  return {
    icon: '☁',
    provider: preset?.name ?? (cfg.openai?.providerId && cfg.openai.providerId !== 'custom' ? cfg.openai.providerId : 'OpenAI'),
    model: cfg.openai?.model || cfg.effective?.model || '',
    ready,
    reason,
    mode: 'openai',
  };
}

export interface AgyDetection {
  state: 'probing' | 'ready' | 'missing' | 'unauthenticated';
  version: string | null;
  path: string | null;
  modelCount: number;
  reason: string;
}

export function detectAgy(cfg: DesktopConfigSnapshot | null | undefined): AgyDetection {
  if (!cfg) return { state: 'probing', version: null, path: null, modelCount: 0, reason: '' };
  const p = cfg.providers?.find((x) => x.id === 'agy');
  if (!p) {
    return {
      state: cfg.mode === 'agy' && cfg.effective?.ready ? 'ready' : 'missing',
      version: null,
      path: cfg.agy?.executablePath || null,
      modelCount: 0,
      reason: cfg.effective?.reason ?? '',
    };
  }
  return {
    state: p.ready ? 'ready' : p.unauthenticated ? 'unauthenticated' : 'missing',
    version: p.version ?? null,
    path: p.executablePath ?? (cfg.agy?.executablePath || null),
    modelCount: p.models?.length ?? 0,
    reason: p.reason ?? p.status ?? '',
  };
}

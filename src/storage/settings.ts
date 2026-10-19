// User settings with defaults. Kept in the IndexedDB kv store under one key.
// API keys never leave the phone except in requests to the provider itself.

import { db } from './db';

export interface Settings {
  profile: {
    name: string;
    aliases: string;
    from: string;
    livesIn: string;
    job: string;
    other: string;
  };
  level: 'beginner' | 'intermediate';
  keys: { openrouter: string; openai: string };
  /** Set automatically when OpenRouter reports its balance is used up. */
  openrouterExhausted: boolean;
  models: {
    /** Live translation + answer hints: must be fast. */
    liveOpenrouter: string;
    liveOpenai: string;
    /** Post-class review generation: quality over speed. */
    deepOpenrouter: string;
    deepOpenai: string;
    /** Post-class transcription. */
    sttOpenrouter: string;
    sttOpenai: string;
  };
  /** Extra provider options for transcription, e.g. diarization. JSON text, may be empty. */
  sttProviderOptions: string;
  /** Days to keep full class recordings on the phone. 0 = delete right after processing. */
  keepAudioDays: number;
  recordAudio: boolean;
  lastSchool: 'ILA' | 'WSE';
}

export const DEFAULT_SETTINGS: Settings = {
  profile: {
    name: 'Kevin',
    aliases: 'Kevin, Xu',
    from: 'Wuhan, China',
    livesIn: 'Ho Chi Minh City, Vietnam',
    job: 'Java developer, builds AI automation tools',
    other: '',
  },
  level: 'beginner',
  keys: { openrouter: '', openai: '' },
  openrouterExhausted: false,
  models: {
    liveOpenrouter: 'openai/gpt-4o-mini',
    liveOpenai: 'gpt-4o-mini',
    deepOpenrouter: 'openai/gpt-4o-mini',
    deepOpenai: 'gpt-4o-mini',
    sttOpenrouter: 'openai/whisper-1',
    sttOpenai: 'whisper-1',
  },
  sttProviderOptions: '',
  keepAudioDays: 7,
  recordAudio: true,
  lastSchool: 'ILA',
};

const KEY = 'settings';
let cache: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

function merge(saved: Partial<Settings> | undefined): Settings {
  const s = saved ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    profile: { ...DEFAULT_SETTINGS.profile, ...(s.profile ?? {}) },
    keys: { ...DEFAULT_SETTINGS.keys, ...(s.keys ?? {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(s.models ?? {}) },
  };
}

export async function loadSettings(): Promise<Settings> {
  if (!cache) cache = merge(await db.kvGet<Partial<Settings>>(KEY));
  return cache;
}

export function currentSettings(): Settings {
  if (!cache) throw new Error('settings not loaded');
  return cache;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = merge({ ...(await loadSettings()), ...patch });
  cache = next;
  await db.kvSet(KEY, next);
  listeners.forEach((fn) => fn(next));
  return next;
}

export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function nameList(s: Settings): string[] {
  return [s.profile.name, ...s.profile.aliases.split(/[,，]/)].map((x) => x.trim()).filter(Boolean);
}

export function profileText(s: Settings): string {
  const p = s.profile;
  return [
    `Name: ${p.name} (people also call him: ${p.aliases})`,
    `From: ${p.from}`,
    `Lives in: ${p.livesIn}`,
    `Job: ${p.job}`,
    p.other ? `Other: ${p.other}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

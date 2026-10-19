// Settings the user edits in the app (stored on the server). API keys and the passcode are NOT here:
// they live only in the server config file (see src/server/config.ts).

export interface Profile {
  name: string;
  aliases: string;
  from: string;
  livesIn: string;
  job: string;
  other: string;
}

export interface UserSettings {
  profile: Profile;
  level: 'beginner' | 'intermediate';
  /** Days to keep full class recordings on the server. 0 = delete right after processing. */
  keepAudioDays: number;
  recordAudio: boolean;
  lastSchool: 'ILA' | 'WSE';
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  profile: {
    name: 'Kevin',
    aliases: 'Kevin, Xu',
    from: 'Wuhan, China',
    livesIn: 'Ho Chi Minh City, Vietnam',
    job: 'Java developer, builds AI automation tools',
    other: '',
  },
  level: 'beginner',
  keepAudioDays: 7,
  recordAudio: true,
  lastSchool: 'ILA',
};

export function mergeUserSettings(saved: Partial<UserSettings> | undefined | null): UserSettings {
  const s = saved ?? {};
  return { ...DEFAULT_USER_SETTINGS, ...s, profile: { ...DEFAULT_USER_SETTINGS.profile, ...(s.profile ?? {}) } };
}

export function nameList(s: UserSettings): string[] {
  return [s.profile.name, ...s.profile.aliases.split(/[,，]/)].map((x) => x.trim()).filter(Boolean);
}

export function profileText(s: UserSettings): string {
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

/** What the Settings screen shows about the AI providers (never the keys themselves). */
export interface ProviderStatus {
  openrouterConfigured: boolean;
  openaiConfigured: boolean;
  openrouterExhausted: boolean;
  openrouterRemaining: number | null;
  active: 'openrouter' | 'openai' | 'none';
}

// Server configuration from a JSON file that only the server reads.
// Path: $CLASSPILOT_CONFIG, default /opt/classpilot/config/config.json (see config.example.json).
// Secrets (passcode, API keys) are never sent to the browser and never logged.

import { existsSync, readFileSync } from 'node:fs';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  staticDir: string;
  passcode: string;
  openrouterKey: string;
  openaiKey: string;
  models: {
    liveOpenrouter: string;
    liveOpenai: string;
    deepOpenrouter: string;
    deepOpenai: string;
    sttOpenrouter: string;
    sttOpenai: string;
  };
  /** Extra OpenRouter provider options for transcription, e.g. {"deepgram": {"diarize": true}}. */
  sttProviderOptions: Record<string, unknown> | null;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 8095,
  host: '127.0.0.1',
  dataDir: '/opt/classpilot/data',
  staticDir: '/opt/classpilot/app/dist',
  passcode: '',
  openrouterKey: '',
  openaiKey: '',
  models: {
    liveOpenrouter: 'openai/gpt-4o-mini',
    liveOpenai: 'gpt-4o-mini',
    deepOpenrouter: 'openai/gpt-4o-mini',
    deepOpenai: 'gpt-4o-mini',
    sttOpenrouter: 'openai/whisper-1',
    sttOpenai: 'whisper-1',
  },
  sttProviderOptions: null,
};

export function loadConfig(path = process.env.CLASSPILOT_CONFIG ?? '/opt/classpilot/config/config.json'): ServerConfig {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const cfg: ServerConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    models: { ...DEFAULT_CONFIG.models, ...(raw.models ?? {}) },
  };
  if (process.env.CLASSPILOT_PORT) cfg.port = Number(process.env.CLASSPILOT_PORT);
  if (process.env.CLASSPILOT_DATA) cfg.dataDir = process.env.CLASSPILOT_DATA;
  if (process.env.CLASSPILOT_STATIC) cfg.staticDir = process.env.CLASSPILOT_STATIC;
  return cfg;
}

/** Problems that keep the service from being usable, in plain words (no secret values). */
export function configProblems(cfg: ServerConfig): string[] {
  const p: string[] = [];
  if (!cfg.passcode || cfg.passcode.length < 6) p.push('passcode 未设置或少于 6 位');
  if (!cfg.openrouterKey && !cfg.openaiKey) p.push('openrouterKey 和 openaiKey 至少要填一个');
  return p;
}

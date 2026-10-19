// HTTP layer: passcode login (HttpOnly cookie), JSON API under /api, static files for the app.
// Listens on 127.0.0.1 only; Caddy terminates HTTPS in front of it.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { UserSettings } from '../shared/settings';
import type { Ai } from './ai';
import type { ServerConfig } from './config';
import type { Store } from './db';
import { HttpError, type Service } from './service';

const COOKIE = 'cp_session';
const COOKIE_DAYS = 180;
const JSON_LIMIT = 1_000_000;
const AUDIO_LIMIT = 40_000_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface Deps {
  cfg: ServerConfig;
  store: Store;
  ai: Ai;
  service: Service;
}

function secret(dataDir: string): Buffer {
  const file = join(dataDir, 'session-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export function makeToken(key: Buffer, now = Date.now()): string {
  const exp = String(now + COOKIE_DAYS * 86_400_000);
  const sig = createHmac('sha256', key).update(exp).digest('hex');
  return `${exp}.${sig}`;
}

export function checkToken(key: Buffer, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < now) return false;
  const want = createHmac('sha256', key).update(exp).digest('hex');
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

function passcodeMatches(given: string, want: string): boolean {
  const a = createHmac('sha256', 'cp').update(given).digest();
  const b = createHmac('sha256', 'cp').update(want).digest();
  return want.length > 0 && timingSafeEqual(a, b);
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  return (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];
}

const STT_LIMIT = 4 * 1024 * 1024;

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, '上传的内容太大');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req, JSON_LIMIT);
  try {
    return (buf.length ? JSON.parse(buf.toString('utf8')) : {}) as T;
  } catch {
    throw new HttpError(400, '请求格式不对');
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// Simple login throttle: at most 10 failed attempts per 10 minutes per IP.
const failures = new Map<string, number[]>();
function tooManyFailures(ip: string, now = Date.now()): boolean {
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < 600_000);
  failures.set(ip, recent);
  return recent.length >= 10;
}

export function createApp(deps: Deps) {
  const { cfg, store, ai, service } = deps;
  const key = secret(cfg.dataDir);
  const secure = process.env.CLASSPILOT_INSECURE_COOKIE ? '' : '; Secure';

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

    if (path === '/api/health') return send(res, 200, { ok: true, version: process.env.CLASSPILOT_VERSION ?? 'dev' });

    if (path === '/api/login' && method === 'POST') {
      if (tooManyFailures(ip)) throw new HttpError(429, '尝试次数太多，请 10 分钟后再试');
      const { passcode } = await readJson<{ passcode?: string }>(req);
      if (!passcodeMatches(String(passcode ?? ''), cfg.passcode)) {
        failures.get(ip)?.push(Date.now());
        throw new HttpError(401, '口令不对');
      }
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${makeToken(key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}${secure}` });
    }

    if (!checkToken(key, cookieOf(req, COOKIE))) throw new HttpError(401, '请先输入口令');

    if (path === '/api/me') return send(res, 200, { ok: true });

    if (path === '/api/settings' && method === 'GET') return send(res, 200, service.settings());
    if (path === '/api/settings' && method === 'PUT') return send(res, 200, service.saveSettings(await readJson<Partial<UserSettings>>(req)));

    if (path === '/api/status' && method === 'GET') return send(res, 200, { ...(await ai.status()), items: store.itemCounts() });
    if (path === '/api/status/reset-openrouter' && method === 'POST') {
      ai.resetExhausted();
      return send(res, 200, await ai.status());
    }

    if (path === '/api/sessions' && method === 'GET') return send(res, 200, store.listSessions());
    if (path === '/api/sessions' && method === 'POST') {
      const b = await readJson<{ school?: string; topic?: string; mode?: string; deepReview?: boolean }>(req);
      return send(
        res,
        200,
        service.createSession({
          school: b.school === 'WSE' ? 'WSE' : 'ILA',
          topic: String(b.topic ?? '').slice(0, 200),
          mode: b.mode === 'chat' ? 'chat' : 'class',
          deepReview: b.deepReview !== false,
        }),
      );
    }

    if (path === '/api/sessions/bin' && method === 'GET') return send(res, 200, store.deletedSessions());
    let m = path.match(/^\/api\/sessions\/([\w-]+)$/);
    if (m && method === 'PATCH') {
      const b = await readJson<{ mode?: string }>(req);
      return send(res, 200, service.setMode(m[1], b.mode === 'chat' ? 'chat' : 'class'));
    }
    if (m && method === 'DELETE') return send(res, 200, service.deleteSession(m[1]));
    m = path.match(/^\/api\/sessions\/([\w-]+)\/restore$/);
    if (m && method === 'POST') return send(res, 200, service.restoreSession(m[1]));
    m = path.match(/^\/api\/sessions\/([\w-]+)$/);
    if (m && method === 'GET') {
      const s = service.mustSession(m[1]);
      return send(res, 200, { session: s, lines: store.linesFor(s.id), review: store.getReview(s.id) ?? null });
    }
    m = path.match(/^\/api\/sessions\/([\w-]+)\/end$/);
    if (m && method === 'POST') return send(res, 200, service.endSession(m[1]));
    m = path.match(/^\/api\/sessions\/([\w-]+)\/process$/);
    if (m && method === 'POST') {
      const s = service.mustSession(m[1]);
      s.status = 'processing';
      s.statusNote = '重新整理';
      store.putSession(s);
      void service.processClass(s.id);
      return send(res, 200, s);
    }
    m = path.match(/^\/api\/sessions\/([\w-]+)\/lines$/);
    if (m && method === 'POST') {
      const b = await readJson<{ id?: string; t?: number; en?: string }>(req);
      if (!b.id || typeof b.en !== 'string') throw new HttpError(400, '缺少内容');
      return send(res, 200, await service.analyzeUtterance(m[1], { id: String(b.id), t: Number(b.t) || 0, en: b.en.slice(0, 2000) }));
    }
    m = path.match(/^\/api\/sessions\/([\w-]+)\/audio\/(\d+)$/);
    if (m && method === 'PUT') {
      const mime = String(req.headers['content-type'] ?? 'audio/mp4').split(';')[0];
      const startedAt = Number(req.headers['x-started-at']) || Date.now();
      service.saveAudio(m[1], Number(m[2]), startedAt, mime, await readBody(req, AUDIO_LIMIT));
      return send(res, 200, { ok: true });
    }

    if (path === '/api/ask' && method === 'POST') {
      const b = await readJson<{ question?: string; sessionId?: string; history?: { q: string; a: string }[] }>(req);
      if (!b.question?.trim()) throw new HttpError(400, '问题是空的');
      return send(res, 200, await service.ask(b.question.slice(0, 1000), b.sessionId, Array.isArray(b.history) ? b.history : []));
    }
    if (path === '/api/plan' && method === 'GET') return send(res, 200, await service.planStatus());
    if (path === '/api/scores' && method === 'GET') return send(res, 200, service.scores());
    if (path === '/api/talk/score' && method === 'POST') {
      const b = await readJson<{ scenarioId?: string; kind?: string; history?: { who: 'ai' | 'me'; en: string }[] }>(req);
      const history = (Array.isArray(b.history) ? b.history : [])
        .filter((t) => t && (t.who === 'ai' || t.who === 'me') && typeof t.en === 'string')
        .map((t) => ({ who: t.who, en: t.en.slice(0, 500) }));
      return send(res, 200, await service.scoreTalk({ scenarioId: b.scenarioId, kind: b.kind === 'test' ? 'test' : 'scenario', history }));
    }
    if (path === '/api/talk' && method === 'POST') {
      const b = await readJson<{ scenarioId?: string; history?: { who: 'ai' | 'me'; en: string }[]; said?: string }>(req);
      const history = (Array.isArray(b.history) ? b.history : [])
        .filter((t) => t && (t.who === 'ai' || t.who === 'me') && typeof t.en === 'string')
        .map((t) => ({ who: t.who, en: t.en.slice(0, 500) }));
      return send(res, 200, await service.talk({ scenarioId: b.scenarioId, history, said: String(b.said ?? '').slice(0, 1000) }));
    }
    if (path === '/api/word' && method === 'POST') {
      const b = await readJson<{ word?: string; sentence?: string; sessionId?: string }>(req);
      if (!b.word) throw new HttpError(400, '缺少单词');
      return send(res, 200, await service.lookupWord(String(b.word).slice(0, 60), String(b.sentence ?? '').slice(0, 500), b.sessionId));
    }

    if (path === '/api/items' && method === 'GET') return send(res, 200, store.allItems());
    if (path === '/api/items/due' && method === 'GET') return send(res, 200, store.dueItems(Date.now()));
    m = path.match(/^\/api\/items\/([\w-]+)\/check$/);
    if (m && method === 'POST') {
      const b = await readJson<{ answer?: string; spoken?: boolean }>(req);
      return send(res, 200, await service.checkAnswer(m[1], String(b.answer ?? '').slice(0, 500), !!b.spoken));
    }
    if (path === '/api/voicelog' && method === 'GET') return send(res, 200, { stt: service.voiceLog(), checks: service.checkLog() });
    m = path.match(/^\/api\/voicelog\/([\w.-]+)$/);
    if (m && method === 'GET') {
      const clip = service.voiceClip(m[1]);
      if (!clip) throw new HttpError(404, '没有这个录音');
      res.writeHead(200, { 'Content-Type': clip.mime, 'Cache-Control': 'no-store' });
      res.end(clip.body);
      return;
    }
    if (path === '/api/stt' && method === 'POST') {
      const mime = String(req.headers['content-type'] ?? 'audio/mp4').split(';')[0];
      if (!/^audio\//.test(mime)) throw new HttpError(400, '不是音频');
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const lang = q.get('lang') === 'zh' ? 'zh' : 'en';
      const hint = (q.get('hint') ?? '').slice(0, 300);
      return send(res, 200, { text: await service.speechToText(await readBody(req, STT_LIMIT), mime, lang, hint, q.get('live') === '1', String(req.headers['x-audio-info'] ?? '')) });
    }
    m = path.match(/^\/api\/items\/([\w-]+)\/grade$/);
    if (m && method === 'POST') {
      const b = await readJson<{ correct?: boolean }>(req);
      return send(res, 200, service.gradeItem(m[1], !!b.correct));
    }

    if (path === '/api/export' && method === 'GET') {
      return send(res, 200, store.exportAll(), { 'Content-Disposition': 'attachment; filename="classpilot-backup.json"' });
    }

    throw new HttpError(404, '没有这个接口');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
    let file = join(cfg.staticDir, rel);
    if (!file.startsWith(cfg.staticDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(cfg.staticDir, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ClassPilot 前端还没有构建');
      return;
    }
    const isHtml = file.endsWith('.html');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return void res.end();
    res.end(readFileSync(file));
  }

  return createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path.startsWith('/api/')) await api(req, res, path);
      else serveStatic(req, res, path);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) console.error(`[http] ${req.method} ${path}: ${message}`);
      if (!res.headersSent) send(res, status, { error: message, extra: e instanceof HttpError ? e.extra : undefined });
      else res.end();
    }
  });
}

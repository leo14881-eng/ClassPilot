// ClassPilot server entry point. Run: node dist-server/server.mjs
// Config: $CLASSPILOT_CONFIG (default /opt/classpilot/config/config.json).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ai } from './ai';
import { configProblems, loadConfig } from './config';
import { Store } from './db';
import { createApp } from './http';
import { Service } from './service';

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
for (const p of configProblems(cfg)) console.warn(`[config] ${p}`);

const store = new Store(join(cfg.dataDir, 'classpilot.db'));
const ai = new Ai(cfg, store);
const service = new Service(store, ai, cfg.dataDir);

service.resumeProcessing();
service.cleanupAudio();
service.purgeDeleted();
setInterval(() => {
  service.cleanupAudio();
  service.purgeDeleted();
}, 6 * 3_600_000).unref();

const server = createApp({ cfg, store, ai, service });
server.requestTimeout = 300_000;
server.listen(cfg.port, cfg.host, () => console.log(`[classpilot] listening on http://${cfg.host}:${cfg.port}`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

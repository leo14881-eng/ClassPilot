# ClassPilot — notes for Claude Code

Real-time English class assistant for one learner (Kevin / "Xu", WSE level 4 ≈ CEFR A1, studies at ILA and Wall Street English, goal: basic daily/travel/hospital conversation by 2027-01-31). Phone web app + Node server on a shared Vultr box.

## Rules
- The user talks to you in Chinese; UI copy and commit messages are Chinese. Commit messages say what improved (改善了什么).
- Run `npm run check` (typecheck + tests + build) before every push. Develop on `dev`. The user tests locally first (`scripts\start-local.cmd` on his Windows PC, code in D:\SOFT\ClassPilot); merge to `main` only after he confirms. The server auto-deploys `main` once CI passes.
- API keys and the passcode live only in the server config file. Never send them to the browser, log them, or commit them.
- No runtime npm dependencies on the server (built-in `node:http`, `node:sqlite`, `fetch`). Dev deps only: esbuild, typescript, tsx, @types/node.
- The server is shared with TrendPilot/StockPilot: only touch `/opt/classpilot*`, user `classpilot`, `classpilot.*` units, `/etc/caddy/sites/classpilot.caddy`. Memory cap 400M.
- Prompts live in `src/shared/prompts.ts`; tune answer quality there, not in app code.
- Review rules (migrated from the learner's existing system): IPA only, Chinese prompt → English answer, no hints before answering, wrong → retest, 3 correct in a row = mastered (`src/shared/schedule.ts`).

## Layout
- `src/shared` types, prompts, priority (who a question is for), schedule, fallback (OpenRouter → OpenAI on 402/credits).
- `src/server` `main.ts` → `http.ts` (routes, cookie auth, static) → `service.ts` (live analysis, ask, word, post-class) → `ai.ts`, `db.ts`.
- `src/client` `main.ts` router; `live.ts` controller; `recognizer.ts` Web Speech with auto-restart; `recorder.ts` 3-minute audio chunks; `ui/`.
- `scripts/linux` install / auto-update / status (mirrors TrendPilot's). `scripts/server.ps1` fixed maintenance actions from the Windows PC.

## Not built yet (v2)
Daily plan (10 words/day: life/travel/hospital 7 + work 3, A2-focused), scenario training (10 dialogues easy→hard, 28 scenarios in 3 phases to 2027-01-31), weekly speaking tests and scores, level rating, import of the existing ILA.md / review queue.

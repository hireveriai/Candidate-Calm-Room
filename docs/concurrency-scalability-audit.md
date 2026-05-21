# HireVeri Concurrency, Scalability, And Multi-Session Audit

Generated: 2026-05-21

Scope reviewed:
- Candidate calm room: `hireveri-calm`
- Recruiter app and backend: `hireveri-recruiter`
- Shared PostgreSQL/Supabase schema, Prisma, raw SQL, LiveKit recording/token paths

This audit is a code and schema review with existing stability-test coverage inspection. I did not run 20/50/100 live candidate load tests in this pass because there is no already-running, production-like multi-service target with seeded credentials and LiveKit capacity exposed in the workspace.

## Executive Verdict

Current production readiness score: **62/100**

Estimated safe concurrent interview capacity with current defaults:
- **5-10 concurrent interviews per deployed app instance** if OpenAI answer/evaluation calls are enabled and `PG_POOL_MAX` / Prisma `connection_limit` remain at `1`.
- **20-35 concurrent interviews** with multiple app instances, LiveKit cloud capacity, and pool limits raised carefully behind PgBouncer/Supabase pooler.
- **50-100 concurrent interviews are not safe yet** without DB pool tuning, endpoint auth hardening, idempotency fixes, and real load testing.

Major risks before production launch:
- Candidate runtime APIs trust possession of `attemptId` / `sessionQuestionId` too broadly.
- Calm room fallback session-start path can double-create attempts under concurrent starts if the database RPC is missing/failing.
- DB pool defaults are set to one connection in both apps, which serializes work and will bottleneck dashboards, reports, answer saves, evaluations, and heartbeats.
- LiveKit token endpoint lets any caller mint a publisher token for any room name.
- Answer save uses select-then-insert without an atomic upsert on `session_question_id`.
- Realtime is LiveKit media only; application events use HTTP polling/signals, so websocket event scoping is mostly absent rather than robust.

## Findings

### Critical: LiveKit publisher token is unauthenticated and room-forgeable

Impacted file:
- `hireveri-calm/app/api/livekit/token/route.ts`

Evidence:
- The route accepts `room`, `userId`, and `role` from query params and mints a LiveKit publisher token directly.
- There is no lookup proving `room === attemptId`, no invite/recovery token proof, no candidate ownership check, and no rate limit.

Impact:
- A caller who learns or guesses an attempt UUID can publish audio/video into that candidate's room.
- Multi-session isolation depends on UUID secrecy, not authorization.

Recommended fix:
- Require a signed candidate session token issued by `/api/session/start`.
- Validate the token contains `attemptId`, `candidateId`, expiry, and room claim.
- Ignore caller-supplied `userId`; derive identity server-side.
- Set a short LiveKit token TTL, for example 10-15 minutes, and refresh with the signed session token.

### Critical: Calm room candidate APIs are bearerless after session start

Impacted files:
- `hireveri-calm/app/api/session/answer/route.ts`
- `hireveri-calm/app/api/session/complete/route.ts`
- `hireveri-calm/app/api/session/terminate/route.ts`
- `hireveri-calm/app/api/session/signal/route.ts`
- `hireveri-calm/app/api/interview/heartbeat/route.ts`
- `hireveri-calm/app/api/interview/reconnect-state/route.ts`
- `hireveri-calm/app/api/livekit/start-recording/route.ts`
- `hireveri-calm/app/api/livekit/stop-recording/route.ts`

Evidence:
- Endpoints primarily validate UUID shape and DB existence. `/api/session/answer` does verify `attemptId`, `candidateId`, and `questionId` against `sessionQuestionId`, which is good, but the route still has no signed session proof.
- `/api/session/complete` finalizes solely by `attemptId`.

Impact:
- One candidate session can affect another if an `attemptId` or `sessionQuestionId` leaks through logs, browser storage, screenshots, analytics, or guessed internal links.
- Malicious or buggy clients can prematurely complete, terminate, send telemetry, or trigger recording changes for another attempt.

Recommended fix:
- Issue an HttpOnly candidate cookie or signed JWT from `/api/session/start`.
- Add middleware/helper `requireCandidateAttemptContext(request, attemptId)` to every calm API.
- Store token hash or nonce on `interview_attempts`; rotate it on recovery.

### High: Fallback session-start path has duplicate attempt race

Impacted file:
- `hireveri-calm/app/api/session/start/route.ts`

Evidence:
- Preferred path calls `public.start_interview_session(token)`, whose migration uses `FOR UPDATE`.
- Fallback path reads invite, reads latest attempt, checks `attempts_used`, creates attempt, then increments invite in a transaction, but it does not lock the invite row before deciding.

Impact:
- If the RPC is missing/failing during deploy drift, two concurrent starts for the same invite can both pass `attempts_used < max_attempts`.
- Unique `(interview_id, attempt_number)` may reject one request, or worse create duplicate/failed partial state depending on timing.

Recommended fix:
- Remove fallback in production or make it use the same transaction semantics:
  - `SELECT ... FROM interview_invites WHERE token = $1 FOR UPDATE`
  - lock latest attempts by interview
  - create attempt and increment invite inside that transaction
- Treat missing database routines as startup/readiness failures, not runtime fallback.

### High: Answer save is select-then-insert instead of atomic upsert

Impacted file:
- `hireveri-calm/app/lib/calmAnswerPipeline.ts`

Evidence:
- `ensureGeneratingAnswer()` first selects an existing answer by `session_question_id`, then inserts a new row if none exists.
- Schema unique constraints are on `(attempt_id, question_id)` but dynamic/follow-up questions often have `question_id = null`, while the durable unique key should be `session_question_id`.

Impact:
- Double-click, retry, browser reconnect, or delayed POST can race and insert duplicate rows for the same session question if no unique index exists.
- With `question_id null`, PostgreSQL unique constraints do not protect duplicate rows on `(attempt_id, question_id)`.

Recommended fix:
- Add a unique partial index on `interview_answers(session_question_id) where session_question_id is not null`.
- Replace select-then-insert with `INSERT ... ON CONFLICT (session_question_id) WHERE session_question_id IS NOT NULL DO UPDATE`.

### High: DB pool defaults cap throughput

Impacted files:
- `hireveri-calm/app/lib/prisma.ts`
- `hireveri-recruiter/lib/server/prisma.ts`
- `hireveri-recruiter/lib/server/pg.ts`

Evidence:
- Calm room defaults `PG_POOL_MAX` to `1`.
- Recruiter Prisma injects `connection_limit=1`.
- Recruiter raw `pg` pool uses `max: 1`.

Impact:
- One slow report query, OpenAI-adjacent transaction, dashboard aggregation, or finalization transaction can queue unrelated requests.
- At 20 concurrent candidates, heartbeats/answers/evaluations will experience avoidable latency. At 50-100, queueing can look like session drops.

Recommended fix:
- Use PgBouncer/Supabase pooler and set per-instance app pool limits intentionally:
  - Candidate app: `PG_POOL_MAX=5-10`
  - Recruiter app: Prisma `connection_limit=5`, raw pool `max=5`
  - DB-side max connections sized for app instance count plus maintenance margin
- Keep transactions short and avoid remote API calls inside DB transactions.

### High: Finalization transaction performs multiple aggregate reads/writes under one row lock

Impacted file:
- `hireveri-calm/app/lib/interviewCompletion.ts`

Evidence:
- `finalizeInterviewAttempt()` locks the attempt row with `FOR UPDATE`, then performs aggregates, retry sleeps, and multiple writes inside one Prisma transaction.

Impact:
- Idempotency is good, but the lock is held longer than necessary.
- Concurrent completion, termination, reconnect, and watchdog calls for the same attempt will serialize. At scale this is acceptable per-attempt, but retry sleeps inside the transaction increase lock duration.

Recommended fix:
- Split finalization into:
  - transaction A: lock attempt, transition to `COMPLETING`, commit
  - out-of-transaction aggregate reads
  - transaction B: lock attempt, upsert final result, transition to `FINALIZED`
- Keep idempotent result reuse behavior.

### Medium: Recruiter middleware allows any bearer-looking token through to routes

Impacted files:
- `hireveri-recruiter/middleware.ts`
- `hireveri-recruiter/lib/server/auth-context.ts`

Evidence:
- Middleware only checks that a bearer header or auth-looking cookie exists.
- Actual validation happens in route handlers via `getRecruiterRequestContext()`.

Impact:
- Protected page rendering can begin for invalid sessions until route-level data calls fail.
- This is not a data leak if every API uses `getRecruiterRequestContext`, but it increases attack surface and confusing session behavior under multi-login/expired-token scenarios.

Recommended fix:
- Keep middleware lightweight, but avoid treating arbitrary `Authorization: Bearer x` as page-authenticated unless it is a verified app JWT.
- Ensure all protected APIs call `getRecruiterRequestContext`; add a lint/check script for this.

### Medium: Report cache is in-memory per server instance

Impacted file:
- `hireveri-recruiter/lib/server/services/reports.service.ts`

Evidence:
- `reportsCache = new Map()` with 5-second TTL, keyed by organization.

Impact:
- No cross-tenant leak because key includes organization ID.
- Under many organizations or long-running processes, cache can grow with active org count. In serverless, cache consistency varies by instance.

Recommended fix:
- Cap cache size or use Vercel Runtime Cache/Redis for shared dashboard/report caching.
- Add in-flight deduplication like dashboard overview already does.

### Medium: Application websocket layer is effectively absent

Impacted areas:
- `hireveri-calm/app/interview/[token]/page.tsx`
- `hireveri-calm/app/components/calm/core/VideoPanel.tsx`
- `hireveri-calm/app/api/session/signal/route.ts`

Evidence:
- Webcam/audio streaming uses LiveKit.
- Interview state, telemetry, heartbeat, and reconnect are HTTP routes and local timers, not an app websocket channel with scoped rooms.

Impact:
- "Websocket stability" for non-media events cannot be guaranteed because the app does not run a websocket event bus.
- Reconnect is handled via timers, heartbeats, and DB state, which is acceptable but should be tested as HTTP recovery, not socket recovery.

Recommended fix:
- Either document that realtime media is LiveKit and application events are HTTP, or add a scoped websocket/SSE channel keyed by signed `attemptId`.

### Medium: Client recovery/termination state uses shared localStorage keys

Impacted file:
- `hireveri-calm/app/interview/[token]/page.tsx`

Evidence:
- Pending termination/completion/recovery payloads are stored in `window.localStorage`.

Impact:
- Multiple interview tabs in the same browser profile can overwrite pending recovery/termination state unless keys include attempt ID.

Recommended fix:
- Include `attemptId` and token hash in all localStorage keys, or use `sessionStorage` for per-tab state.

### Medium: Expensive report/dashboard queries need indexes

Impacted files:
- `hireveri-recruiter/lib/server/services/reports.service.ts`
- `hireveri-recruiter/app/api/dashboard/*`
- shared schema tables

Recommended indexes are in `hireveri-calm/scripts/concurrency_hardening_indexes.sql`.

### Positive Findings

- Interview attempts have per-interview attempt uniqueness.
- Session questions have unique `(attempt_id, question_order)`.
- Completion is idempotent and uses `ON CONFLICT` for summaries/evaluations/results.
- Recovery events have idempotency keys.
- Recruiter APIs generally scope data by `auth.organizationId`.
- Dashboard/report cache keys include organization ID.
- LiveKit rooms are keyed by attempt ID in the client, which is the right room granularity once token minting is secured.

## Load Testing Plan

Before claiming 20/50/100 support, run staged tests against a production-like environment:

1. 20 candidates for 20 minutes:
   - Start session
   - Join LiveKit
   - Heartbeat every 15 seconds
   - Submit 8 answers
   - Evaluate answers
   - Complete interview
   - Reconnect once per candidate

2. 50 candidates:
   - Same flow
   - Add recruiter dashboard/report polling every 10 seconds from 5 recruiter users

3. 100 candidates:
   - Same flow
   - Include 10 percent abrupt disconnects and recovery links

Acceptance targets:
- p95 API latency under 750 ms for non-AI endpoints.
- p95 answer-save DB time under 250 ms excluding OpenAI cleanup.
- 0 duplicate answer rows by `session_question_id`.
- 0 duplicate attempts per invite beyond allowed recovery policy.
- LiveKit publish connection success above 99 percent.
- DB pool wait p95 under 100 ms.
- Node memory steady after candidate disconnects.

## Required Production Changes

1. Add signed candidate session auth to all calm-room APIs.
2. Lock or remove the fallback session-start path.
3. Add answer idempotency by `session_question_id`.
4. Raise DB pool limits behind PgBouncer/Supabase pooler.
5. Secure LiveKit token minting.
6. Add missing indexes from the SQL script.
7. Run the 20/50/100 test plan and capture p50/p95/p99 metrics.


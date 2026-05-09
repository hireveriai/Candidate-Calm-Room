# TEST_RUN_REPORT

## Run Summary
- generated_at: `2026-05-08T13:08:00Z`
- organization_id: `8cad69fd-80b6-4636-a56f-0a067583d191`
- organization_name: `Codex Reliability 20260508064754`
- recruiter_id: `a14b2391-320a-4c95-ac81-4f656a7c1c8c`
- job_id: `cbd56fd2-273a-45e6-b9cd-42cfa4930da2`
- production_base_url: `http://127.0.0.1:3103`

## Production Validation
- build_ok: `true`
- runtime_ok: `true`
- health_route_ok: `true`
- db_connectivity_ok: `true`
- websocket_token_ok: `true`
- calm_room_load_ok: `true`
- warning: `NODE_TLS_REJECT_UNAUTHORIZED=0 is still present in runtime`

## Candidate A
- candidate_id: `9ba65462-8281-4cb7-aab8-895622e339af`
- interview_id: `a749fdff-4efc-421d-b007-bd92e8966ddd`
- attempt_id: `aa821fe5-4910-4701-ab1f-cff98366f7d6`
- expected_outcome: `HIRE`
- observed_recommendation_before_phase2_fix: `WEAK_CANDIDATE`
- observed_final_score_before_phase2_fix: `15`
- persisted_eval_recompute_reference: `avg_skill_score≈0.85`, `avg_cognitive_score≈0.8083`, `avg_fraud_score≈0.1`
- reconnect_validation: `refresh and reconnect previously restored same attempt/question successfully`
- transcript_integrity: `answers persisted, forensic_transcripts missing`
- recording_integrity_before_fix: `recording row existed in recording state with null ended_at`
- current_status_after_phase2_code: `legacy finalized attempt still requires forced repair re-run on latest prod process to replace stale summary`

## Candidate B
- candidate_id: `ac697594-9807-4a99-a352-539f9a1316c3`
- interview_id: `795a281e-f612-46fb-8f98-60539a7917c1`
- attempt_id: `ee94db36-4162-4b9b-b439-50d7fffac0db`
- expected_outcome: `NO_HIRE`
- observed_recommendation_before_phase2_fix: `NO_HIRE summary existed while attempt was still open`
- observed_failure_before_phase2_fix: `attempt remained started, repeated wrap-up question loop, partial downstream rows created`
- manual_finalization_on_hardened_path: `success`
- hardened_result: `score=20`, `recommendation=WEAK_CANDIDATE`, `questions_answered=8`, `completion_percentage=100`, `reliability_score=100`
- transcript_integrity: `answers persisted, forensic_transcripts missing`
- question_counts: `9 total`, `3 repeated wrap-up style questions observed in pre-hardening run`

## Timing Metrics
- candidate_a_elapsed_seconds: `377`
- candidate_b_elapsed_seconds: `19837`
- ai_latency_evidence: `question creation and answer evaluation events present in structured server logs from earlier real runs`
- completion_latency_status: `candidate_b finalized deterministically on hardened manual completion path`

## Reconnect Events
- candidate_a: `1 persisted interview_recovery_events row confirmed`
- candidate_b: `no reconnect event validated in current rerun`

## Prisma Errors
- historical: `schema drift and hidden foreign key assumptions during real seed/simulation setup`
- fixed_in_phase2: `startup health route now validates schema expectations before runtime`
- still_open: `standalone report script DB auth bootstrap needs one more pass for unattended execution outside Next runtime`

## Completion / Finalization Findings
- fixed: `new deterministic states COMPLETING, FINALIZING, FINALIZED added to app state machine`
- fixed: `DB check constraint mismatch identified as real blocker for live phase2 states`
- fixed: `phase2 schema script now updates chk_interview_attempt_status to allow deterministic states`
- fixed: `finalization now uses transactional recompute from persisted answers/evaluations/transcript evidence/signals`
- fixed: `recording rows are marked completed during finalization when still open`
- residual: `already-finalized legacy corrupted attempts need repair re-run against latest prod process to overwrite stale summaries`

## Transcript Integrity
- candidate_a: `partial integrity only`
- candidate_b: `partial integrity only`
- global_gap: `forensic_transcripts are not yet generated during normal successful interview completion path`

## Runtime Warnings
- `NODE_TLS_REJECT_UNAUTHORIZED=0 weakens production transport security`
- `pg SSL mode warning indicates connection string should move to explicit verify-full or intended libpq-compatible semantics`

## Detected Failures
- aggregate score corruption on candidate A
- stale finalized summary reuse on legacy corrupted attempt
- old DB status constraint blocking phase2 states
- missing forensic transcript persistence in normal completion flow
- repeated-question risk observed in candidate B pre-hardening run

## Recovered Failures
- production build and production runtime validation now pass
- health diagnostics route added and returning green on prod server
- live DB state constraint issue identified and scripted for repair
- candidate B deterministic manual finalization succeeded on hardened code path

## Recommended Next Actions
- rerun a fresh two-candidate prod interview after applying `scripts/phase2_stabilization_schema.sql` to live DB if not already auto-repaired in target environment
- force-repair candidate A finalized attempt on latest hardened prod process to verify high-score hire recommendation recomputes correctly
- persist forensic transcripts during normal answer ingestion, not only recovery path
- remove insecure TLS override from runtime before production signoff

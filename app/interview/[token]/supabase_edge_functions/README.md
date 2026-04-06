# Adaptive Interview Edge Functions

This folder contains Supabase Edge Function files matched to the current DB schema and adaptive SQL functions.

Functions included:

- `upload-resume/index.ts`
- `generate-questions/index.ts`
- `start-session/index.ts`
- `get-first-question/index.ts`
- `submit-answer/index.ts`
- `evaluate-answer/index.ts`
- `get-next-question/index.ts`
- `compute-score/index.ts`

Shared helpers:

- `_shared/common.ts`
- `_shared/openai.ts`

Required secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`

Recommended deployment layout:

```text
supabase/
  functions/
    upload-resume/
      index.ts
    generate-questions/
      index.ts
    start-session/
      index.ts
    get-first-question/
      index.ts
    submit-answer/
      index.ts
    evaluate-answer/
      index.ts
    get-next-question/
      index.ts
    compute-score/
      index.ts
    _shared/
      common.ts
      openai.ts
```

These functions assume the adaptive SQL migration and the two patch scripts have already been applied in the database.

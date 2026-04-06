# Adaptive Interview Edge Functions

This folder contains Supabase Edge Function files matched to the current DB schema and adaptive SQL functions.

Templates included:

- `upload-resume/index.ts.txt`
- `generate-questions/index.ts.txt`
- `start-session/index.ts.txt`
- `get-first-question/index.ts.txt`
- `submit-answer/index.ts.txt`
- `evaluate-answer/index.ts.txt`
- `get-next-question/index.ts.txt`
- `compute-score/index.ts.txt`

Shared helpers:

- `_shared/common.ts.txt`
- `_shared/openai.ts.txt`

Required secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`

Recommended deployment layout after copying and renaming `.ts.txt` to `.ts`:

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

These files are saved as `.ts.txt` on purpose so Next.js does not try to compile them as part of the app build.

Before deploying to Supabase:

1. Copy each file into your `supabase/functions/` folder
2. Rename `.ts.txt` to `.ts`
3. Keep the `_shared` folder alongside the function folders

These functions assume the adaptive SQL migration and the two patch scripts have already been applied in the database.

import assert from "node:assert/strict";
import test from "node:test";

import { isAmbiguousDatabaseColumnError } from "./sessionStartDatabaseError";

test("recognizes PostgreSQL ambiguous-column errors wrapped by Prisma", () => {
  assert.equal(
    isAmbiguousDatabaseColumnError({
      code: "P2010",
      message: "Raw query failed",
      meta: {
        code: "42702",
        message: 'column reference "interview_id" is ambiguous',
      },
    }),
    true
  );
});

test("recognizes ambiguity details embedded in an error message", () => {
  assert.equal(
    isAmbiguousDatabaseColumnError(
      new Error(
        'Raw query failed. Code: `42702`. Message: `column reference "interview_id" is ambiguous`'
      )
    ),
    true
  );
});

test("does not hide unrelated database errors behind the fallback", () => {
  assert.equal(
    isAmbiguousDatabaseColumnError(
      new Error("Raw query failed. Code: `23505`. Unique constraint failed")
    ),
    false
  );
});

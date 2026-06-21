import { prisma } from "@/app/lib/prisma";

type ReadinessSeverity = "info" | "warn" | "error";

type ReadinessIssue = {
  severity: ReadinessSeverity;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
};

type SchemaExpectation = {
  table: string;
  requiredColumns: string[];
  optionalColumns?: string[];
};

type ForeignKeyExpectation = {
  table: string;
  column: string;
  referencesTable: string;
  referencesColumn: string;
};

const REQUIRED_ENV_KEYS = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "NEXT_PUBLIC_LIVEKIT_URL",
] as const;

const REQUIRED_SCHEMA: SchemaExpectation[] = [
  {
    table: "interviews",
    requiredColumns: [
      "interview_id",
      "organization_id",
      "job_id",
      "candidate_id",
      "duration_minutes",
      "question_count",
      "required_follow_up_questions",
      "status",
      "final_status",
    ],
  },
  {
    table: "interview_attempts",
    requiredColumns: [
      "attempt_id",
      "interview_id",
      "status",
      "started_at",
      "ended_at",
      "ends_at",
      "current_phase",
      "questions_answered",
      "expected_questions",
      "completion_percentage",
      "reliability_score",
      "termination_metadata",
      "transcript_status",
      "recording_status",
    ],
  },
  {
    table: "session_questions",
    requiredColumns: [
      "session_question_id",
      "attempt_id",
      "content",
      "question_kind",
      "question_order",
      "asked_at",
    ],
  },
  {
    table: "interview_answers",
    requiredColumns: [
      "answer_id",
      "attempt_id",
      "session_question_id",
      "answer_text",
      "answer_payload",
      "answered_at",
      "status",
    ],
  },
  {
    table: "interview_answer_evaluations",
    requiredColumns: ["evaluation_id", "answer_id", "evaluator_type", "score"],
    optionalColumns: [
      "skill_score",
      "clarity_score",
      "depth_score",
      "confidence_score",
      "fraud_score",
    ],
  },
  {
    table: "interview_summaries",
    requiredColumns: [
      "attempt_id",
      "overall_score",
      "risk_level",
      "hire_recommendation",
    ],
  },
  {
    table: "interview_evaluations",
    requiredColumns: ["attempt_id", "final_score", "decision", "ai_summary"],
  },
  {
    table: "interview_results",
    requiredColumns: [
      "interview_id",
      "best_attempt_id",
      "final_score",
      "result_status",
    ],
  },
  {
    table: "interview_recordings",
    requiredColumns: [
      "attempt_id",
      "egress_id",
      "status",
      "started_at",
      "ended_at",
    ],
  },
  {
    table: "interview_recovery_events",
    requiredColumns: [
      "recovery_event_id",
      "interview_id",
      "attempt_id",
      "event_type",
      "occurred_at",
      "metadata",
    ],
  },
  {
    table: "forensic_transcripts",
    requiredColumns: [
      "transcript_id",
      "attempt_id",
      "segment_index",
      "transcript",
      "sealed",
    ],
  },
];

const REQUIRED_FOREIGN_KEYS: ForeignKeyExpectation[] = [
  {
    table: "interview_attempts",
    column: "interview_id",
    referencesTable: "interviews",
    referencesColumn: "interview_id",
  },
  {
    table: "session_questions",
    column: "attempt_id",
    referencesTable: "interview_attempts",
    referencesColumn: "attempt_id",
  },
  {
    table: "interview_answers",
    column: "attempt_id",
    referencesTable: "interview_attempts",
    referencesColumn: "attempt_id",
  },
  {
    table: "interview_answers",
    column: "session_question_id",
    referencesTable: "session_questions",
    referencesColumn: "session_question_id",
  },
  {
    table: "interview_answer_evaluations",
    column: "answer_id",
    referencesTable: "interview_answers",
    referencesColumn: "answer_id",
  },
  {
    table: "interview_results",
    column: "best_attempt_id",
    referencesTable: "interview_attempts",
    referencesColumn: "attempt_id",
  },
];

const PHASE2_ATTEMPT_STATUSES = [
  "STARTED",
  "CREATED",
  "READY",
  "QUESTION_GENERATING",
  "QUESTION_ACTIVE",
  "ANSWER_RECORDING",
  "ANSWER_PROCESSING",
  "FOLLOWUP_GENERATING",
  "COMPLETING",
  "FINALIZING",
  "FINALIZED",
  "COMPLETED",
  "INTERRUPTED",
  "RECOVERY_ALLOWED",
  "RECOVERY_USED",
  "ABANDONED",
  "FAILED",
  "TIME_EXPIRED",
];

const PHASE2_TERMINATION_TYPES = [
  "completed",
  "manual_exit",
  "browser_close",
  "tab_close",
  "disconnect",
  "timeout",
  "watchdog_timeout",
  "network_disconnect_timeout",
];

let startupDiagnosticsPromise: Promise<ProductionReadinessReport> | null = null;

function issue(
  severity: ReadinessSeverity,
  code: string,
  message: string,
  metadata?: Record<string, unknown>
): ReadinessIssue {
  return {
    severity,
    code,
    message,
    metadata,
  };
}

export async function ensurePhase2SchemaCompatibility() {
  const allowedStatuses = PHASE2_ATTEMPT_STATUSES.map((status) => `'${status}'`).join(", ");
  const allowedTerminationTypes = PHASE2_TERMINATION_TYPES.map(
    (terminationType) => `'${terminationType}'`
  ).join(", ");

  await prisma.$executeRawUnsafe(`
    do $$
    begin
      if exists (
        select 1
        from pg_constraint
        where conname = 'chk_interview_attempt_status'
      ) then
        alter table public.interview_attempts
          drop constraint chk_interview_attempt_status;
      end if;
    end
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    alter table public.interview_attempts
      add constraint chk_interview_attempt_status
      check (upper(status) in (${allowedStatuses}))
  `).catch((error: unknown) => {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("already exists")
    ) {
      return;
    }

    throw error;
  });

  await prisma.$executeRawUnsafe(`
    do $$
    declare
      constraint_definition text;
    begin
      select pg_get_constraintdef(oid)
      into constraint_definition
      from pg_constraint
      where conrelid = 'public.interview_attempts'::regclass
        and conname = 'chk_interview_attempts_termination_type';

      if constraint_definition is null
         or position('completed' in lower(constraint_definition)) = 0
         or position('browser_close' in lower(constraint_definition)) = 0
         or position('watchdog_timeout' in lower(constraint_definition)) = 0
         or position('network_disconnect_timeout' in lower(constraint_definition)) = 0 then
        alter table public.interview_attempts
          drop constraint if exists chk_interview_attempts_termination_type;

        alter table public.interview_attempts
          add constraint chk_interview_attempts_termination_type
          check (
            termination_type is null
            or termination_type in (${allowedTerminationTypes})
          );
      end if;
    end
    $$;
  `);
}

async function checkDatabaseConnectivity() {
  try {
    const rows = await prisma.$queryRaw<Array<{ ok: number }>>`select 1 as ok`;
    return {
      ok: rows[0]?.ok === 1,
      latencyMs: null,
      issues: [] as ReadinessIssue[],
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      issues: [
        issue("error", "db_connection_failed", "Database connectivity check failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ],
    };
  }
}

async function inspectSchema() {
  const issues: ReadinessIssue[] = [];
  const tableList = REQUIRED_SCHEMA.map((item) => `'${item.table}'`).join(", ");

  const columnRows = (await prisma.$queryRawUnsafe(
    `
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (${tableList})
    `
  ).catch(() => [])) as Array<{ table_name: string; column_name: string }>;

  const foreignKeyRows = (await prisma.$queryRawUnsafe(
    `
      select
        tc.table_name,
        kcu.column_name,
        ccu.table_name as foreign_table_name,
        ccu.column_name as foreign_column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name
       and tc.table_schema = kcu.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
       and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY'
        and tc.table_schema = 'public'
    `
  ).catch(() => [])) as Array<{
      table_name: string;
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
    }>;

  const columnMap = new Map<string, Set<string>>();
  for (const row of columnRows) {
    const key = row.table_name.toLowerCase();
    const current = columnMap.get(key) ?? new Set<string>();
    current.add(row.column_name.toLowerCase());
    columnMap.set(key, current);
  }

  for (const schema of REQUIRED_SCHEMA) {
    const availableColumns = columnMap.get(schema.table.toLowerCase()) ?? new Set<string>();

    if (!availableColumns.size) {
      issues.push(
        issue("error", "schema_missing_table", `Required table public.${schema.table} is missing`, {
          table: schema.table,
        })
      );
      continue;
    }

    for (const column of schema.requiredColumns) {
      if (!availableColumns.has(column.toLowerCase())) {
        issues.push(
          issue(
            "error",
            "schema_missing_column",
            `Required column public.${schema.table}.${column} is missing`,
            { table: schema.table, column }
          )
        );
      }
    }

    for (const column of schema.optionalColumns ?? []) {
      if (!availableColumns.has(column.toLowerCase())) {
        issues.push(
          issue(
            "warn",
            "schema_optional_column_missing",
            `Optional compatibility column public.${schema.table}.${column} is missing`,
            { table: schema.table, column }
          )
        );
      }
    }
  }

  for (const expected of REQUIRED_FOREIGN_KEYS) {
    const found = foreignKeyRows.some(
      (row: {
        table_name: string;
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
      }) =>
        row.table_name === expected.table &&
        row.column_name === expected.column &&
        row.foreign_table_name === expected.referencesTable &&
        row.foreign_column_name === expected.referencesColumn
    );

    if (!found) {
      issues.push(
        issue(
          "error",
          "schema_missing_foreign_key",
          `Missing foreign key ${expected.table}.${expected.column} -> ${expected.referencesTable}.${expected.referencesColumn}`,
          expected
        )
      );
    }
  }

  return {
    ok: !issues.some((entry) => entry.severity === "error"),
    issues,
  };
}

function inspectEnvironment() {
  const issues = REQUIRED_ENV_KEYS.flatMap((key) => {
    const value = process.env[key];
    if (value && String(value).trim()) {
      return [];
    }

    return [
      issue("error", "missing_env", `Required environment variable ${key} is missing`, {
        key,
      }),
    ];
  });

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    issues.push(
      issue(
        "warn",
        "tls_verification_disabled",
        "NODE_TLS_REJECT_UNAUTHORIZED is set to 0, which weakens production transport security"
      )
    );
  }

  return {
    ok: !issues.some((entry) => entry.severity === "error"),
    issues,
  };
}

function inspectRealtimeReadiness() {
  const issues: ReadinessIssue[] = [];

  if (!process.env.NEXT_PUBLIC_LIVEKIT_URL || !process.env.LIVEKIT_URL) {
    issues.push(
      issue(
        "error",
        "livekit_url_missing",
        "LiveKit URL configuration is incomplete for browser and server connectivity"
      )
    );
  }

  if (
    process.env.NEXT_PUBLIC_LIVEKIT_URL &&
    process.env.LIVEKIT_URL &&
    !String(process.env.NEXT_PUBLIC_LIVEKIT_URL)
      .toLowerCase()
      .includes(String(process.env.LIVEKIT_URL).replace(/^https?:\/\//i, "").toLowerCase())
  ) {
    issues.push(
      issue(
        "warn",
        "livekit_url_mismatch",
        "Browser LiveKit URL and server LiveKit URL appear to target different hosts"
      )
    );
  }

  return {
    ok: !issues.some((entry) => entry.severity === "error"),
    issues,
  };
}

export type ProductionReadinessReport = {
  ok: boolean;
  generatedAt: string;
  environment: {
    ok: boolean;
    issues: ReadinessIssue[];
  };
  database: {
    ok: boolean;
    latencyMs: number | null;
    issues: ReadinessIssue[];
  };
  schema: {
    ok: boolean;
    issues: ReadinessIssue[];
  };
  realtime: {
    ok: boolean;
    issues: ReadinessIssue[];
  };
  warnings: ReadinessIssue[];
};

export async function getProductionReadinessReport(): Promise<ProductionReadinessReport> {
  await ensurePhase2SchemaCompatibility();
  const [environment, database, schema, realtime] = await Promise.all([
    Promise.resolve(inspectEnvironment()),
    checkDatabaseConnectivity(),
    inspectSchema(),
    Promise.resolve(inspectRealtimeReadiness()),
  ]);

  const warnings = [
    ...environment.issues,
    ...database.issues,
    ...schema.issues,
    ...realtime.issues,
  ].filter((entry) => entry.severity !== "error");

  return {
    ok: environment.ok && database.ok && schema.ok && realtime.ok,
    generatedAt: new Date().toISOString(),
    environment,
    database,
    schema,
    realtime,
    warnings,
  };
}

export function runStartupDiagnostics() {
  if (!startupDiagnosticsPromise) {
    startupDiagnosticsPromise = getProductionReadinessReport()
      .then((report) => {
        console.log(
          JSON.stringify({
            event: "startup.diagnostics",
            ok: report.ok,
            generatedAt: report.generatedAt,
            warnings: report.warnings.map((warning) => warning.code),
          })
        );

        if (!report.ok) {
          console.error(
            JSON.stringify({
              event: "startup.diagnostics_failed",
              report,
            })
          );
        }

        return report;
      })
      .catch((error) => {
        const failure = {
          ok: false,
          generatedAt: new Date().toISOString(),
          environment: { ok: false, issues: [] },
          database: {
            ok: false,
            latencyMs: null,
            issues: [
              issue("error", "startup_diagnostics_failed", "Startup diagnostics crashed", {
                error: error instanceof Error ? error.message : String(error),
              }),
            ],
          },
          schema: { ok: false, issues: [] },
          realtime: { ok: false, issues: [] },
          warnings: [],
        } satisfies ProductionReadinessReport;

        console.error(
          JSON.stringify({
            event: "startup.diagnostics_crashed",
            error: error instanceof Error ? error.message : String(error),
          })
        );
        return failure;
      });
  }

  return startupDiagnosticsPromise;
}

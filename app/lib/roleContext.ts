/**
 * Role context for the runtime interview engine.
 *
 * VerisNova interviews every kind of role, so nothing downstream may assume a
 * candidate is technical. This resolves, from the job itself, whether a role is
 * genuinely technical and which broad family it belongs to. Technical rubrics,
 * technical follow-ups and technical filler wording are only allowed when this
 * says "technical"; everything else gets role-neutral handling.
 *
 * Priority: job title first, then core skills and job description as evidence.
 * A title that names a non-technical function ("Sales", "Teacher", "Recruiter")
 * wins over incidental technical words unless the role's own skills or JD are
 * clearly technical ("Software Sales Manager" stays sales; "Sales Engineer"
 * with SQL/API skills becomes technical).
 *
 * Pure and deterministic: no I/O, no AI.
 */

export type RoleContextKind = "technical" | "non_technical";

export type RoleFamilyHint =
  | "technical"
  | "sales"
  | "marketing"
  | "people"
  | "education"
  | "finance"
  | "healthcare"
  | "customer"
  | "operations"
  | "product"
  | "leadership"
  | "general";

export type RoleContext = {
  kind: RoleContextKind;
  family: RoleFamilyHint;
  reason: string;
};

export type RoleContextInput = {
  jobTitle?: string | null;
  jobDescription?: string | null;
  coreSkills?: Array<string | null | undefined> | null;
};

/** Title words that on their own mean the role is technical. */
const STRONG_TECH_TITLE =
  /\b(software|developer|programmer|dba|database|devops|sre|site reliability|data engineer|data scientist|machine learning|ml engineer|ai engineer|back[- ]?end|front[- ]?end|full[- ]?stack|sdet|qa engineer|qa automation|test automation|cyber ?security|firmware|embedded|sysadmin|systems? administrator|network (engineer|administrator)|it support|cloud engineer)\b/;

/** Title words that suggest a technical role but are shared with other fields. */
const WEAK_TECH_TITLE = /\b(engineer|engineering|architect|technical|technology|cloud|security analyst)\b/;

/**
 * Non-technical function families, checked in order. Leadership is last and is
 * deliberately NOT treated as conflicting with a technical title: "Director of
 * Engineering" is still an engineering role.
 */
const FUNCTION_FAMILIES: Array<{ family: Exclude<RoleFamilyHint, "technical" | "general">; pattern: RegExp }> = [
  { family: "sales", pattern: /\b(sales|business development|bdr|sdr|account executive|account manager|territory manager|pre-?sales)\b/ },
  { family: "marketing", pattern: /\b(marketing|brand|seo|content|communications|public relations|growth|social media|campaign)\b/ },
  { family: "people", pattern: /\b(hr|human resources|people partner|people operations|talent|recruit(er|ing|ment)?|hrbp|payroll|learning and development)\b/ },
  { family: "education", pattern: /\b(teacher|tutor|lecturer|professor|instructor|educator|headteacher|head teacher|teaching|faculty|school|curriculum|trainer)\b/ },
  { family: "finance", pattern: /\b(finance|financial|accountant|accounting|accounts|controller|cfo|treasury|auditor|audit|tax|bookkeep(er|ing)|payable|receivable|fp&a|underwriter|actuar(y|ial))\b/ },
  { family: "healthcare", pattern: /\b(nurse|nursing|doctor|physician|clinical|clinician|pharmacist|therapist|medical|healthcare|caregiver|dentist|paramedic)\b/ },
  { family: "customer", pattern: /\b(customer|client success|client services|client relations|call cent(er|re)|contact cent(er|re)|support agent|support representative|support executive)\b/ },
  { family: "product", pattern: /\b(product manager|product owner|product lead|head of product|product director)\b/ },
  { family: "operations", pattern: /\b(operations|operational|logistics|supply chain|warehouse|procurement|purchasing|facilities|fleet|dispatch|inventory|office manager|office administrator|administrative|coordinator|project manager|program manager|programme manager)\b/ },
  { family: "leadership", pattern: /\b(ceo|coo|managing director|general manager|director|head of|vice president|vp)\b/ },
];

/**
 * Unambiguous technical skill terms used as evidence. Deliberately excludes
 * words that are common outside technology (analytics, networking, excel,
 * performance, reporting, oracle on its own, etc.).
 */
const TECH_EVIDENCE_TERMS = [
  "sql", "pl/sql", "t-sql", "nosql", "python", "java", "javascript", "typescript",
  "react", "angular", "vue", "node", "node.js", ".net", "c#", "c\\+\\+", "golang",
  "rust", "kotlin", "swift", "php", "ruby", "scala", "kubernetes", "docker", "aws",
  "azure", "gcp", "terraform", "linux", "postgres", "postgresql", "mysql",
  "oracle database", "mongodb", "redis", "rest api", "api", "apis", "graphql",
  "microservices", "ci/cd", "git", "spark", "pyspark", "hadoop", "etl", "tensorflow",
  "pytorch", "devops", "database administration", "backup and recovery",
  "query optimization", "performance tuning", "shell scripting", "bash",
  "debugging", "software development", "data pipeline", "data pipelines",
];

const TECH_EVIDENCE_PATTERNS = TECH_EVIDENCE_TERMS.map(
  (term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*?^${}()|[\]]/g, "\\$&")}($|[^a-z0-9])`, "i")
);

function normalize(value: string | null | undefined) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function countTechEvidence(text: string) {
  if (!text) return 0;
  return TECH_EVIDENCE_PATTERNS.filter((pattern) => pattern.test(text)).length;
}

function hasTechnicalEvidence(input: RoleContextInput) {
  const skills = normalize((input.coreSkills ?? []).filter(Boolean).join(" | "));
  const description = normalize(input.jobDescription);
  const skillHits = countTechEvidence(skills);
  const descriptionHits = countTechEvidence(description);
  return {
    technical: skillHits >= 2 || descriptionHits >= 3,
    skillHits,
    descriptionHits,
  };
}

export function resolveRoleContext(input: RoleContextInput): RoleContext {
  const title = normalize(input.jobTitle);
  const strongTech = STRONG_TECH_TITLE.test(title);
  const weakTech = !strongTech && WEAK_TECH_TITLE.test(title);
  const functionMatch = FUNCTION_FAMILIES.find(({ pattern }) => pattern.test(title));
  const conflictingFunction =
    functionMatch && functionMatch.family !== "leadership" ? functionMatch : undefined;

  if ((strongTech || weakTech) && !conflictingFunction) {
    return { kind: "technical", family: "technical", reason: "technical job title" };
  }

  const evidence = hasTechnicalEvidence(input);

  if (conflictingFunction) {
    // A non-technical function in the title, possibly alongside a technical
    // word ("Software Sales Manager", "Sales Engineer", "Technical Recruiter").
    // Only the role's own skills/JD can make it technical.
    if ((strongTech || weakTech) && evidence.technical) {
      return {
        kind: "technical",
        family: "technical",
        reason: `${conflictingFunction.family} title with technical skills/JD`,
      };
    }
    return {
      kind: "non_technical",
      family: conflictingFunction.family,
      reason: `${conflictingFunction.family} job title`,
    };
  }

  if (evidence.technical) {
    return { kind: "technical", family: "technical", reason: "technical skills/JD" };
  }

  return {
    kind: "non_technical",
    family: functionMatch?.family ?? "general",
    reason: functionMatch ? `${functionMatch.family} job title` : "no technical signal",
  };
}

export function isTechnicalRole(input: RoleContextInput) {
  return resolveRoleContext(input).kind === "technical";
}

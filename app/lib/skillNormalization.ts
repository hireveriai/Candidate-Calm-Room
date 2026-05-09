type TechnologyAliasConfig = {
  canonical: string;
  aliases: string[];
  category: string;
};

const TECHNOLOGY_ALIASES: TechnologyAliasConfig[] = [
  {
    canonical: "sql",
    aliases: ["sql", "postgres", "postgresql", "mssql", "ms sql", "sql server", "azure sql", "mysql", "oracle sql"],
    category: "database",
  },
  {
    canonical: "javascript backend",
    aliases: ["node", "nodejs", "node.js", "javascript backend", "server-side javascript"],
    category: "backend",
  },
  {
    canonical: "node backend",
    aliases: ["express", "expressjs", "express.js", "node backend", "rest api backend"],
    category: "backend",
  },
  {
    canonical: "frontend javascript",
    aliases: ["react", "reactjs", "react.js", "frontend javascript", "frontend js"],
    category: "frontend",
  },
  {
    canonical: "data engineering",
    aliases: ["snowflake", "data pipeline", "etl", "elt", "warehouse engineering", "data engineering"],
    category: "data",
  },
  {
    canonical: "python",
    aliases: ["python", "python3"],
    category: "language",
  },
  {
    canonical: "typescript",
    aliases: ["typescript", "ts"],
    category: "language",
  },
  {
    canonical: "cloud infrastructure",
    aliases: ["aws", "azure", "gcp", "cloud infrastructure"],
    category: "cloud",
  },
];

const aliasEntries = TECHNOLOGY_ALIASES.flatMap((config) =>
  config.aliases.map((alias) => ({
    alias: normalizeTechnologyText(alias),
    canonical: config.canonical,
    category: config.category,
  }))
).sort((left, right) => right.alias.length - left.alias.length);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTechnologyText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s/-]/g, " ")
    .replace(/[./_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeTechnologyReferences(value: string | null | undefined) {
  let normalized = normalizeTechnologyText(value);

  if (!normalized) {
    return "";
  }

  for (const entry of aliasEntries) {
    const pattern = new RegExp(`\\b${escapeRegExp(entry.alias)}\\b`, "gi");
    normalized = normalized.replace(pattern, entry.canonical);
  }

  return normalized.replace(/\s+/g, " ").trim();
}

export function extractCanonicalTechnologyTokens(value: string | null | undefined) {
  const normalized = canonicalizeTechnologyReferences(value);

  if (!normalized) {
    return [];
  }

  const tokens = new Set<string>();

  for (const entry of aliasEntries) {
    const pattern = new RegExp(`\\b${escapeRegExp(entry.canonical)}\\b`, "i");
    if (pattern.test(normalized)) {
      tokens.add(entry.canonical);
    }
  }

  return [...tokens];
}

export function technologiesOverlap(left: string | null | undefined, right: string | null | undefined) {
  const leftTokens = new Set(extractCanonicalTechnologyTokens(left));
  const rightTokens = new Set(extractCanonicalTechnologyTokens(right));

  if (!leftTokens.size || !rightTokens.size) {
    return false;
  }

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      return true;
    }
  }

  return false;
}

export function getTechnologyNormalizationConfig() {
  return TECHNOLOGY_ALIASES.map((entry) => ({
    canonical: entry.canonical,
    aliases: [...entry.aliases],
    category: entry.category,
  }));
}

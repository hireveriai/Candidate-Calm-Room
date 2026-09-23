import type { RoleContextKind, RoleFamilyHint } from "./roleContext";

/**
 * Representative jobs used across the role-agnostic tests. Each has a title,
 * a short realistic JD and core skills as a recruiter would enter them.
 */
export type RoleFixture = {
  jobTitle: string;
  jobDescription: string;
  coreSkills: string[];
  expectedKind: RoleContextKind;
  expectedFamily: RoleFamilyHint;
  /** A plausible open-ended questionnaire question for the role. */
  sampleQuestion: string;
  sampleCriteria: string;
};

export const ROLE_FIXTURES: RoleFixture[] = [
  {
    jobTitle: "Software Engineer",
    jobDescription: "Build and maintain backend services and APIs in TypeScript and Node.js on AWS.",
    coreSkills: ["TypeScript", "Node.js", "PostgreSQL", "AWS"],
    expectedKind: "technical",
    expectedFamily: "technical",
    sampleQuestion: "How do you decide where to add caching when an endpoint becomes slow?",
    sampleCriteria: "Explains measuring first, choosing a cache layer and handling invalidation.",
  },
  {
    jobTitle: "Database Administrator",
    jobDescription: "Own availability, backup and recovery, and performance tuning for PostgreSQL and Oracle databases.",
    coreSkills: ["PostgreSQL", "Backup and recovery", "Query optimization", "Replication"],
    expectedKind: "technical",
    expectedFamily: "technical",
    sampleQuestion: "How do you plan a major version upgrade for a busy production database?",
    sampleCriteria: "Covers rehearsal, rollback plan, downtime window and validation.",
  },
  {
    jobTitle: "Sales Manager",
    jobDescription: "Lead a regional sales team, own the pipeline and close enterprise deals.",
    coreSkills: ["Negotiation", "Pipeline management", "Team coaching", "Forecasting"],
    expectedKind: "non_technical",
    expectedFamily: "sales",
    sampleQuestion: "How would you rebuild your pipeline after losing your largest account?",
    sampleCriteria: "Prioritises target accounts, sets activity goals and coaches the team with clear metrics.",
  },
  {
    jobTitle: "Marketing Manager",
    jobDescription: "Plan and run multi-channel campaigns and own brand strategy and marketing performance.",
    coreSkills: ["Campaign management", "Brand strategy", "Marketing analytics", "SEO"],
    expectedKind: "non_technical",
    expectedFamily: "marketing",
    sampleQuestion: "What is your strategy when a launch campaign is underperforming halfway through?",
    sampleCriteria: "Uses results data to diagnose the channel, reallocates budget and sets a measurable target.",
  },
  {
    jobTitle: "HR Manager",
    jobDescription: "Manage employee relations, performance management and HR policy for 300 staff.",
    coreSkills: ["Employee relations", "Performance management", "HR policy", "Recruitment"],
    expectedKind: "non_technical",
    expectedFamily: "people",
    sampleQuestion: "How do you handle a manager who keeps ignoring the disciplinary policy?",
    sampleCriteria: "Balances policy with fairness, documents the process and involves the right people.",
  },
  {
    jobTitle: "Finance Manager",
    jobDescription: "Own budgeting, monthly close, forecasting and financial reporting to the leadership team.",
    coreSkills: ["Budgeting", "Financial reporting", "Forecasting", "Month-end close"],
    expectedKind: "non_technical",
    expectedFamily: "finance",
    sampleQuestion: "How would you respond when actual spend is running well ahead of budget?",
    sampleCriteria: "Identifies the drivers, informs stakeholders early and proposes corrective actions.",
  },
  {
    jobTitle: "Product Manager",
    jobDescription: "Own the product roadmap, prioritise features with engineering and design, and measure outcomes.",
    coreSkills: ["Roadmapping", "Prioritisation", "Stakeholder management", "User research"],
    expectedKind: "non_technical",
    expectedFamily: "product",
    sampleQuestion: "How would you build a roadmap when sales and engineering want different things?",
    sampleCriteria: "Uses evidence and outcomes to prioritise and communicates the trade-offs clearly.",
  },
  {
    jobTitle: "Teacher",
    jobDescription: "Plan and deliver lessons, assess student progress and manage a secondary classroom.",
    coreSkills: ["Lesson planning", "Classroom management", "Student assessment", "Differentiation"],
    expectedKind: "non_technical",
    expectedFamily: "education",
    sampleQuestion: "How do you adapt a lesson when several students are clearly lost halfway through?",
    sampleCriteria: "Checks understanding, re-explains differently and supports students without losing the class.",
  },
  {
    jobTitle: "Customer Success Manager",
    jobDescription: "Own onboarding, adoption and renewals for a portfolio of B2B customers.",
    coreSkills: ["Customer onboarding", "Renewals", "Account health", "Stakeholder management"],
    expectedKind: "non_technical",
    expectedFamily: "customer",
    sampleQuestion: "What do you do when a key customer's usage drops sharply before renewal?",
    sampleCriteria: "Investigates the cause with the customer, builds a recovery plan and tracks adoption.",
  },
  {
    jobTitle: "Operations Manager",
    jobDescription: "Run daily operations, scheduling, vendor coordination and service levels for the site.",
    coreSkills: ["Scheduling", "Vendor management", "SLA management", "Process improvement"],
    expectedKind: "non_technical",
    expectedFamily: "operations",
    sampleQuestion: "How would you improve a process that keeps missing its service level?",
    sampleCriteria: "Maps the process, finds the bottleneck with data and implements a measurable fix.",
  },
];

/** Wording that must never appear in a filler question for a non-technical role. */
export const TECHNICAL_FILLER_PATTERN =
  /\b(production|debug|debugging|deploy|release|releasing|sql|code|coding|programming|outage|incident|what broke|at scale|troubleshoot)\b/i;

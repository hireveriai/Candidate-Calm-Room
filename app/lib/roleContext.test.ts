import assert from "node:assert/strict";
import test from "node:test";

import { resolveRoleContext } from "./roleContext";
import { ROLE_FIXTURES } from "./roleFixtures.testdata";

for (const role of ROLE_FIXTURES) {
  test(`role context: ${role.jobTitle} is ${role.expectedKind}`, () => {
    const context = resolveRoleContext(role);
    assert.equal(context.kind, role.expectedKind, context.reason);
    assert.equal(context.family, role.expectedFamily, context.reason);
  });
}

test("role context: title alone is enough for the required roles", () => {
  for (const role of ROLE_FIXTURES) {
    assert.equal(
      resolveRoleContext({ jobTitle: role.jobTitle }).kind,
      role.expectedKind,
      role.jobTitle
    );
  }
});

test("role context: a non-technical function wins over an incidental technical word", () => {
  assert.equal(
    resolveRoleContext({
      jobTitle: "Software Sales Manager",
      coreSkills: ["Negotiation", "CRM", "Pipeline management", "Enterprise accounts"],
    }).kind,
    "non_technical"
  );
  assert.equal(resolveRoleContext({ jobTitle: "Technical Recruiter" }).kind, "non_technical");
});

test("role context: a mixed title becomes technical only with technical skills", () => {
  assert.equal(resolveRoleContext({ jobTitle: "Sales Engineer" }).kind, "non_technical");
  assert.equal(
    resolveRoleContext({
      jobTitle: "Sales Engineer",
      coreSkills: ["REST API", "SQL", "Python", "Solution demos"],
    }).kind,
    "technical"
  );
});

test("role context: non-technical skills that look technical do not flip a role", () => {
  // "performance management", "reporting", "analytics" and "Excel" are common
  // outside technology and must not be treated as technical evidence.
  const context = resolveRoleContext({
    jobTitle: "HR Manager",
    coreSkills: ["Performance management", "HR analytics", "Excel reporting", "Backup staffing"],
  });
  assert.equal(context.kind, "non_technical");
});

test("role context: leadership titles do not override an engineering title", () => {
  assert.equal(resolveRoleContext({ jobTitle: "Director of Engineering" }).kind, "technical");
});

test("role context: an ambiguous title is decided by skills and JD", () => {
  assert.equal(
    resolveRoleContext({
      jobTitle: "Analyst",
      coreSkills: ["SQL", "Python", "ETL"],
    }).kind,
    "technical"
  );
  assert.equal(
    resolveRoleContext({ jobTitle: "Analyst", coreSkills: ["Market research", "Excel"] }).kind,
    "non_technical"
  );
});

test("role context: empty input is non-technical, never assumed technical", () => {
  assert.deepEqual(resolveRoleContext({}).kind, "non_technical");
});

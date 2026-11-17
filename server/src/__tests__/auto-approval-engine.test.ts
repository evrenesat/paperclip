import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, heartbeatRuns, issues, toolPolicies, agents, companies, type Db as DbClient } from "@paperclipai/db";
import type { ToolAccessDecisionInput } from "@paperclipai/shared";
import {
  matchFloor,
  reviewAutoApproval,
  resolveFloorTarget,
  toolFloorMatches,
  type FloorClass,
  type FloorProbe,
} from "../services/tool-access/auto-approval.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TOOL_POLICY_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestCase = {
  id: string;
  src: string;
  tool: string;
  args: string;
  task: string;
  label: "auto" | "ask";
  why: string;
};

type AdversarialCase = {
  id: string;
  kind: string;
  tool: string;
  args: string | Record<string, unknown>;
  riskLevel: string;
  providerType: string;
  expectFloor: FloorClass | null;
};

const TEST_SET: TestCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/auto-approval-testset.json", import.meta.url), "utf8"),
);
const ADVERSARIAL_SET: AdversarialCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/auto-approval-adversarial.json", import.meta.url), "utf8"),
);

const EXPECTED_FLOOR_CLASS: Record<string, FloorClass> = {
  R13: "delete_agent",
  R14: "delete_agent",
  R15: "approval_rules",
  R16: "approval_rules",
  R17: "approval_rules",
  R18: "access_secrets",
  S1: "access_secrets",
  S2: "spend",
  S3: "publishing",
  S4: "unguarded_sql",
  S7: "spend",
  S8: "cross_company",
  S10: "access_secrets",
};

const TOOL_META: Record<string, { riskLevel: string; providerType: string }> = {
  health: { riskLevel: "read", providerType: "paperclip_self" },
  get_agent_config: { riskLevel: "read", providerType: "paperclip_self" },
  board_api_read: { riskLevel: "read", providerType: "paperclip_self" },
  board_api_write: { riskLevel: "destructive", providerType: "paperclip_self" },
  db_write: { riskLevel: "destructive", providerType: "paperclip_self" },
  db_query: { riskLevel: "read", providerType: "paperclip_self" },
  update_agent_config: { riskLevel: "write", providerType: "paperclip_self" },
  pause_agent: { riskLevel: "write", providerType: "paperclip_self" },
  resume_agent: { riskLevel: "write", providerType: "paperclip_self" },
  delete_agent: { riskLevel: "destructive", providerType: "paperclip_self" },
  owner_override_write: { riskLevel: "destructive", providerType: "paperclip_self" },
  clear_agent_error: { riskLevel: "write", providerType: "paperclip_self" },
  dismiss_attention: { riskLevel: "write", providerType: "paperclip_self" },
  archive_from_owner_inbox: { riskLevel: "write", providerType: "paperclip_self" },
  cancel_stale_runs: { riskLevel: "write", providerType: "paperclip_self" },
  "github.merge_pull_request": { riskLevel: "destructive", providerType: "paperclip_github_chat" },
};

function probe(partial: Partial<FloorProbe> & { toolName: string }): FloorProbe {
  const meta = TOOL_META[partial.toolName] ?? { riskLevel: "write", providerType: "paperclip_self" };
  return {
    upstreamToolName: null,
    providerType: meta.providerType,
    riskLevel: meta.riskLevel,
    args: null,
    sessionCompanyId: "company-a",
    target: { kind: "not_applicable" },
    ...partial,
  };
}

function firstClass(matches: ReturnType<typeof matchFloor>): FloorClass | null {
  return matches[0]?.floorClass ?? null;
}

describe("auto-approval floor matcher (pure)", () => {
  it("floors delete_agent by tool name and by board path, not housekeeping", () => {
    expect(firstClass(matchFloor(probe({ toolName: "delete_agent", args: { agent: "x" } })))).toBe("delete_agent");
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "DELETE /api/agents/4f2c9a1e" })))).toBe("delete_agent");
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "DELETE /api/companies/4f2c9a1e" })))).toBe("delete_agent");
    expect(matchFloor(probe({ toolName: "pause_agent", args: { agent: "x" } }))).toHaveLength(0);
    expect(matchFloor(probe({ toolName: "board_api_write", args: "DELETE /api/issues/4f2c9a1e" }))).toHaveLength(0);
  });

  it("floors approval-rule writes by tool, path and SQL; reads stay free", () => {
    expect(firstClass(matchFloor(probe({ toolName: "owner_override_write", args: "POST /api/companies/c/tools/policies" })))).toBe("approval_rules");
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "PATCH /api/companies/c/tools/trust-rules/1" })))).toBe("approval_rules");
    expect(firstClass(matchFloor(probe({ toolName: "db_write", args: "UPDATE approvals SET status='rejected' WHERE id IN (1); expectedRowCount 1" })))).toBe("approval_rules");
    expect(matchFloor(probe({ toolName: "board_api_read", args: "GET /api/companies/c/approvals?status=pending" }))).toHaveLength(0);
    expect(matchFloor(probe({ toolName: "db_query", args: "SELECT id, status FROM approvals WHERE status='pending'" }))).toHaveLength(0);
  });

  it("floors access and secret changes including reads of adapter env", () => {
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "POST /api/companies/c/agents/1/permissions {canCreateAgents:true}" })))).toBe("access_secrets");
    expect(firstClass(matchFloor(probe({ toolName: "db_query", args: "SELECT name, adapter_config->'env' FROM agents" })))).toBe("access_secrets");
    expect(firstClass(matchFloor(probe({ toolName: "update_agent_config", args: { agent: "x", adapterConfig: { env: { K: "v" } } } })))).toBe("access_secrets");
    expect(matchFloor(probe({ toolName: "update_agent_config", args: { agent: "x", adapterConfig: { model: "modelgate/heavy" } } })).filter((m) => m.floorClass === "access_secrets")).toHaveLength(0);
  });

  it("floors spend paths and non-tier model changes; tier swaps stay free", () => {
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "PATCH /api/companies/c/budgets {monthlyLimitUsd: 500}" })))).toBe("spend");
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "POST /api/companies/c/api-keys {provider:'openai'}" })))).toBe("spend");
    expect(firstClass(matchFloor(probe({ toolName: "update_agent_config", args: { agent: "x", adapterConfig: { model: "openai/gpt-6.1" } } })))).toBe("spend");
    expect(matchFloor(probe({ toolName: "update_agent_config", args: { agent: "x", adapterConfig: { model: "modelgate/heavy" } } }))).toHaveLength(0);
    expect(matchFloor(probe({ toolName: "update_agent_config", args: { agent: "x", adapterConfig: { model: "fast" } } }))).toHaveLength(0);
  });

  it("floors publishing by provider tool name and provider type", () => {
    expect(firstClass(matchFloor(probe({ toolName: "github.merge_pull_request", args: { pr: 12 } })))).toBe("publishing");
    expect(firstClass(matchFloor(probe({ toolName: "slack.post_message", providerType: "paperclip_slack_chat", args: { text: "hi" } })))).toBe("publishing");
    expect(firstClass(matchFloor(probe({ toolName: "npm.publish", providerType: "npm", args: { pkg: "x" } })))).toBe("publishing");
    expect(matchFloor(probe({ toolName: "github.comment", args: { body: "ok" } }))).toHaveLength(0);
  });

  it("floors unguarded SQL and keeps guarded writes and additive writes free", () => {
    expect(firstClass(matchFloor(probe({ toolName: "db_write", args: "DELETE FROM issues WHERE status='cancelled'" })))).toBe("unguarded_sql");
    expect(firstClass(matchFloor(probe({ toolName: "db_write", args: "UPDATE issues SET status='x' WHERE status='cancelled'" })))).toBe("unguarded_sql");
    expect(firstClass(matchFloor(probe({ toolName: "db_write", args: "TRUNCATE issues" })))).toBe("unguarded_sql");
    expect(firstClass(matchFloor(probe({ toolName: "db_write", args: "DROP TABLE old_backup" })))).toBe("unguarded_sql");
    expect(matchFloor(probe({ toolName: "db_write", args: "UPDATE issues SET status='archived' WHERE id IN ('4f2c9a1e'); expectedRowCount 1" }))).toHaveLength(0);
    expect(matchFloor(probe({ toolName: "db_write", args: "INSERT INTO issue_comments (body) VALUES ('ok')" }))).toHaveLength(0);
    expect(firstClass(matchFloor(probe({ toolName: "db_query", args: "DELETE FROM issues WHERE id = '4f2c9a1e'" })))).toBe("unguarded_sql");
  });

  it("floors cross-company writes and unresolved write targets", () => {
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "POST /api/companies/other-company-id/skills {name:'w'}" })))).toBe("cross_company");
    expect(firstClass(matchFloor(probe({
      toolName: "board_api_write",
      args: "POST /api/issues/4f2c9a1e/comments {body:'x'}",
      target: { kind: "unresolved" },
    })))).toBe("cross_company");
    expect(matchFloor(probe({
      toolName: "board_api_write",
      args: "POST /api/issues/4f2c9a1e/comments {body:'x'}",
      target: { kind: "same_company", companyId: "company-a" },
    }))).toHaveLength(0);
  });

  it("fails closed on unparseable generic tool arguments", () => {
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: { foo: "bar" } })))).toBe("unknown");
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "nonsense without a method" })))).toBe("unknown");
    expect(firstClass(matchFloor(probe({ toolName: "db_write", args: { not: "sql" } })))).toBe("unguarded_sql");
  });

  it("normalizes paths before matching", () => {
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "POST /api/companies/c//tools/../tools/policies", sessionCompanyId: "c" })))).toBe("approval_rules");
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "DELETE /api/%61gents/4f2c9a1e" })))).toBe("delete_agent");
    expect(firstClass(matchFloor(probe({ toolName: "board_api_write", args: "PATCH /API/COMPANIES/c/Tools/Policies/abc?dryRun=true", sessionCompanyId: "c" })))).toBe("approval_rules");
    expect(matchFloor(probe({ toolName: "board_api_write", args: "POST /api/companies/c/policies-notes", sessionCompanyId: "c" }))).toHaveLength(0);
  });
});

describeEmbeddedPostgres("auto-approval engine harness", () => {
  let db!: DbClient;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seed!: {
    companyId: string;
    otherCompanyId: string;
    agentId: string;
    issueId: string;
    otherIssueId: string;
    runId: string;
  };

  async function createCompany(name: string) {
    return db.insert(companies).values({
      name,
      issuePrefix: `AA${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
  }

  beforeAll(async () => {
    if (externalDatabaseUrl) db = createDb(externalDatabaseUrl);
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-auto-approval-");
      db = createDb(tempDb.connectionString);
    }
    const company = await createCompany("Auto approval session");
    const otherCompany = await createCompany("Auto approval other");
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: `Runner ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    for (const name of ["OpenCode · p100", "Codex · p100", "Pi · p100", "Codex · Mac", "Opus"]) {
      await db.insert(agents).values({
        companyId: company.id,
        name,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: `Auto approval issue ${randomUUID()}`,
      status: "in_progress",
    }).returning();
    const [otherIssue] = await db.insert(issues).values({
      companyId: otherCompany.id,
      title: `Auto approval other issue ${randomUUID()}`,
      status: "in_progress",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent!.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: {},
    }).returning();
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "broad allow (floor harness)",
      policyType: "allow",
      selectors: {},
      priority: 1000,
    });
    seed = {
      companyId: company.id,
      otherCompanyId: otherCompany.id,
      agentId: agent!.id,
      issueId: issue!.id,
      otherIssueId: otherIssue!.id,
      runId: run!.id,
    };
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  function decisionInput(toolName: string, args: unknown): ToolAccessDecisionInput {
    const meta = TOOL_META[toolName] ?? { riskLevel: "write", providerType: "paperclip_self" };
    return {
      companyId: seed.companyId,
      actor: { actorType: "agent", actorId: seed.agentId, agentId: seed.agentId },
      runContext: {
        heartbeatRunId: null,
        originatingAgentId: null,
        issueId: null,
        projectId: null,
        gatewayId: null,
        gatewayTokenId: null,
      },
      request: {
        toolName,
        applicationId: null,
        applicationKey: null,
        connectionId: null,
        catalogEntryId: null,
        providerType: meta.providerType,
        upstreamToolName: toolName,
        riskLevel: meta.riskLevel as never,
        arguments: args,
        idempotencyKey: null,
        sideEffecting: meta.riskLevel !== "read",
      },
      consumeRateLimit: false,
    };
  }

  function rewriteArgs(args: string): string {
    return args
      .replaceAll("{c}", seed.companyId)
      .replaceAll("{issueId}", seed.issueId)
      .replaceAll("{otherIssueId}", seed.otherIssueId)
      .replaceAll("{agentId}", seed.agentId)
      .replaceAll("EVR-227", seed.issueId)
      .replaceAll("71c0c103", seed.runId);
  }

  it("28-case test set: zero unsafe misses and correct floor classes through decide + review", async () => {
    const misses: string[] = [];
    const classMismatches: string[] = [];
    const needlessCards: string[] = [];
    for (const testCase of TEST_SET) {
      const input = decisionInput(testCase.tool, rewriteArgs(testCase.args));
      const service = toolAccessPolicyService(db);
      const decided = await service.decide(input);
      const reviewed = await reviewAutoApproval(db, input, decided);
      const floor = (reviewed.policyExplanation as Record<string, unknown> | null)?.autoApprovalFloor as
        | { source?: string }
        | undefined;
      const resolvedClass = floor?.source?.replace("floor:", "") ?? null;
      if (testCase.label === "ask" && reviewed.decision !== "require_approval") {
        misses.push(`${testCase.id} resolved ${reviewed.decision}`);
      }
      const expectedClass = EXPECTED_FLOOR_CLASS[testCase.id] ?? null;
      if (expectedClass !== resolvedClass) {
        classMismatches.push(`${testCase.id} expected ${expectedClass} got ${resolvedClass}`);
      }
      if (testCase.label === "auto" && testCase.id !== "R12" && reviewed.decision !== "allow") {
        needlessCards.push(`${testCase.id} resolved ${reviewed.decision} (${resolvedClass ?? "no floor"})`);
      }
    }
    expect(misses).toEqual([]);
    expect(classMismatches).toEqual([]);
    expect(needlessCards).toEqual([]);
  });

  it("adversarial fixture: normalization, fail-closed SQL, cross-company resolution", async () => {
    const failures: string[] = [];
    for (const adversarial of ADVERSARIAL_SET) {
      const args = typeof adversarial.args === "string" ? rewriteArgs(adversarial.args) : adversarial.args;
      const input = decisionInput(adversarial.tool, args);
      const matches = await toolFloorMatches(db, {
        toolName: adversarial.tool,
        upstreamToolName: adversarial.tool,
        providerType: adversarial.providerType,
        riskLevel: adversarial.riskLevel,
        parameters: args,
        sessionCompanyId: seed.companyId,
      });
      const resolvedClass = firstClass(matches);
      if (resolvedClass !== adversarial.expectFloor) {
        failures.push(`${adversarial.id} (${adversarial.kind}) expected ${adversarial.expectFloor} got ${resolvedClass}: ${JSON.stringify(matches)}`);
      }
      void input;
    }
    expect(failures).toEqual([]);
  });

  it("cancel-run style calls stay off the formal approval page; floor cases stay on it", async () => {
    const cancelRun = await toolFloorMatches(db, {
      toolName: "board_api_write",
      upstreamToolName: "board_api_write",
      providerType: "paperclip_self",
      riskLevel: "destructive",
      parameters: `POST /api/heartbeat-runs/${seed.runId}/cancel body {}`,
      sessionCompanyId: seed.companyId,
    });
    expect(cancelRun).toEqual([]);
    const deleteAgent = await toolFloorMatches(db, {
      toolName: "delete_agent",
      upstreamToolName: "delete_agent",
      providerType: "paperclip_self",
      riskLevel: "destructive",
      parameters: { agent: "Codex · p100" },
      sessionCompanyId: seed.companyId,
    });
    expect(deleteAgent.length).toBeGreaterThan(0);
  });

  it("review never downgrades and floors flip allow to require_approval", async () => {
    const input = decisionInput("delete_agent", { agent: "Opus" });
    const allowed = {
      decision: "allow" as const,
      allowed: true,
      reasonCode: "allow_policy" as const,
      explanation: "allowed by fixture policy",
      effectiveProfileIds: [],
      matchedPolicyIds: [],
    };
    const reviewed = await reviewAutoApproval(db, input, allowed);
    expect(reviewed.decision).toBe("require_approval");
    expect(reviewed.allowed).toBe(false);
    const denied = { ...allowed, decision: "deny" as const, allowed: false, reasonCode: "deny_policy_block" as const };
    const reviewedDeny = await reviewAutoApproval(db, input, denied);
    expect(reviewedDeny.decision).toBe("deny");
  });

  it("unresolvable write targets fail closed to cross-company", async () => {
    const target = await resolveFloorTarget(db, {
      boardRequest: null,
      toolName: "board_api_write",
      upstreamToolName: "board_api_write",
      sessionCompanyId: seed.companyId,
      args: `POST /api/issues/${randomUUID()}/comments {body:'x'}`,
    });
    expect(target.kind).toBe("unresolved");
    const sameIssue = await resolveFloorTarget(db, {
      boardRequest: null,
      toolName: "board_api_write",
      upstreamToolName: "board_api_write",
      sessionCompanyId: seed.companyId,
      args: `POST /api/issues/${seed.issueId}/comments {body:'x'}`,
    });
    expect(sameIssue.kind).toBe("same_company");
  });
});
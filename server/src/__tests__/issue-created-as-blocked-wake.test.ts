import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  costEvents,
  companySkills,
  executionWorkspaces,
  workspaceOperations,
  heartbeatRunEvents,
  heartbeatRuns,
  agents,
  agentRuntimeState,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { recoveryService } from "../services/recovery/service.js";
import { runningProcesses } from "../adapters/index.ts";
import { logger } from "../middleware/logger.js";
import {
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Created-as-blocked wake test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await import("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres created-as-blocked wake tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dependent created directly as blocked", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-created-blocked-wake-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Fixture owner",
      email: "owner@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    vi.restoreAllMocks();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Created-as-blocked wake test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedScenario() {
    const companyId = randomUUID();
    const shadowAgentId = randomUUID();
    const opusAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Created blocked",
      issuePrefix: `CB${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    await db.insert(agents).values([
      {
        id: shadowAgentId,
        companyId,
        name: "Shadow",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      },
      {
        id: opusAgentId,
        companyId,
        name: "Opus",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      },
    ]);
    return { companyId, shadowAgentId, opusAgentId };
  }

  async function createBlockerAndBlockedDependent(input: {
    companyId: string;
    shadowAgentId: string;
    opusAgentId: string;
  }) {
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: input.companyId,
      title: "Refine the plan",
      status: "todo",
      priority: "high",
      assigneeAgentId: input.shadowAgentId,
      responsibleUserId: "responsible-user",
    });

    const dependent = await issueService(db).create(input.companyId, {
      title: "Plan review (Opus)",
      status: "blocked",
      priority: "high",
      parentId: blockerId,
      blockedByIssueIds: [blockerId],
      assigneeAgentId: input.opusAgentId,
      responsibleUserId: "responsible-user",
      createdByAgentId: input.shadowAgentId,
    });
    return { blockerId, dependentId: dependent.id };
  }

  it("records no blocked transition when an agent creates the task directly as blocked", async () => {
    const f = await seedScenario();
    const { blockerId, dependentId } = await createBlockerAndBlockedDependent(f);
    const [dependent] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependent?.status).toBe("blocked");
    expect(dependent?.blockedTransitionAt).toBeNull();
    expect(dependent?.parentId).toBe(blockerId);
  });

  it("wakes the assigned dependent through the route-time path once the blocker is done", async () => {
    const f = await seedScenario();
    const { blockerId, dependentId } = await createBlockerAndBlockedDependent(f);
    const svc = issueService(db);

    const dependentsBefore = await svc.listWakeableBlockedDependents(blockerId);
    expect(dependentsBefore).toEqual([]);

    await svc.update(blockerId, { status: "done" });

    const dependents = await svc.listWakeableBlockedDependents(blockerId);
    expect(dependents).toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId: f.opusAgentId,
        blockerIssueIds: [blockerId],
        blockedTransitionAt: null,
      }),
    ]);

    const dependent = dependents[0]!;
    const wake = await heartbeat.wakeup(dependent.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: dependent.id,
        resolvedBlockerIssueId: blockerId,
        blockerIssueIds: dependent.blockerIssueIds,
        mutation: "blocker_done",
      },
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: dependent.id,
        blockerIssueIds: dependent.blockerIssueIds,
        blockedTransitionAt: dependent.blockedTransitionAt,
      }),
      requestedByActorType: "system",
      requestedByActorId: "issue_update",
      contextSnapshot: {
        issueId: dependent.id,
        taskId: dependent.id,
        wakeReason: "issue_blockers_resolved",
        source: "issue.blockers_resolved",
        resolvedBlockerIssueId: blockerId,
        blockerIssueIds: dependent.blockerIssueIds,
      },
    });
    expect(wake).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.id));
    expect(run?.status).toBe("succeeded");
  }, 30_000);

  it("backstop heals a created-as-blocked dependent whose only blocker is done", async () => {
    const f = await seedScenario();
    const { blockerId, dependentId } = await createBlockerAndBlockedDependent(f);
    const svc = issueService(db);
    await svc.update(blockerId, { status: "done" });

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({
      companyId: f.companyId,
      issueId: dependentId,
    });

    expect(result).toMatchObject({
      checked: 1,
      healed: 1,
      notReadySkipped: 0,
      existingWakeSkipped: 0,
      selfBlockedSkipped: 0,
      livePathSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
    });
    expect(enqueueWakeup).toHaveBeenCalledWith(
      f.opusAgentId,
      expect.objectContaining({
        reason: "issue_blockers_resolved",
        payload: expect.objectContaining({ issueId: dependentId, resolvedBlockerIssueId: blockerId }),
      }),
    );
  }, 30_000);

  it("periodic backstop enqueues a queued wake for a created-as-blocked dependent", async () => {
    const f = await seedScenario();
    const { blockerId, dependentId } = await createBlockerAndBlockedDependent(f);
    const svc = issueService(db);
    await svc.update(blockerId, { status: "done" });

    const result = await recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
    }).reconcileResolvedDependencyWakeBackstop({
      companyId: f.companyId,
      issueId: dependentId,
    });

    expect(result).toMatchObject({ healed: 1 });
    const wakeRow = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        agentId: agentWakeupRequests.agentId,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, f.companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${dependentId}`,
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(wakeRow).toMatchObject({
      status: expect.stringMatching(/^(queued|claimed)$/),
      agentId: f.opusAgentId,
    });
  }, 30_000);

  it("releases a created-as-blocked dependent once its done blocker's ended run has finalized", async () => {
    const f = await seedScenario();
    const { blockerId, dependentId } = await createBlockerAndBlockedDependent(f);
    const svc = issueService(db);

    const workspaceId = randomUUID();
    const blockerRunId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: f.companyId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared plan workspace",
      status: "active",
    });
    await db.update(issues).set({ executionWorkspaceId: workspaceId })
      .where(eq(issues.id, blockerId));
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId: f.companyId,
      agentId: f.shadowAgentId,
      issueId: blockerId,
      status: "succeeded",
      startedAt: new Date("2026-11-18T15:50:00.000Z"),
      finishedAt: new Date("2026-11-18T15:55:59.000Z"),
    });
    // The run finalized successfully, then a snapshot save of the same run
    // ended after the finalize (copy-back retried during a restart overlap).
    await db.insert(workspaceOperations).values([
      {
        companyId: f.companyId,
        executionWorkspaceId: workspaceId,
        issueId: blockerId,
        heartbeatRunId: blockerRunId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-11-18T15:55:57.000Z"),
        finishedAt: new Date("2026-11-18T15:55:59.000Z"),
      },
      {
        companyId: f.companyId,
        executionWorkspaceId: workspaceId,
        issueId: blockerId,
        heartbeatRunId: blockerRunId,
        phase: "remote_workspace_snapshot",
        status: "succeeded",
        startedAt: new Date("2026-11-18T15:55:58.000Z"),
        finishedAt: new Date("2026-11-18T15:55:59.400Z"),
      },
    ]);

    await db.update(issues).set({
      status: "done",
      completedAt: new Date("2026-11-18T15:55:59.757Z"),
    }).where(eq(issues.id, blockerId));

    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: true,
      pendingFinalizeBlockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
    });
    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([
      expect.objectContaining({ id: dependentId, assigneeAgentId: f.opusAgentId }),
    ]);

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({
      companyId: f.companyId,
      issueId: dependentId,
    });
    expect(result).toMatchObject({ healed: 1, notReadySkipped: 0 });
  }, 30_000);

  it("keeps a created-as-blocked dependent waiting while its done blocker's run is still live", async () => {
    const f = await seedScenario();
    const { blockerId, dependentId } = await createBlockerAndBlockedDependent(f);
    const svc = issueService(db);

    const workspaceId = randomUUID();
    const blockerRunId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: f.companyId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared plan workspace live",
      status: "active",
    });
    await db.update(issues).set({ executionWorkspaceId: workspaceId })
      .where(eq(issues.id, blockerId));
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId: f.companyId,
      agentId: f.shadowAgentId,
      issueId: blockerId,
      status: "running",
      startedAt: new Date("2026-11-18T15:50:00.000Z"),
    });
    await db.insert(workspaceOperations).values({
      companyId: f.companyId,
      executionWorkspaceId: workspaceId,
      issueId: blockerId,
      heartbeatRunId: blockerRunId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-11-18T15:50:10.000Z"),
      finishedAt: new Date("2026-11-18T15:50:11.000Z"),
    });

    await db.update(issues).set({
      status: "done",
      completedAt: new Date("2026-11-18T15:55:59.757Z"),
    }).where(eq(issues.id, blockerId));

    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: false,
      pendingFinalizeBlockerIssueIds: [blockerId],
    });
    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([]);

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({
      companyId: f.companyId,
      issueId: dependentId,
    });
    expect(result).toMatchObject({ healed: 0, notReadySkipped: 1 });
  }, 30_000);

  it("names the reason a held dependent stayed blocked in the backstop log", async () => {
    const f = await seedScenario();
    const { blockerId, dependentId } = await createBlockerAndBlockedDependent(f);
    const svc = issueService(db);

    const workspaceId = randomUUID();
    const blockerRunId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: f.companyId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared plan workspace logged",
      status: "active",
    });
    await db.update(issues).set({ executionWorkspaceId: workspaceId })
      .where(eq(issues.id, blockerId));
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId: f.companyId,
      agentId: f.shadowAgentId,
      issueId: blockerId,
      status: "running",
      startedAt: new Date("2026-11-18T15:50:00.000Z"),
    });
    await db.insert(workspaceOperations).values({
      companyId: f.companyId,
      executionWorkspaceId: workspaceId,
      issueId: blockerId,
      heartbeatRunId: blockerRunId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-11-18T15:50:10.000Z"),
      finishedAt: new Date("2026-11-18T15:50:11.000Z"),
    });
    await db.update(issues).set({
      status: "done",
      completedAt: new Date("2026-11-18T15:55:59.757Z"),
    }).where(eq(issues.id, blockerId));

    const [dependent] = await db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.id, dependentId));

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const logged: Array<Record<string, unknown>> = [];
    const logSpy = vi.spyOn(logger, "info").mockImplementation((obj) => {
      logged.push(obj as Record<string, unknown>);
    });
    try {
      await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({
        companyId: f.companyId,
        issueId: dependentId,
      });
    } finally {
      logSpy.mockRestore();
    }

    const skipEntry = logged.find((entry) =>
      entry.issueId === dependentId && entry.skipReason === "not_ready");
    expect(skipEntry).toMatchObject({
      issueIdentifier: dependent?.identifier ?? null,
      blockerIssueIds: [blockerId],
      pendingFinalizeBlockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      source: "issue_graph_liveness.backstop",
    });
  }, 30_000);
});
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentFocusService } from "../services/agent-focus.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-focus tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

const GRACE_MS = 5 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const HARD_MAX_MS = 8 * 60 * 60 * 1000;

describeEmbeddedPostgres("agent focus (Do now)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase(
      "paperclip-agent-focus-",
    );
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  afterEach(() => {
    runningProcesses.clear();
    vi.restoreAllMocks();
  });

  const FOCUS_CONFIG = {
    agentFocusGraceWindowMs: GRACE_MS,
    agentFocusIdleTimeoutMs: IDLE_MS,
    agentFocusHardMaxMs: HARD_MAX_MS,
  };

  interface SeedOptions {
    agentStatus?: string;
    focusIssueId?: string | null;
    focusStartedAt?: Date | null;
    issueStatus?: string;
    issueAssignee?: string | null;
    runStatus?: "running" | "queued" | "succeeded" | "cancelled" | null;
    runErrorCode?: string | null;
    runFinishedAt?: Date | null;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, issuePrefix };
  }

  async function seedAgent(
    companyId: string,
    options: SeedOptions = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Heavy",
      role: "engineer",
      status: options.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
      focusIssueId: options.focusIssueId ?? null,
      focusStartedAt: options.focusStartedAt ?? null,
    });
    return agentId;
  }

  async function seedIssue(
    companyId: string,
    issuePrefix: string,
    agentId: string,
    number: number,
    options: SeedOptions = {},
  ): Promise<{ id: string; identifier: string }> {
    const issueId = randomUUID();
    const identifier = `${issuePrefix}-${number}`;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${number}`,
      status: options.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: options.issueAssignee === undefined ? agentId : options.issueAssignee,
      responsibleUserId: "responsible-user",
      issueNumber: number,
      identifier,
    });
    return { id: issueId, identifier };
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    status: "running" | "queued" | "succeeded" | "cancelled",
    options: SeedOptions = {},
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      finishedAt: options.runFinishedAt ?? null,
      error: options.runErrorCode ? "cancelled" : null,
      errorCode: options.runErrorCode ?? null,
    });
    await db.update(heartbeatRuns)
      .set({ scopeKind: "issue", issueId })
      .where(eq(heartbeatRuns.id, runId));
    return runId;
  }

  function readPayloadObject(payload: unknown): Record<string, unknown> | null {
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  }

  function buildFocusService(
    heartbeat: ReturnType<typeof heartbeatService>,
  ) {
    return agentFocusService(db, {
      heartbeat,
      issues: issueService(db),
      config: FOCUS_CONFIG,
    });
  }

  async function getRunStatus(runId: string) {
    const run = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
        resultJson: heartbeatRuns.resultJson,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return run;
  }

  async function getAgentRow(agentId: string) {
    return db
      .select({
        focusIssueId: agents.focusIssueId,
        focusStartedAt: agents.focusStartedAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  it("refuses to focus a done issue", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: issueId, identifier: issueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1, {
      issueStatus: "done",
    });
    const focus = buildFocusService(heartbeatService(db));
    await expect(
      focus.focusAgentOnIssue({
        agentId,
        issueId,
        mode: "gracefully",
        actor: { userId: "responsible-user" },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to focus a paused agent", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId, { agentStatus: "paused" });
    const { id: issueId, identifier: issueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);
    const focus = buildFocusService(heartbeatService(db));
    await expect(
      focus.focusAgentOnIssue({
        agentId,
        issueId,
        mode: "gracefully",
        actor: { userId: "responsible-user" },
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "agent_paused" } });
  });

  it("refuses when the issue has an active run by another agent", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const otherAgentId = await seedAgent(companyId);
    const { id: issueId, identifier: issueIdIdentifier } = await seedIssue(companyId, issuePrefix, otherAgentId, 1, {
      issueAssignee: otherAgentId,
    });
    await seedRun(companyId, otherAgentId, issueId, "running");
    const focus = buildFocusService(heartbeatService(db));
    await expect(
      focus.focusAgentOnIssue({
        agentId,
        issueId,
        mode: "gracefully",
        actor: { userId: "responsible-user" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "active_run_other_agent", activeRunAgentId: otherAgentId },
    });
  });

  it("right away cancels other running runs with focus_preempted and no recovery", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: oldIssueId, identifier: oldIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2, {
      issueStatus: "todo",
    });
    const oldRunId = await seedRun(companyId, agentId, oldIssueId, "running");

    const heartbeat = heartbeatService(db);
    const cancelSpy = vi.spyOn(heartbeat, "cancelRun");
    const focus = buildFocusService(heartbeat);
    const result = await focus.focusAgentOnIssue({
      agentId,
      issueId: focusIssueId,
      mode: "right_away",
      actor: { userId: "responsible-user" },
    });

    expect(result.preemptedRunIds).toEqual([oldRunId]);
    expect(cancelSpy).toHaveBeenCalledWith(
      oldRunId,
      expect.stringContaining(focusIssueIdIdentifier),
      expect.objectContaining({
        errorCode: "focus_preempted",
        suppressImmediateRecovery: true,
      }),
    );
    const agentRow = await getAgentRow(agentId);
    expect(agentRow).toMatchObject({ focusIssueId, focusStartedAt: expect.anything() });

    await heartbeat.drainActiveRunExecutions();
    const cancelled = await getRunStatus(oldRunId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.errorCode).toBe("focus_preempted");
  });

  it("gracefully posts the switch comment on the paused issue and defers the cancel to the grace sweep", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: oldIssueId, identifier: oldIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2, {
      issueStatus: "todo",
    });
    const oldRunId = await seedRun(companyId, agentId, oldIssueId, "running");

    const heartbeat = heartbeatService(db);
    const focus = buildFocusService(heartbeat);
    await focus.focusAgentOnIssue({
      agentId,
      issueId: focusIssueId,
      mode: "gracefully",
      note: "Please prioritize the board import.",
      actor: { userId: "responsible-user" },
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oldIssueId));
    const switchComments = comments.filter(
      (comment) =>
        comment.authorType === "system" &&
        (comment.body ?? "").includes(`switch to ${issuePrefix}-2`),
    );
    expect(switchComments).toHaveLength(1);
    expect(switchComments[0]?.body).toContain(
      "Commit and push your WIP, leave a short resume note here, then end the run.",
    );
    expect(switchComments[0]?.body).toContain(
      "Please prioritize the board import.",
    );

    // The old run is still alive inside the grace window.
    await heartbeat.drainActiveRunExecutions();
    expect((await getRunStatus(oldRunId))?.status).toBe("running");

    // After the grace window the sweep cancels it as focus_preempted.
    const cancelSpy = vi.spyOn(heartbeat, "cancelRun");
    await focus.sweepAgentFocus(new Date(Date.now() + GRACE_MS + 1000));
    expect(cancelSpy).toHaveBeenCalledWith(
      oldRunId,
      expect.anything(),
      expect.objectContaining({
        errorCode: "focus_preempted",
        suppressImmediateRecovery: true,
      }),
    );
    await heartbeat.drainActiveRunExecutions();
    expect((await getRunStatus(oldRunId))?.errorCode).toBe("focus_preempted");
  });

  it("does not cancel a run that ended itself inside the grace window", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: oldIssueId, identifier: oldIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2, {
      issueStatus: "todo",
    });
    await seedRun(companyId, agentId, oldIssueId, "succeeded");
    await db
      .update(agents)
      .set({ focusIssueId, focusStartedAt: new Date(Date.now() - 1000) })
      .where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    const cancelSpy = vi.spyOn(heartbeat, "cancelRun");
    const focus = buildFocusService(heartbeat);
    await focus.sweepAgentFocus(new Date(Date.now() + GRACE_MS + 1000));
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("ends the focus when the focused issue reaches a terminal state and resumes paused work", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: pausedIssueId, identifier: pausedIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2);
    await db
      .update(agents)
      .set({ focusIssueId, focusStartedAt: new Date(Date.now() - 60_000) })
      .where(eq(agents.id, agentId));

    // The agent's resume note is its last comment on the paused issue.
    await db.insert(issueComments).values({
      companyId,
      issueId: pausedIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "Resume note: the importer half finished, next run continues at step 3.",
    });

    await db
      .update(issues)
      .set({ status: "in_review" })
      .where(eq(issues.id, focusIssueId));

    const heartbeat = heartbeatService(db);
    const focus = buildFocusService(heartbeat);
    const swept = await focus.sweepAgentFocus();

    expect(swept.endedAgentIds).toEqual([agentId]);
    const agentRow = await getAgentRow(agentId);
    expect(agentRow?.focusIssueId).toBeNull();

    const resumedWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "focus_resumed"),
        ),
      );
    expect(resumedWakes).toHaveLength(1);
    const resumedPayload = readPayloadObject(resumedWakes[0]?.payload);
    expect(resumedPayload?._paperclipWakeContext).toMatchObject({
      issueId: pausedIssueId,
      wakeReason: "focus_resumed",
    });
  });

  it("ends the focus on the idle timeout and on the hard maximum", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);

    // No runs ever started for the focus issue: idle since the focus began.
    await db
      .update(agents)
      .set({ focusIssueId, focusStartedAt: new Date(Date.now() - IDLE_MS - 1000) })
      .where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    const focus = buildFocusService(heartbeat);
    const idleSweep = await focus.sweepAgentFocus();
    expect(idleSweep.endedAgentIds).toEqual([agentId]);
    expect((await getAgentRow(agentId))?.focusIssueId).toBeNull();

    // Hard maximum ends an otherwise active focus.
    await db
      .update(agents)
      .set({ focusIssueId, focusStartedAt: new Date(Date.now() - HARD_MAX_MS - 1000) })
      .where(eq(agents.id, agentId));
    const hardSweep = await focus.sweepAgentFocus();
    expect(hardSweep.endedAgentIds).toEqual([agentId]);
    expect((await getAgentRow(agentId))?.focusIssueId).toBeNull();
  });

  it("ends the focus when the focused issue is reassigned", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const otherAgentId = await seedAgent(companyId);
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);
    await db
      .update(agents)
      .set({ focusIssueId, focusStartedAt: new Date() })
      .where(eq(agents.id, agentId));
    await db
      .update(issues)
      .set({ assigneeAgentId: otherAgentId })
      .where(eq(issues.id, focusIssueId));

    const focus = buildFocusService(heartbeatService(db));
    const swept = await focus.sweepAgentFocus();
    expect(swept.endedAgentIds).toEqual([agentId]);
    expect((await getAgentRow(agentId))?.focusIssueId).toBeNull();
  });

  it("a second Do now replaces the first focus", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: firstFocusId, identifier: firstFocusIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1, {
      issueStatus: "todo",
    });
    const { id: secondFocusId, identifier: secondFocusIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2, {
      issueStatus: "todo",
    });

    const heartbeat = heartbeatService(db);
    const focus = buildFocusService(heartbeat);
    await focus.focusAgentOnIssue({
      agentId,
      issueId: firstFocusId,
      mode: "gracefully",
      actor: { userId: "responsible-user" },
    });
    await heartbeat.drainActiveRunExecutions();

    await focus.focusAgentOnIssue({
      agentId,
      issueId: secondFocusId,
      mode: "gracefully",
      actor: { userId: "responsible-user" },
    });
    await heartbeat.drainActiveRunExecutions();

    const agentRow = await getAgentRow(agentId);
    expect(agentRow?.focusIssueId).toBe(secondFocusId);
  });

  it("gates the queue during focus: only the focused issue starts", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: otherIssueId, identifier: otherIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1, {
      issueStatus: "todo",
    });
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2, {
      issueStatus: "todo",
    });

    // Seed queued runs for both issues, then focus on the second.
    const otherRunId = await seedRun(companyId, agentId, otherIssueId, "queued");
    const focusRunId = await seedRun(companyId, agentId, focusIssueId, "queued");
    await db
      .update(agents)
      .set({ focusIssueId, focusStartedAt: new Date() })
      .where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    // The focused run left the queue; the gated run stays queued.
    const focusRunStatus = (await getRunStatus(focusRunId))?.status;
    expect(focusRunStatus).not.toBe("queued");
    expect(await getRunStatus(otherRunId)).toMatchObject({ status: "queued" });

    // After the focus ends, the gated work can start.
    const focus = buildFocusService(heartbeat);
    await focus.endFocus({ agentId, reason: "owner_ended" });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await getRunStatus(otherRunId))?.status).not.toBe("queued");
  });

  it("ranks the focused issue ahead of other allowed queued work", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: blockerIssueId, identifier: blockerIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1, {
      issueStatus: "todo",
    });
    const { id: focusIssueId, identifier: focusIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2, {
      issueStatus: "todo",
    });
    // The blocker (allowed: it blocks the focus and is assigned to the agent)
    // was queued first, but the focus run must claim the single slot.
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: focusIssueId,
      type: "blocks",
    });
    const blockerRunId = await seedRun(companyId, agentId, blockerIssueId, "queued");
    const focusRunId = await seedRun(companyId, agentId, focusIssueId, "queued");
    await db
      .update(agents)
      .set({ focusIssueId, focusStartedAt: new Date() })
      .where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const focusRun = await getRunStatus(focusRunId);
    const blockerRun = await getRunStatus(blockerRunId);
    expect(focusRun?.status).not.toBe("queued");
    expect(blockerRun?.status).not.toBe("queued");
    // With one slot, the focused run is claimed first; the blocker run only
    // starts after the focus run released the slot (it failed fast, so the
    // queue promoted the blocker afterwards).
    expect(focusRun?.startedAt?.getTime() ?? 0).toBeLessThan(
      blockerRun?.startedAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("resumes paused work oldest first with the agent's last comment as the resume note", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const { id: newerIssueId, identifier: newerIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 1);
    const { id: olderIssueId, identifier: olderIssueIdIdentifier } = await seedIssue(companyId, issuePrefix, agentId, 2);
    await db.insert(issueComments).values({
      companyId,
      issueId: olderIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "Resume note for the older task.",
    });
    await db
      .update(agents)
      .set({ focusIssueId: randomUUID(), focusStartedAt: new Date() })
      .where(eq(agents.id, agentId));

    // Mark updatedAt so "oldest first" is observable.
    await db
      .update(issues)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(issues.id, olderIssueId));

    const focus = buildFocusService(heartbeatService(db));
    const resumed = await focus.endFocus({ agentId, reason: "owner_ended" });
    expect(resumed.ended).toBe(true);
    expect(resumed.resumedIssueIds).toHaveLength(2);

    const resumedRuns = await db
      .select({
        issueId: heartbeatRuns.contextSnapshot,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        ),
      );
    const resumedIssueIds = resumedRuns
      .map((run) => {
        const context = run.issueId as Record<string, unknown> | null;
        return typeof context?.issueId === "string" ? context.issueId : null;
      })
      .filter((id): id is string => id !== null);
    expect(resumedIssueIds).toContain(olderIssueId);
    expect(resumedIssueIds).toContain(newerIssueId);
    // The older issue's wake carries the resume note comment id.
    const olderWake = await db
      .select({ runId: agentWakeupRequests.runId, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "focus_resumed"),
        ),
      );
    expect(olderWake.length).toBeGreaterThanOrEqual(2);
  });
});
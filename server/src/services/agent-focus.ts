import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { hasInteractionContinuationWakeContext } from "./heartbeat/run-preparation.js";
import { steerNativeSession } from "./native-runtime/native-session-executor.js";
import { logActivity } from "./activity-log.js";

export type FocusMode = "gracefully" | "right_away";

export type FocusEndReason =
  | "issue_finished"
  | "owner_ended"
  | "reassigned"
  | "idle_timeout"
  | "hard_max"
  | "replaced";

export type FocusOutcome = "done" | "waiting_for_review" | "blocked" | "ended";

export interface AgentFocusDeps {
  heartbeat: {
    wakeup: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
    cancelRun: (
      runId: string,
      reason?: string,
      options?: Record<string, unknown>,
    ) => Promise<{ status?: string } | null>;
  };
  issues: {
    getById: (id: string) => Promise<typeof issues.$inferSelect | null>;
    update: (id: string, data: Record<string, unknown>) => Promise<unknown>;
    addComment: (
      issueId: string,
      body: string,
      actor: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<{ id: string; body: string }>;
  };
  pauseAgent?: (agentId: string) => Promise<unknown>;
  config: {
    agentFocusGraceWindowMs: number;
    agentFocusIdleTimeoutMs: number;
    agentFocusHardMaxMs: number;
  };
}

export interface FocusStartResult {
  agentId: string;
  focusIssueId: string;
  focusStartedAt: Date;
  mode: FocusMode;
  preemptedRunIds: string[];
  steerAcknowledgedRunIds: string[];
  pausedAgentIds: string[];
}

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const PENDING_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"];

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function runIssueId(run: { contextSnapshot: unknown }): string | null {
  const context = readObject(run.contextSnapshot);
  return (
    readNonEmptyString(context.issueId) ??
    readNonEmptyString(context.taskId)
  );
}

export function focusOutcomeForStatus(status: string): FocusOutcome | null {
  if (status === "done") return "done";
  if (status === "in_review") return "waiting_for_review";
  if (status === "blocked") return "blocked";
  return null;
}

/**
 * Issue ids allowed to start during an active focus: the focused issue, its
 * descendants, blockers assigned to the agent, and the agent's owner-chat
 * conversations. Interaction-answer wakes are allowed regardless of issue.
 */
export async function resolveFocusAdmission(
  db: Db,
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "focusIssueId">,
  candidateIssueIds: string[] = [],
): Promise<{ focusIssueId: string; allowedIssueIds: Set<string> } | null> {
  const focusIssueId = agent.focusIssueId;
  if (!focusIssueId) return null;
  const companyId = agent.companyId;
  const allowed = new Set<string>([focusIssueId]);

  const descendantRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.id} IN (
          WITH RECURSIVE focus_tree(id) AS (
            SELECT ${issues.id} FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${focusIssueId}
            UNION
            SELECT ${issues.id} FROM ${issues}
            JOIN focus_tree ON ${issues.parentId} = focus_tree.id
            WHERE ${issues.companyId} = ${companyId}
          )
          SELECT id FROM focus_tree
        )`,
      ),
    );
  for (const row of descendantRows) allowed.add(row.id);

  const blockerRows = await db
    .select({ blockerIssueId: issueRelations.issueId })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.issueId))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, focusIssueId),
        eq(issues.assigneeAgentId, agent.id),
      ),
    );
  for (const row of blockerRows) allowed.add(row.blockerIssueId);

  const conversationCandidates = candidateIssueIds.filter((id) => !allowed.has(id));
  if (conversationCandidates.length > 0) {
    const conversationRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.conversationAgentId, agent.id),
          inArray(issues.id, conversationCandidates),
        ),
      );
    for (const row of conversationRows) allowed.add(row.id);
  }

  return { focusIssueId, allowedIssueIds: allowed };
}

/** True when a wake/run context may start while the focus is active. */
export function isWakeAllowedDuringFocus(
  admission: { focusIssueId: string; allowedIssueIds: Set<string> },
  contextSnapshot: unknown,
): boolean {
  if (hasInteractionContinuationWakeContext(readObject(contextSnapshot))) {
    return true;
  }
  const issueId =
    readNonEmptyString(readObject(contextSnapshot).issueId) ??
    readNonEmptyString(readObject(contextSnapshot).taskId);
  if (!issueId) return false;
  return admission.allowedIssueIds.has(issueId);
}

function issueRunPredicate(issueId: string) {
  return sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId} or ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issueId})`;
}

async function listAgentActiveRuns(db: Db, agentId: string, companyId: string) {
  return db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );
}

function buildSwitchCommentBody(focusedIdentifier: string, note: string | null) {
  const lines = [
    `The owner asked you to switch to ${focusedIdentifier} now. Commit and push your WIP, leave a short resume note here, then end the run.`,
  ];
  if (note) lines.push("", `> ${note}`);
  return lines.join("\n");
}

async function recordSteerAcknowledgement(
  db: Db,
  runId: string,
  commentId: string,
  turnId: string,
  focusIssueId: string,
) {
  const run = await db
    .select({
      resultJson: heartbeatRuns.resultJson,
      status: heartbeatRuns.status,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run || run.status !== "running") return;
  const result = readObject(run.resultJson);
  await db
    .update(heartbeatRuns)
    .set({
      resultJson: {
        ...result,
        queuedSteeringAcknowledgements: {
          ...readObject(result.queuedSteeringAcknowledgements),
          [commentId]: {
            status: "acknowledged",
            focusIssueId,
            turnId,
            acknowledgedAt: new Date().toISOString(),
          },
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(heartbeatRuns.id, runId));
}

export async function cancelRunForFocusPreemption(
  deps: AgentFocusDeps,
  runId: string,
  focusedIdentifier: string,
  focusIssueId: string,
) {
  return deps.heartbeat.cancelRun(
    runId,
    `Cancelled because the owner asked the agent to switch to ${focusedIdentifier}`,
    {
      errorCode: "focus_preempted",
      suppressImmediateRecovery: true,
      resultJson: {
        focusPreempted: { focusIssueId, focusedIdentifier },
      },
    },
  );
}

export function agentFocusService(db: Db, deps: AgentFocusDeps) {
  /** Focus the agent on one issue, gracefully switching away from other work. */
  async function focusAgentOnIssue(input: {
    agentId: string;
    issueId: string;
    mode: FocusMode;
    note?: string | null;
    pauseAgentIds?: string[];
    actor: { userId?: string | null };
  }): Promise<FocusStartResult> {
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");

    if (agent.status === "paused") {
      throw conflict("The agent is paused", { code: "agent_paused" });
    }
    if (agent.lifecycleState !== "ready") {
      throw conflict("The agent is not ready to run", {
        code: "agent_not_ready",
      });
    }

    const issue = await deps.issues.getById(input.issueId);
    if (!issue || issue.companyId !== agent.companyId) {
      throw notFound("Issue not found");
    }
    if (issue.status === "done" || issue.status === "cancelled") {
      throw conflict(`The issue is ${issue.status}`, {
        code: "issue_not_focusable",
      });
    }

    const issueRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, agent.companyId),
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
          issueRunPredicate(issue.id),
        ),
      );
    const otherAgentRun = issueRuns.find(
      (run) => run.agentId !== agent.id && run.status === "running",
    );
    if (otherAgentRun) {
      throw conflict("The issue has an active run by another agent", {
        code: "active_run_other_agent",
        activeRunAgentId: otherAgentRun.agentId,
      });
    }

    const focusedIdentifier = issue.identifier ?? issue.id;
    const focusedTitle = issue.title ?? focusedIdentifier;
    const now = new Date();

    // A second Do now replaces the first; the previously focused issue is
    // treated like any other in-progress issue afterwards.
    const priorFocusRow = await db
      .select({ focusIssueId: agents.focusIssueId })
      .from(agents)
      .where(and(eq(agents.id, agent.id), isNotNull(agents.focusIssueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (priorFocusRow && priorFocusRow.focusIssueId !== issue.id) {
      await endFocus({ agentId: agent.id, reason: "replaced", actor: input.actor });
    }

    const activeRuns = await listAgentActiveRuns(db, agent.id, agent.companyId);
    const otherRuns = activeRuns.filter((run) => runIssueId(run) !== issue.id);
    const preemptedRunIds: string[] = [];
    const steerAcknowledgedRunIds: string[] = [];

    const switchCommentBody = buildSwitchCommentBody(
      focusedIdentifier,
      input.note ?? null,
    );

    for (const run of otherRuns) {
      if (run.status !== "running") continue;
      const oldRunIssueId = runIssueId(run);
      if (input.mode === "gracefully" && oldRunIssueId) {
        // The switch comment lands on the issue being left, where the agent
        // can wrap up and leave its resume note.
        let comment: { id: string; body: string } | null = null;
        try {
          comment = await deps.issues.addComment(oldRunIssueId, switchCommentBody, {}, {
            authorType: "system",
          });
        } catch {
          comment = null;
        }
        if (comment) {
          try {
            const acknowledgement = await steerNativeSession({
              runId: run.id,
              message: switchCommentBody,
              correlationId: comment.id,
            });
            await recordSteerAcknowledgement(
              db,
              run.id,
              comment.id,
              acknowledgement.turnId,
              issue.id,
            );
            steerAcknowledgedRunIds.push(run.id);
            continue;
          } catch {
            // The adapter cannot be steered; the grace-window sweep cancels it.
          }
        }
      }
      if (input.mode === "right_away") {
        await cancelRunForFocusPreemption(
          deps,
          run.id,
          focusedIdentifier,
          issue.id,
        );
        preemptedRunIds.push(run.id);
      }
    }

    await db
      .update(agents)
      .set({ focusIssueId: issue.id, focusStartedAt: now, updatedAt: now })
      .where(eq(agents.id, agent.id));

    const issueUpdate: Record<string, unknown> = {
      priority: "critical",
      actorUserId: input.actor.userId ?? null,
    };
    if (issue.assigneeAgentId !== agent.id) issueUpdate.assigneeAgentId = agent.id;
    if (issue.status === "backlog") issueUpdate.status = "todo";
    await deps.issues.update(issue.id, issueUpdate);

    const pausedAgentIds: string[] = [];
    for (const pausedAgentId of input.pauseAgentIds ?? []) {
      if (pausedAgentId === agent.id) continue;
      if (pausedAgentIds.includes(pausedAgentId)) continue;
      const target = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, pausedAgentId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!target || target.companyId !== agent.companyId) continue;
      if (!deps.pauseAgent) break;
      await deps.pauseAgent(pausedAgentId);
      pausedAgentIds.push(pausedAgentId);
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: input.actor.userId ?? "board",
      action: "agent.focus_started",
      entityType: "agent",
      entityId: agent.id,
      details: {
        issueId: issue.id,
        issueIdentifier: focusedIdentifier,
        issueTitle: focusedTitle,
        mode: input.mode,
        replacedFocusIssueId: priorFocusRow?.focusIssueId ?? null,
        preemptedRunIds,
        steerAcknowledgedRunIds,
        pausedAgentIds,
      },
    });

    const hasFocusedRun = issueRuns.some(
      (run) => run.agentId === agent.id && runIssueId(run) === issue.id,
    );
    if (!hasFocusedRun) {
      await deps.heartbeat.wakeup(agent.id, {
        manualUserWake: true,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "focus_started",
        requestedByActorType: "user",
        requestedByActorId: input.actor.userId ?? null,
        contextSnapshot: {
          issueId: issue.id,
          wakeReason: "focus_started",
        },
      });
    }

    return {
      agentId: agent.id,
      focusIssueId: issue.id,
      focusStartedAt: now,
      mode: input.mode,
      preemptedRunIds,
      steerAcknowledgedRunIds,
      pausedAgentIds,
    };
  }

  /**
   * End the focus and resume the agent's paused in-progress work, oldest first.
   */
  async function endFocus(input: {
    agentId: string;
    reason: FocusEndReason;
    actor?: { userId?: string | null };
  }): Promise<{
    ended: boolean;
    outcome?: FocusOutcome;
    resumedIssueIds: string[];
  }> {
    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), isNotNull(agents.focusIssueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!agent || !agent.focusIssueId) {
      return { ended: false, resumedIssueIds: [] };
    }
    const focusIssueId = agent.focusIssueId;
    const focusIssue = await deps.issues.getById(focusIssueId);
    const outcome =
      (focusIssue ? focusOutcomeForStatus(focusIssue.status) : null) ?? "ended";

    await db
      .update(agents)
      .set({ focusIssueId: null, focusStartedAt: null, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: input.actor?.userId ? "user" : "system",
      actorId: input.actor?.userId ?? "heartbeat",
      action: "agent.focus_ended",
      entityType: "agent",
      entityId: agent.id,
      details: {
        issueId: focusIssueId,
        issueIdentifier: focusIssue?.identifier ?? focusIssueId,
        outcome,
        reason: input.reason,
      },
    });

    const resumedIssueIds = await resumePausedWork(agent.id, agent.companyId);
    return { ended: true, outcome, resumedIssueIds };
  }

  /**
   * Wake each in-progress issue assigned to the agent that has no active or
   * queued run, oldest first. The resume note is the agent's last comment.
   */
  async function resumePausedWork(agentId: string, companyId: string) {
    const activeRuns = await listAgentActiveRuns(db, agentId, companyId);
    const busyIssueIds = new Set(
      activeRuns
        .map((run) => runIssueId(run))
        .filter((id): id is string => Boolean(id)),
    );

    const pausedIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          eq(issues.status, "in_progress"),
        ),
      )
      .orderBy(issues.updatedAt);
    const resumeIds = pausedIssues
      .map((row) => row.id)
      .filter((id) => !busyIssueIds.has(id));

    for (const issueId of resumeIds) {
      const lastOwnComment = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, issueId),
            eq(issueComments.authorAgentId, agentId),
            eq(issueComments.authorType, "agent"),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(1)
        .then((rows) => rows[0]?.id ?? null);
      await deps.heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "focus_resumed",
        requestedByActorType: "system",
        contextSnapshot: {
          issueId,
          wakeReason: "focus_resumed",
          ...(lastOwnComment ? { wakeCommentId: lastOwnComment } : {}),
        },
      });
    }
    return resumeIds;
  }

  /** Periodic sweep: enforce the grace window and end finished focuses. */
  async function sweepAgentFocus(now = new Date()) {
    const focused = await db
      .select()
      .from(agents)
      .where(isNotNull(agents.focusIssueId));
    if (focused.length === 0) {
      return {
        swept: 0,
        cancelledRunIds: [] as string[],
        endedAgentIds: [] as string[],
      };
    }

    const cancelledRunIds: string[] = [];
    const endedAgentIds: string[] = [];

    for (const agent of focused) {
      if (!agent.focusIssueId || !agent.focusStartedAt) continue;
      const focusIssue = await deps.issues.getById(agent.focusIssueId);
      const focusedIdentifier = focusIssue?.identifier ?? agent.focusIssueId;
      const elapsedMs = now.getTime() - agent.focusStartedAt.getTime();

      const endFocusIfDue = async (reason: FocusEndReason) => {
        const result = await endFocus({ agentId: agent.id, reason });
        if (result.ended) endedAgentIds.push(agent.id);
        return result.ended;
      };

      // Reassignment ends the focus.
      if (focusIssue && focusIssue.assigneeAgentId !== agent.id) {
        await endFocusIfDue("reassigned");
        continue;
      }
      // The focused issue reaching done, in_review or blocked ends the focus.
      // A deleted or cancelled focus target ends it too.
      if (!focusIssue || focusIssue.status === "cancelled" ||
        focusOutcomeForStatus(focusIssue.status)) {
        await endFocusIfDue("issue_finished");
        continue;
      }
      // Hard maximum.
      if (elapsedMs >= deps.config.agentFocusHardMaxMs) {
        await endFocusIfDue("hard_max");
        continue;
      }

      // Grace window: cancel runs that outlived the switch request.
      if (elapsedMs >= deps.config.agentFocusGraceWindowMs) {
        const activeRuns = await listAgentActiveRuns(db, agent.id, agent.companyId);
        for (const run of activeRuns) {
          if (run.status !== "running") continue;
          if (runIssueId(run) === agent.focusIssueId) continue;
          await cancelRunForFocusPreemption(
            deps,
            run.id,
            focusedIdentifier,
            agent.focusIssueId,
          );
          cancelledRunIds.push(run.id);
        }
      }

      // Idle timeout: no running or queued run and no pending wake for the
      // focused issue for the idle timeout duration.
      const focusedRuns = await listAgentActiveRuns(db, agent.id, agent.companyId);
      const hasFocusedRun = focusedRuns.some(
        (run) => runIssueId(run) === agent.focusIssueId,
      );
      if (!hasFocusedRun) {
        const pendingWakeRows = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, agent.id),
              eq(agentWakeupRequests.companyId, agent.companyId),
              inArray(agentWakeupRequests.status, PENDING_WAKE_STATUSES),
              sql`(${agentWakeupRequests.payload} ->> 'issueId' = ${agent.focusIssueId}
                or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${agent.focusIssueId})`,
            ),
          )
          .limit(1);
        if (pendingWakeRows.length === 0) {
          const lastRun = await db
            .select({ finishedAt: heartbeatRuns.finishedAt })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.agentId, agent.id),
                eq(heartbeatRuns.companyId, agent.companyId),
                issueRunPredicate(agent.focusIssueId),
              ),
            )
            .orderBy(desc(heartbeatRuns.finishedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          const idleSince =
            lastRun?.finishedAt?.getTime() ?? agent.focusStartedAt.getTime();
          if (now.getTime() - idleSince >= deps.config.agentFocusIdleTimeoutMs) {
            await endFocusIfDue("idle_timeout");
          }
        }
      }
    }

    return { swept: focused.length, cancelledRunIds, endedAgentIds };
  }

  /** Board GET payload for one agent's focus. */
  async function getAgentFocusState(agentId: string) {
    const agent = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        focusIssueId: agents.focusIssueId,
        focusStartedAt: agents.focusStartedAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    const lastEndedRow = await db
      .select({ details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, agent.companyId),
          eq(activityLog.entityType, "agent"),
          eq(activityLog.entityId, agent.id),
          eq(activityLog.action, "agent.focus_ended"),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const lastEndedDetails = readObject(lastEndedRow?.details);
    const lastEndedIssueId = readNonEmptyString(lastEndedDetails.issueId);
    const lastEnded: {
      at: Date;
      outcome: string;
      issueId: string;
      issueIdentifier: string | null;
    } | null =
      lastEndedRow && lastEndedIssueId
        ? {
            at: lastEndedRow.createdAt,
            outcome: readNonEmptyString(lastEndedDetails.outcome) ?? "ended",
            issueId: lastEndedIssueId,
            issueIdentifier: readNonEmptyString(lastEndedDetails.issueIdentifier),
          }
        : null;
    if (!agent.focusIssueId) return { focus: null, lastEnded };
    const issue = await deps.issues.getById(agent.focusIssueId);
    const activeRun = issue
      ? (
          await db
            .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, agent.companyId),
                inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
                issueRunPredicate(issue.id),
              ),
            )
            .limit(1)
        )[0] ?? null
      : null;
    return {
      focus: {
        issueId: agent.focusIssueId,
        issueIdentifier: issue?.identifier ?? null,
        issueTitle: issue?.title ?? null,
        startedAt: agent.focusStartedAt,
        hasRun: Boolean(activeRun),
      },
      lastEnded,
    };
  }

  return {
    focusAgentOnIssue,
    endFocus,
    sweepAgentFocus,
    getAgentFocusState,
    resumePausedWork,
  };
}
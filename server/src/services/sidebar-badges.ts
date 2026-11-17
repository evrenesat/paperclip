import { and, desc, eq, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns, issues } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { getHeartbeatRunReadDecisions } from "./heartbeat-run-privacy.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Dismissals are written under two spellings: the Inbox writes the entity key
 * (`run:{id}`) and the Decisions close endpoint writes the attention card key
 * (`attention:run:{id}`). Hiding a failed run, approval or join request must
 * work from either surface, so every lookup tries both spellings.
 */
export function dismissalVariants(itemKey: string): string[] {
  return itemKey.startsWith("attention:")
    ? [itemKey, itemKey.slice("attention:".length)]
    : [itemKey, `attention:${itemKey}`];
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: Date | string | null | undefined,
) {
  return dismissalVariants(itemKey).some((key) => {
    const dismissedAt = dismissedAtByKey.get(key);
    if (dismissedAt == null) return false;
    return dismissedAt >= normalizeTimestamp(activityAt);
  });
}

/**
 * A failed run leaves the badge with its card: the Inbox Mine page hides a
 * failure card once the task moved on (done or cancelled, or a later run
 * replaced the failure), so the badge counts only failures that can still be
 * opened. Without this, recovered tasks keep a badge number with no entry.
 * `${candidateCompany}`, `${candidateCreatedAt}` and `${candidateIssueId}`
 * must be the candidate row's own columns (the `ranked_runs` CTE).
 */
function settledIssueCondition(candidateCompany: SQL, candidateCreatedAt: SQL, candidateIssueId: SQL) {
  return sql<boolean>`(
    exists (
      select 1 from ${issues}
      where ${issues.id} = ${candidateIssueId}::uuid
        and ${issues.companyId} = ${candidateCompany}
        and ${issues.status} in ('done', 'cancelled')
    ) or exists (
      select 1 from ${heartbeatRuns} later_run
      where later_run.company_id = ${candidateCompany}
        and later_run.created_at > ${candidateCreatedAt}
        and later_run.issue_id = ${candidateIssueId}::uuid
    )
  )`;
}

export function sidebarBadgeService(db: Db) {
  const authorization = authorizationService(db);
  return {
    get: async (
      companyId: string,
      extra?: {
        currentUserId?: string | null;
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{ id: string; updatedAt: Date | string | null; createdAt: Date | string }>;
        unreadTouchedIssues?: number;
        approvalReadCondition?: SQL<boolean>;
        actor?: AuthorizationActor;
      },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
            extra?.approvalReadCondition,
          ),
        )
        .then((rows) =>
          rows.filter((row) => !isDismissed(extra?.dismissals ?? new Map(), `approval:${row.id}`, row.updatedAt)).length
        );

      const recentRuns = db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          scopeKind: heartbeatRuns.scopeKind,
          issueId: heartbeatRuns.issueId,
          status: heartbeatRuns.status,
          responsibleUserId: heartbeatRuns.responsibleUserId,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(agents.companyId, companyId),
            not(eq(agents.status, "terminated")),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(200)
        .as("recent_runs");

      const observedRuns = db.select({
        id: recentRuns.id,
        companyId: recentRuns.companyId,
        agentId: recentRuns.agentId,
        scopeKind: recentRuns.scopeKind,
        issueId: recentRuns.issueId,
        status: recentRuns.status,
        responsibleUserId: recentRuns.responsibleUserId,
        createdAt: recentRuns.createdAt,
        observedOrder: sql<number>`row_number() over ()`.as("observed_order"),
      }).from(recentRuns).as("observed_runs");
      const rankedRuns = db.select({
        id: observedRuns.id,
        companyId: observedRuns.companyId,
        scopeKind: observedRuns.scopeKind,
        issueId: observedRuns.issueId,
        status: observedRuns.status,
        responsibleUserId: observedRuns.responsibleUserId,
        createdAt: observedRuns.createdAt,
        agentRunRank: sql<number>`row_number() over (partition by ${observedRuns.agentId} order by ${observedRuns.createdAt} desc, ${observedRuns.observedOrder})`.as("agent_run_rank"),
      }).from(observedRuns).as("ranked_runs");
      const mineCondition = extra?.currentUserId === undefined
        ? undefined
        : !extra.currentUserId
          ? sql<boolean>`false`
          : extra.currentUserId === "local-board"
            ? or(eq(rankedRuns.responsibleUserId, "local-board"), isNull(rankedRuns.responsibleUserId), eq(rankedRuns.responsibleUserId, ""))
            : eq(rankedRuns.responsibleUserId, extra.currentUserId);
      const candidates = await db.select({
        id: rankedRuns.id,
        scopeKind: rankedRuns.scopeKind,
        issueId: rankedRuns.issueId,
        createdAt: rankedRuns.createdAt,
      }).from(rankedRuns).where(and(
        eq(rankedRuns.agentRunRank, 1),
        inArray(rankedRuns.status, ["failed", "timed_out"]),
        mineCondition,
        // A task the failure no longer represents (done, cancelled, or replaced
        // by a later run) hides its card in the Inbox; it must not hold a badge.
        sql<boolean>`(${rankedRuns.issueId}::text is null or not ${settledIssueCondition(
          sql`${rankedRuns.companyId}`, sql`${rankedRuns.createdAt}`, sql`${rankedRuns.issueId}`,
        )})`,
      ));
      const failures = candidates.filter((row) =>
        !isDismissed(extra?.dismissals ?? new Map(), `run:${row.id}`, row.createdAt),
      );
      const failedRuns = extra?.actor
        ? (await getHeartbeatRunReadDecisions(db, authorization, extra.actor, failures.map((row) => ({ ...row, companyId })))).filter(Boolean).length
        : failures.length;

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissed(
          extra?.dismissals ?? new Map(),
          `join:${row.id}`,
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}

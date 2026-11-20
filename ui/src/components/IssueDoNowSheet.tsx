import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldQuestion, Zap } from "lucide-react";

import {
  agentsApi,
  type AgentFocusStartResult,
  type AgentFocusState,
} from "@/api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import type { Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { queryKeys } from "@/lib/queryKeys";

export interface IssueDoNowSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  issue: { id: string; identifier: string | null; title: string | null };
  agents: Agent[];
  /** Preferred agent: the issue assignee. */
  defaultAgentId?: string | null;
}

/** Agents that share the same model slot: same adapter type and model id. */
export function sameModelAgentKey(agent: Agent): string {
  const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const model =
    typeof config.model === "string" && config.model
      ? config.model
      : typeof config.provider === "string"
        ? config.provider
        : "";
  return `${agent.adapterType}:${model}`;
}

export function IssueDoNowSheet({
  open,
  onOpenChange,
  companyId,
  issue,
  agents,
  defaultAgentId,
}: IssueDoNowSheetProps) {
  const queryClient = useQueryClient();
  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status !== "terminated"),
    [agents],
  );
  const defaultSelected =
    defaultAgentId ??
    activeAgents.find((agent) => agent.role === "ceo")?.id ??
    activeAgents[0]?.id ??
    null;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    defaultSelected,
  );
  const [mode, setMode] = useState<"gracefully" | "right_away">("gracefully");
  const [note, setNote] = useState("");
  const [pauseAgentIds, setPauseAgentIds] = useState<string[]>([]);

  const selectedAgent =
    activeAgents.find((agent) => agent.id === selectedAgentId) ?? null;

  // Agents currently running on the same model slot as the selected agent.
  const { data: liveCompanyRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: open && !!companyId,
  });
  const runningAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveCompanyRuns ?? []) {
      if (run.agentId && run.status === "running") ids.add(run.agentId);
    }
    return ids;
  }, [liveCompanyRuns]);

  const otherSameModelAgents = useMemo(() => {
    if (!selectedAgent) return [];
    const key = sameModelAgentKey(selectedAgent);
    return activeAgents.filter(
      (agent) =>
        agent.id !== selectedAgent.id &&
        sameModelAgentKey(agent) === key &&
        runningAgentIds.has(agent.id),
    );
  }, [activeAgents, selectedAgent, runningAgentIds]);

  const focusMutation = useMutation<
    AgentFocusStartResult,
    Error & { details?: { code?: string; activeRunAgentId?: string } }
  >({
    mutationFn: () => {
      if (!selectedAgent) throw new Error("Select an agent first");
      return agentsApi.focus(
        selectedAgent.id,
        {
          issueId: issue.id,
          mode,
          note: note.trim() ? note.trim() : null,
          pauseAgentIds: mode === "gracefully" ? pauseAgentIds : pauseAgentIds,
        },
        companyId,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(issue.id),
      });
      onOpenChange(false);
      setNote("");
      setPauseAgentIds([]);
      setMode("gracefully");
    },
  });

  const conflictAgentId =
    focusMutation.error?.details?.code === "active_run_other_agent"
      ? focusMutation.error.details?.activeRunAgentId
      : null;
  const conflictAgent = conflictAgentId
    ? activeAgents.find((agent) => agent.id === conflictAgentId) ?? null
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="sm:max-w-lg sm:mx-auto">
        <SheetHeader>
          <SheetTitle>Do now</SheetTitle>
          <SheetDescription>
            {issue.identifier ?? ""} {issue.title ? `· ${issue.title}` : ""}
            {" — "}the agent drops its current work, gracefully, and starts
            this task. The paused work resumes when it ends.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Agent</span>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={selectedAgentId ?? ""}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              {activeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            {!defaultAgentId && selectedAgent ? (
              <span className="text-xs text-muted-foreground">
                Not assigned to this task; focusing will assign it.
              </span>
            ) : null}
          </label>

          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Mode</span>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="do-now-mode"
                data-testid="do-now-mode-gracefully"
                checked={mode === "gracefully"}
                onChange={() => setMode("gracefully")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Gracefully</span>
                <span className="block text-xs text-muted-foreground">
                  Ask the agent to wrap up; runs that ignore the note are
                  stopped after 5 minutes.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="do-now-mode"
                data-testid="do-now-mode-right-away"
                checked={mode === "right_away"}
                onChange={() => setMode("right_away")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Right away</span>
                <span className="block text-xs text-muted-foreground">
                  Stop the other runs now.
                </span>
              </span>
            </label>
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Note to the agent (optional)</span>
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              data-testid="do-now-note"
              placeholder="Anything the agent should know about the switch"
              maxLength={2000}
            />
          </label>

          {otherSameModelAgents.length > 0 ? (
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">
                Other agents on the same model are running
              </span>
              {otherSameModelAgents.map((agent) => (
                <label key={agent.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid={`do-now-pause-${agent.id}`}
                    checked={pauseAgentIds.includes(agent.id)}
                    onChange={(event) => {
                      setPauseAgentIds((current) =>
                        event.target.checked
                          ? [...current, agent.id]
                          : current.filter((id) => id !== agent.id),
                      );
                    }}
                  />
                  <span>Pause {agent.name} too</span>
                </label>
              ))}
            </div>
          ) : null}

          {focusMutation.error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
            >
              {conflictAgent ? (
                <>
                  {conflictAgent.name} is already running on this task.
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => setSelectedAgentId(conflictAgent.id)}
                  >
                    Focus {conflictAgent.name} instead
                  </Button>
                </>
              ) : (
                focusMutation.error.message
              )}
            </div>
          ) : null}
        </div>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={focusMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            data-testid="do-now-submit"
            onClick={() => focusMutation.mutate()}
            disabled={!selectedAgent || focusMutation.isPending}
          >
            {focusMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === "right_away" ? (
              <Zap className="h-4 w-4" />
            ) : (
              <ShieldQuestion className="h-4 w-4" />
            )}
            Do now
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export type IssueFocusBannerState = NonNullable<AgentFocusState["focus"]>;

/** Banner on the focus target while the agent switches or works on it. */
export function IssueFocusTargetBanner({
  agentName,
  focus,
}: {
  agentName: string;
  focus: IssueFocusBannerState | null;
}) {
  if (!focus) return null;
  return (
    <div
      role="note"
      data-testid="focus-target-banner"
      className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-sm"
    >
      {focus.hasRun
        ? `${agentName} is working on this`
        : `Do now: ${agentName} is switching to this`}
    </div>
  );
}

/** Banner on displaced work: paused for the focus, resumes when it ends. */
export function IssuePausedForFocusBanner({
  focusIdentifier,
  onResume,
  pending,
}: {
  focusIdentifier: string | null;
  onResume: () => void;
  pending?: boolean;
}) {
  return (
    <div
      role="note"
      data-testid="focus-paused-banner"
      className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
    >
      <span>
        Paused for {focusIdentifier ?? "a focused task"}; resumes when it ends
      </span>
      <Button variant="outline" size="sm" onClick={onResume} disabled={pending}>
        Resume now
      </Button>
    </div>
  );
}

/** One-line agent status: "Focused on EVR-156". */
export function AgentFocusStatusLine({
  focus,
}: {
  focus: IssueFocusBannerState | null;
}) {
  if (!focus) return null;
  return (
    <p
      data-testid="agent-focus-status-line"
      className="text-xs text-muted-foreground"
    >
      Focused on {focus.issueIdentifier ?? focus.issueId}
    </p>
  );
}
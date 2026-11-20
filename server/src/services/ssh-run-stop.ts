import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { runSshCommand, type SshCommandResult, type SshConnectionConfig } from "@paperclipai/adapter-utils/ssh";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";

/**
 * Upper bound for one remote stop attempt. The stop is best effort: a host that
 * does not answer must fall back to `pending_cleanup` instead of holding the
 * cancel request open.
 */
export const SSH_RUN_STOP_TIMEOUT_MS = 10_000;
/** Grace period between SIGTERM and SIGKILL for matched process groups. */
export const SSH_RUN_STOP_SETTLE_MS = 5_000;

const SSH_RUN_STOP_MARKER = "paperclip-ssh-run-stop";

export type SshRunStopProof = {
  state: "stopped";
  matchedPidCount: number;
  remainingPidCount: number;
};

export type SshRunStopFailure = Error & {
  code: "ssh_remote_stop_failed";
};

type SshRunStopRunner = (input: {
  config: SshConnectionConfig;
  env: Record<string, string>;
  timeoutMs: number;
}) => Promise<SshCommandResult>;

let overrideRunner: SshRunStopRunner | null = null;

/** Test seam: replace the transport so kill behavior is asserted without a host. */
export function setSshRunStopRunnerForTests(runner: SshRunStopRunner | null): void {
  overrideRunner = runner;
}

export function sshRunStopFailure(message: string): SshRunStopFailure {
  const error = new Error(message) as SshRunStopFailure;
  error.code = "ssh_remote_stop_failed";
  return error;
}

/**
 * Run-scoped stop script. It matches only processes whose environment carries
 * this exact `PAPERCLIP_RUN_ID`, never the shared workspace path, so another
 * run on the same host and directory is untouched. It prints one proof marker
 * and always exits zero: the caller reads `remaining` from the marker, so a
 * `kill` that cannot reach a process is reported as a failed stop rather than
 * mistaken for a transport error.
 */
export function sshRunStopScript(): string {
  return [
    "target=$PAPERCLIP_STOP_RUN_ID",
    'settle_ms=${PAPERCLIP_STOP_SETTLE_MS:-5000}',
    'self_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " ")',
    "matched=0",
    'for envfile in /proc/[0-9]*/environ; do',
    '  [ -r "$envfile" ] || continue',
    '  pid=${envfile#/proc/}',
    "  pid=${pid%/environ}",
    '  [ "$pid" = "$$" ] && continue',
    '  if tr "\\0" "\\n" < "$envfile" 2>/dev/null | grep -qxF "PAPERCLIP_RUN_ID=$target"; then',
    "    matched=$((matched+1))",
    '    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " ")',
    '    if [ -n "$pgid" ] && [ "$pgid" -gt 1 ] 2>/dev/null && [ "$pgid" != "$self_pgid" ]; then',
    '      kill -TERM -"$pgid" 2>/dev/null || true',
    "    else",
    '      kill -TERM "$pid" 2>/dev/null || true',
    "    fi",
    "  fi",
    "done",
    'sleep_ticks=$(( (settle_ms + 199) / 200 ))',
    'i=0; while [ "$i" -lt "$sleep_ticks" ]; do sleep 0.2; i=$((i+1)); done',
    "count_matches() {",
    "  count=0",
    "  for envfile in /proc/[0-9]*/environ; do",
    '    [ -r "$envfile" ] || continue',
    '    pid=${envfile#/proc/}',
    "    pid=${pid%/environ}",
    '    [ "$pid" = "$$" ] && continue',
    '    if tr "\\0" "\\n" < "$envfile" 2>/dev/null | grep -qxF "PAPERCLIP_RUN_ID=$target"; then',
    "      count=$((count+1))",
    '      pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " ")',
    '      if [ -n "$pgid" ] && [ "$pgid" -gt 1 ] 2>/dev/null && [ "$pgid" != "$self_pgid" ]; then',
    '        kill -KILL -"$pgid" 2>/dev/null || true',
    "      else",
    '        kill -KILL "$pid" 2>/dev/null || true',
    "      fi",
    "    fi",
    "  done",
    "}",
    "count_matches",
    "remaining=$count",
    'if [ "$remaining" -gt 0 ]; then sleep 1; count_matches; remaining=$count; fi',
    `printf '${SSH_RUN_STOP_MARKER} matched=%s remaining=%s\\n' "$matched" "$remaining"`,
    "exit 0",
  ].join("\n");
}

function parseSshRunStopProof(stdout: string): SshRunStopProof | null {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${SSH_RUN_STOP_MARKER} `))
    .at(-1);
  if (!line) return null;
  const fields = new Map<string, string>();
  for (const token of line.split(/\s+/).slice(1)) {
    const [key, value] = token.split("=", 2);
    if (key && value !== undefined) fields.set(key, value);
  }
  const matched = Number(fields.get("matched"));
  const remaining = Number(fields.get("remaining"));
  if (!Number.isInteger(matched) || matched < 0) return null;
  if (!Number.isInteger(remaining) || remaining < 0) return null;
  return { state: "stopped", matchedPidCount: matched, remainingPidCount: remaining };
}

/**
 * Stop every remote process that carries this run id, then prove nothing is
 * left. Throws `ssh_remote_stop_failed` when the host cannot be reached, the
 * proof marker is missing, or matched processes survive SIGKILL. The caller
 * must treat a throw as "remote work may still be running".
 */
export async function stopSshRunProcesses(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    lease: Pick<EnvironmentLease, "id" | "provider" | "environmentId">;
    /** Already-loaded row from the release path; a sweep can pass null. */
    environment?: Environment | null;
    timeoutMs?: number;
    settleMs?: number;
  },
): Promise<SshRunStopProof> {
  if (input.lease.provider !== "ssh") {
    throw sshRunStopFailure("Remote stop requires an SSH lease.");
  }
  const fallbackId = input.lease.environmentId;
  const environment = input.environment ?? (fallbackId ? await environmentService(db).getById(fallbackId) : null);
  if (!environment || (fallbackId && environment.id !== fallbackId) || environment.driver !== "ssh") {
    throw sshRunStopFailure("SSH environment is unavailable for this run.");
  }
  const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, environment, {
    heartbeatRunId: input.runId,
    readOnlyInspection: true,
  });
  if (parsed.driver !== "ssh") {
    throw sshRunStopFailure("SSH environment config is unavailable for this run.");
  }
  const settleMs = input.settleMs ?? SSH_RUN_STOP_SETTLE_MS;
  const timeoutMs = input.timeoutMs ?? SSH_RUN_STOP_TIMEOUT_MS + settleMs + 2_000;
  const env = {
    PAPERCLIP_STOP_RUN_ID: input.runId,
    PAPERCLIP_STOP_SETTLE_MS: String(settleMs),
  };
  const result = overrideRunner
    ? await overrideRunner({ config: parsed.config, env, timeoutMs })
    : await runSshCommand(parsed.config, sshRunStopScript(), { env, timeoutMs });
  const proof = parseSshRunStopProof(result.stdout ?? "");
  if (!proof) {
    throw sshRunStopFailure("Remote stop did not confirm which processes it stopped.");
  }
  if (proof.remainingPidCount > 0) {
    throw sshRunStopFailure("Remote processes survived the run-scoped stop.");
  }
  return proof;
}

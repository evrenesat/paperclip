import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import {
  setSshRunStopRunnerForTests,
  sshRunStopScript,
} from "../services/ssh-run-stop.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function runScript(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", sshRunStopScript()], { env });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

function spawnTaggedRun(runId: string) {
  const child = spawn("sh", ["-c", "exec sleep 60"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PAPERCLIP_RUN_ID: runId },
  });
  child.unref();
  return child;
}

describe("ssh run-scoped stop script", () => {
  it("stops every process of one run and leaves another run on the same host alive", async () => {
    const target = `run-${randomUUID()}`;
    const other = `run-${randomUUID()}`;
    const targetChild = spawnTaggedRun(target);
    const otherChild = spawnTaggedRun(other);
    try {
      const readEnviron = async (pid: number) => {
        const { readFile } = await import("node:fs/promises");
        return await readFile(`/proc/${pid}/environ`, "utf8");
      };
      await waitFor(() => targetChild.pid !== undefined && otherChild.pid !== undefined);
      const targetTag = `PAPERCLIP_RUN_ID=${target}\0`;
      let seen = false;
      for (let attempt = 0; attempt < 100 && !seen; attempt += 1) {
        try {
          seen = (await readEnviron(targetChild.pid!)).includes(targetTag);
        } catch {
          seen = false;
        }
        if (!seen) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen).toBe(true);

      const result = await runScript({
        ...process.env,
        PAPERCLIP_STOP_RUN_ID: target,
        PAPERCLIP_STOP_SETTLE_MS: "300",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("paperclip-ssh-run-stop matched=1 remaining=0");
      await waitFor(() => targetChild.exitCode !== null || targetChild.signalCode !== null);
      expect(otherChild.exitCode).toBeNull();
      expect(otherChild.signalCode).toBeNull();
    } finally {
      for (const child of [targetChild, otherChild]) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
        }
      }
    }
  }, 20_000);

  it("fails instead of reporting a clean stop when the remote has no proc filesystem", async () => {
    const result = await runScript({
      ...process.env,
      PAPERCLIP_STOP_RUN_ID: "run-anything",
      PAPERCLIP_STOP_PROC_ROOT: `/nonexistent-${randomUUID()}`,
    });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("paperclip-ssh-run-stop matched=");
  });

  it("fails when no other process environment is readable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-proc-"));
    try {
      await mkdir(path.join(root, "self"));
      await writeFile(path.join(root, "self", "environ"), "PAPERCLIP_RUN_ID=run-anything\0");
      const result = await runScript({
        ...process.env,
        PAPERCLIP_STOP_RUN_ID: "run-anything",
        PAPERCLIP_STOP_PROC_ROOT: root,
      });
      expect(result.code).toBe(5);
      expect(result.stdout).not.toContain("paperclip-ssh-run-stop matched=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describeEmbeddedPostgres("SSH lease release stops remote work", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-run-stop-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    setSshRunStopRunnerForTests(null);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLease(options: {
    metadata?: Record<string, unknown>;
    status?: string;
    leaseStatus?: string;
    cleanupStatus?: string;
    failureReason?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    const leaseId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SshCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "SSH fixture",
      driver: "ssh",
      status: "active",
      config: {
        host: "ssh.example.test",
        username: "fixture",
        remoteWorkspacePath: "/workspace",
        useHostAuth: true,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: options.status ?? "cancelled",
      runtimeMode: "legacy",
      nextEventSeq: 1,
    });
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      environmentId,
      heartbeatRunId: runId,
      status: options.leaseStatus ?? "active",
      leasePolicy: "ephemeral",
      provider: "ssh",
      providerLeaseId: "ssh://ssh.example.test/workspace",
      cleanupStatus: options.cleanupStatus,
      failureReason: options.failureReason,
      metadata: options.metadata ?? {},
    });
    return { companyId, environmentId, runId, leaseId };
  }

  async function leaseRow(leaseId: string) {
    return db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
  }

  it("stops the run's remote processes and records a bound stop receipt", async () => {
    const { runId, leaseId, companyId } = await seedLease();
    const runner = vi.fn(async () => ({
      stdout: "paperclip-ssh-run-stop matched=2 remaining=0\n",
      stderr: "",
    }));
    setSshRunStopRunnerForTests(runner);

    const released = await environmentRuntimeService(db).releaseRunLeases(runId, "expired");
    expect(released).toHaveLength(1);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ PAPERCLIP_STOP_RUN_ID: runId }) }));

    const row = await leaseRow(leaseId);
    expect(row).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(row?.metadata?.remoteExecutionTermination).toMatchObject({
      schema: "paperclip.remote-termination.v1",
      companyId,
      runId,
      leaseId,
      provider: "ssh",
      providerLeaseId: "ssh://ssh.example.test/workspace",
      state: "stopped",
    });
    expect(remoteTerminationReceipt(row!, row?.metadata?.remoteExecutionTermination)).toBeTruthy();
  });

  it("keeps the lease in pending_cleanup when the stop cannot be proven", async () => {
    const { runId, leaseId } = await seedLease();
    setSshRunStopRunnerForTests(async () => {
      throw new Error("ssh unreachable");
    });

    expect(await environmentRuntimeService(db).releaseRunLeases(runId, "expired")).toEqual([]);
    expect(await leaseRow(leaseId)).toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "ssh_remote_stop_failed",
    });
  });

  it("releases a normally completed run without stopping its remote processes", async () => {
    const { runId, leaseId } = await seedLease({ status: "completed" });
    const runner = vi.fn(async () => ({ stdout: "paperclip-ssh-run-stop matched=1 remaining=0\n", stderr: "" }));
    setSshRunStopRunnerForTests(runner);

    expect(await environmentRuntimeService(db).releaseRunLeases(runId, "released")).toHaveLength(1);
    expect(runner).not.toHaveBeenCalled();
    const row = await leaseRow(leaseId);
    expect(row).toMatchObject({ status: "released" });
    expect(row?.metadata?.remoteExecutionTermination).toBeUndefined();
  });

  it("keeps pending_cleanup when the remote exits without a proof marker", async () => {
    const { runId, leaseId } = await seedLease();
    setSshRunStopRunnerForTests(async () => ({ stdout: "stopped\n", stderr: "" }));

    expect(await environmentRuntimeService(db).releaseRunLeases(runId, "expired")).toEqual([]);
    expect(await leaseRow(leaseId)).toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "ssh_remote_stop_failed",
    });
  });

  it("keeps pending_cleanup when a tagged process survives the remote stop", async () => {
    const { runId, leaseId } = await seedLease();
    setSshRunStopRunnerForTests(async () => ({
      stdout: "paperclip-ssh-run-stop matched=1 remaining=1\n",
      stderr: "",
    }));

    expect(await environmentRuntimeService(db).releaseRunLeases(runId, "expired")).toEqual([]);
    expect(await leaseRow(leaseId)).toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "ssh_remote_stop_failed",
    });
  });

  it("retries the remote stop for a pending_cleanup lease and returns a bound stop proof", async () => {
    const { environmentId, runId, leaseId } = await seedLease({
      leaseStatus: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "ssh_remote_stop_failed",
    });
    const runner = vi.fn(async () => ({
      stdout: "paperclip-ssh-run-stop matched=1 remaining=0\n",
      stderr: "",
    }));
    setSshRunStopRunnerForTests(runner);

    const [environment] = await db.select().from(environments).where(eq(environments.id, environmentId));
    const lease = await leaseRow(leaseId);
    expect(lease).not.toBeNull();

    await expect(environmentRuntimeService(db).retryPendingSandboxTeardown({
      environment: (environment ?? null) as Environment | null,
      lease: lease as unknown as EnvironmentLease,
    })).resolves.toEqual({
      providerLeaseId: "ssh://ssh.example.test/workspace",
      state: "stopped",
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ PAPERCLIP_STOP_RUN_ID: runId }) }));
  });

  it("keeps a pending_cleanup lease failed when the retry cannot prove the stop", async () => {
    const { environmentId, leaseId } = await seedLease({
      leaseStatus: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "ssh_remote_stop_failed",
    });
    setSshRunStopRunnerForTests(async () => {
      throw new Error("ssh unreachable");
    });
    const [environment] = await db.select().from(environments).where(eq(environments.id, environmentId));
    const lease = await leaseRow(leaseId);

    await expect(environmentRuntimeService(db).retryPendingSandboxTeardown({
      environment: (environment ?? null) as Environment | null,
      lease: lease as unknown as EnvironmentLease,
    })).rejects.toThrow("ssh unreachable");
    expect(await leaseRow(leaseId)).toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "ssh_remote_stop_failed",
    });
  });

  it("does not repeat a pending_cleanup retry once the lease carries its receipt", async () => {
    const { environmentId, leaseId } = await seedLease({
      leaseStatus: "pending_cleanup",
      cleanupStatus: "failed",
    });
    const row = await leaseRow(leaseId);
    const receipt = remoteTerminationReceipt(row!, {
      providerLeaseId: row!.providerLeaseId,
      state: "stopped",
    });
    await db.update(environmentLeases)
      .set({ metadata: { remoteExecutionTermination: receipt } })
      .where(eq(environmentLeases.id, leaseId));
    const runner = vi.fn(async () => ({ stdout: "paperclip-ssh-run-stop matched=1 remaining=0\n", stderr: "" }));
    setSshRunStopRunnerForTests(runner);
    const [environment] = await db.select().from(environments).where(eq(environments.id, environmentId));
    const lease = await leaseRow(leaseId);

    await expect(environmentRuntimeService(db).retryPendingSandboxTeardown({
      environment: (environment ?? null) as Environment | null,
      lease: lease as unknown as EnvironmentLease,
    })).resolves.toEqual({
      providerLeaseId: "ssh://ssh.example.test/workspace",
      state: "stopped",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not repeat the remote stop when the lease already carries its receipt", async () => {
    const { runId, leaseId } = await seedLease();
    const row = await leaseRow(leaseId);
    const receipt = remoteTerminationReceipt(row!, {
      providerLeaseId: row!.providerLeaseId,
      state: "stopped",
    });
    await db.update(environmentLeases)
      .set({ metadata: { remoteExecutionTermination: receipt } })
      .where(eq(environmentLeases.id, leaseId));
    const runner = vi.fn(async () => ({ stdout: "paperclip-ssh-run-stop matched=1 remaining=0\n", stderr: "" }));
    setSshRunStopRunnerForTests(runner);

    expect(await environmentRuntimeService(db).releaseRunLeases(runId, "expired")).toHaveLength(1);
    expect(runner).not.toHaveBeenCalled();
    expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
  });
});

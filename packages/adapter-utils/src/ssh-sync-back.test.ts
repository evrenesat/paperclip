import { mkdtemp, readFile, rm, stat, truncate, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";

// The remote commands run locally: the sync-back tar script rides the ssh
// argv tail and the helper commands ride the SSH_STDIN_COMMAND base64 eval,
// so rewriting the ssh argv tail into `sh -c` executes the "remote" side in
// this process's fixture directories.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.execFile("sh", ["-c", args.at(-1)!], options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") return actual.spawn(file, args, options);
      const script = args.at(-1)!;
      const override = tarScriptOverride(script);
      return actual.spawn("sh", ["-c", override ?? script], options);
    }),
  };
});

import {
  classifySshSyncBackTarFailure,
  restoreWorkspaceFromSshExecution,
  SSH_SYNC_BACK_MAX_FILE_BYTES,
  syncDirectoryFromSsh,
  type SshSyncBackFailureTolerance,
} from "./ssh.js";

const roots: string[] = [];
let tarOverride: ((script: string) => string) | null = null;

beforeEach(async () => {
  // The merge lock root resolves under PAPERCLIP_HOME; keep the fixture
  // self-contained instead of touching the host's instance directory.
  const home = await mkdtemp(path.join(os.tmpdir(), "ssh-sync-back-home-"));
  roots.push(home);
  vi.stubEnv("PAPERCLIP_HOME", path.join(home, "home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "sync-back-test");
});

function tarScriptOverride(script: string): string | null {
  if (!script.includes("'-cf' '-'") && !script.includes("-cf - .")) return null;
  return tarOverride ? tarOverride(script) : null;
}

// Builds a remote tar script that ships a valid one-file archive, prints one
// tar stderr line, and exits with the given code — the deterministic stand-in
// for a remote tree that changed or lost files mid-read.
function failingRemoteTar(script: string, stderrLine: string, exitCode: number): string {
  // The sync-back script rides inside `sh -c '<script>'`, so its own quotes
  // arrive shell-quote escaped; undo that before reusing the cd prefix.
  const raw = /cd (.*?) && tar/.exec(script)?.[1];
  const cd = raw ? raw.replaceAll(`'"'"'`, `'`) : `'.'`;
  return `cd ${cd} && tar -c -f - ./keep.txt; printf '%s\\n' '${stderrLine}' >&2; exit ${exitCode}`;
}

function spec(remoteCwd: string) {
  return {
    host: "fixture.invalid",
    username: "fixture",
    port: 22,
    remoteCwd,
    remoteWorkspacePath: remoteCwd,
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  } as const;
}

async function makeRoot(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `ssh-sync-back-${label}-`));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  tarOverride = null;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("classifySshSyncBackTarFailure", () => {
  it("tolerates changed-file warnings under every non-strict tolerance", () => {
    const stderr = "tar: ./temp/build/node_modules/.pnpm: file changed as we read it\n";
    for (const tolerance of ["warnings", "warningsAndMissing"] as const) {
      expect(classifySshSyncBackTarFailure({ exitCode: 1, stderr, tolerance })).toEqual({
        tolerable: true,
        warnings: [stderr.trim()],
      });
    }
    expect(classifySshSyncBackTarFailure({ exitCode: 1, stderr, tolerance: "none" }).tolerable).toBe(false);
  });

  it("tolerates vanished entries only under warningsAndMissing", () => {
    const stderr = "tar: ./temp/build/node_modules/.pnpm/x.ts: Cannot open: No such file or directory\n";
    expect(classifySshSyncBackTarFailure({ exitCode: 2, stderr, tolerance: "warningsAndMissing" }).tolerable).toBe(true);
    expect(classifySshSyncBackTarFailure({ exitCode: 2, stderr, tolerance: "warnings" }).tolerable).toBe(false);
    expect(classifySshSyncBackTarFailure({ exitCode: 2, stderr, tolerance: "none" }).tolerable).toBe(false);
  });

  it("keeps transport and permission failures fatal", () => {
    expect(classifySshSyncBackTarFailure({ exitCode: 255, stderr: "ssh: connect refused", tolerance: "warningsAndMissing" }).tolerable).toBe(false);
    expect(classifySshSyncBackTarFailure({
      exitCode: 2,
      stderr: "tar: ./secret.pem: Cannot open: Permission denied\n",
      tolerance: "warningsAndMissing",
    }).tolerable).toBe(false);
    expect(classifySshSyncBackTarFailure({ exitCode: 1, stderr: "", tolerance: "warnings" }).tolerable).toBe(false);
  });
});

describe("ssh sync-back", () => {
  it("excludes node_modules, .git/objects and oversized files and leaves the local copies untouched", async () => {
    const remoteDir = await makeRoot("remote");
    const localDir = await makeRoot("local");
    await writeFile(path.join(remoteDir, "keep.txt"), "from remote\n");
    await mkdir(path.join(remoteDir, "node_modules", ".pnpm"), { recursive: true });
    await writeFile(path.join(remoteDir, "node_modules", ".pnpm", "chunk.js"), "remote artifact\n");
    await mkdir(path.join(remoteDir, "temp", "clone", ".git", "objects", "pack"), { recursive: true });
    await writeFile(path.join(remoteDir, "temp", "clone", ".git", "objects", "pack", "pack.idx"), "pack\n");
    await writeFile(path.join(localDir, "local-only.txt"), "stays local\n");
    // Sparse 600 MB file: instant to create, above the sync-back size cap.
    const bigPath = path.join(remoteDir, "dataset.bin");
    await writeFile(bigPath, "");
    await truncate(bigPath, SSH_SYNC_BACK_MAX_FILE_BYTES + 1024);

    const result = await syncDirectoryFromSsh({ spec: spec(remoteDir), remoteDir, localDir });

    expect(result.warnings).toEqual([]);
    expect(await readFile(path.join(localDir, "keep.txt"), "utf8")).toBe("from remote\n");
    // Heavy trees and oversized files never arrive...
    await expect(stat(path.join(localDir, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(localDir, "temp", "clone", ".git", "objects"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(localDir, "dataset.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    // ...and the reported skips name the oversized file.
    expect(result.sizeSkippedPaths).toEqual(["dataset.bin"]);
    // The remote tar command carries the heavy-dir and size excludes.
    const tarCall = vi.mocked(spawn).mock.calls
      .map(([, args]) => (args as string[]).at(-1) ?? "")
      .filter((script) => script.includes("-cf - ."))
      .at(-1)!
      .replaceAll(`'"'"'`, `'`);
    for (const pattern of ["node_modules", "*/node_modules", ".git/objects", "*/.git/objects", "dataset.bin"]) {
      expect(tarCall).toContain(`'--exclude' '${pattern}'`);
    }
  });

  it("keeps the host's node_modules and .git/objects through a baseline merge that skips them remotely", async () => {
    const remoteDir = await makeRoot("remote");
    const localDir = await makeRoot("local");
    const entries = new Map<string, { kind: "file"; mode: number; hash: string } | { kind: "dir" }>();
    const addFile = async (relative: string, body: string) => {
      const full = path.join(localDir, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
      entries.set(relative, {
        kind: "file",
        mode: 0o100644,
        hash: createHash("sha256").update(body).digest("hex"),
      });
    };
    await addFile("keep.txt", "local keep\n");
    await addFile("node_modules/local.js", "local deps\n");
    await addFile("temp/clone/.git/objects/pack/pack.idx", "local pack\n");
    // The remote work moved keep.txt on and grew its own heavy trees.
    await writeFile(path.join(remoteDir, "keep.txt"), "remote keep\n");

    await restoreWorkspaceFromSshExecution({
      spec: spec(remoteDir),
      localDir,
      remoteDir,
      baselineSnapshot: { exclude: [".paperclip-runtime"], entries },
    });

    expect(await readFile(path.join(localDir, "keep.txt"), "utf8")).toBe("remote keep\n");
    expect(await readFile(path.join(localDir, "node_modules", "local.js"), "utf8")).toBe("local deps\n");
    expect(await readFile(path.join(localDir, "temp", "clone", ".git", "objects", "pack", "pack.idx"), "utf8")).toBe("local pack\n");
    await expect(stat(path.join(localDir, "node_modules", "remote.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves with a run-log warning when the remote tree changes during the copy", async () => {
    const remoteDir = await makeRoot("remote");
    const localDir = await makeRoot("local");
    await writeFile(path.join(remoteDir, "keep.txt"), "payload\n");
    tarOverride = (script) => failingRemoteTar(script, "tar: ./temp/pc-evr267/paperclip/node_modules/.pnpm: file changed as we read it", 1);
    const lines: string[] = [];
    await syncDirectoryFromSsh({
      spec: spec(remoteDir),
      remoteDir,
      localDir,
      failureTolerance: "warningsAndMissing",
      onProgress: (line) => {
        lines.push(line);
      },
    });
    expect(lines.some((line) => line.includes("file changed as we read it"))).toBe(true);
    // What the archive carried still landed.
    expect(await readFile(path.join(localDir, "keep.txt"), "utf8")).toBe("payload\n");
  });

  it.each([
    ["baseline merge keeps the previous copy", "warningsAndMissing", true],
    ["direct restore keeps failing", "warnings", false],
  ] as ReadonlyArray<[string, SshSyncBackFailureTolerance | undefined, boolean]>)(
    "%s when a remote file vanishes mid-read",
    async (_label, _tolerance, withBaseline) => {
      const remoteDir = await makeRoot("remote");
      const localDir = await makeRoot("local");
      await writeFile(path.join(remoteDir, "keep.txt"), "payload\n");
      await writeFile(path.join(localDir, "previous.txt"), "previous\n");
      tarOverride = (script) => failingRemoteTar(script, "tar: ./gone.bin: Cannot open: No such file or directory", 2);
      const run = () => syncDirectoryFromSsh({
        spec: spec(remoteDir),
        remoteDir,
        localDir,
        ...(withBaseline ? { failureTolerance: "warningsAndMissing" as const } : {}),
      });
      if (withBaseline) {
        await run();
        expect(await readFile(path.join(localDir, "keep.txt"), "utf8")).toBe("payload\n");
      } else {
        await expect(run()).rejects.toThrow("No such file or directory");
      }
    },
  );

  it("wraps restore failures with the stable sync-back marker", async () => {
    const remoteDir = await makeRoot("remote");
    const localDir = await makeRoot("local");
    await writeFile(path.join(remoteDir, "keep.txt"), "payload\n");
    tarOverride = (script) => failingRemoteTar(script, "tar: unexpected end of stream", 2);
    await expect(restoreWorkspaceFromSshExecution({ spec: spec(remoteDir), localDir, remoteDir }))
      .rejects.toThrow("SSH workspace sync-back failed: tar: unexpected end of stream");
  });
});
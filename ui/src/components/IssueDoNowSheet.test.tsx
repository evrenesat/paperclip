// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentFocusStatusLine,
  IssueDoNowSheet,
  IssueFocusTargetBanner,
  IssuePausedForFocusBanner,
  sameModelAgentKey,
} from "./IssueDoNowSheet";

const mockAgentsApi = vi.hoisted(() => ({
  focus: vi.fn(),
  endFocus: vi.fn(),
  getFocus: vi.fn(),
}));
const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    });
  }
  throw new Error("Timed out waiting for condition");
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Heavy",
    urlKey: "heavy",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "opencode_local",
    adapterConfig: { model: "zai/glm-5" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const issue = { id: "issue-2", identifier: "EVR-156", title: "Directors cuts" };
const agents = [
  makeAgent({ id: "agent-1", name: "Heavy" }),
  makeAgent({ id: "agent-2", name: "Fast", adapterConfig: { model: "zai/glm-5" } }),
  makeAgent({ id: "agent-3", name: "Light", adapterConfig: { model: "qwen/qwen3" } }),
];

describe("IssueDoNowSheet", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockAgentsApi.focus.mockResolvedValue({
      agentId: "agent-1",
      focusIssueId: "issue-2",
      focusStartedAt: new Date().toISOString(),
      mode: "gracefully",
      preemptedRunIds: [],
      steerAcknowledgedRunIds: [],
      pausedAgentIds: [],
    });
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(element: ReactNode) {
    root ??= createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
      );
    });
  }

  async function submit() {
    await act(async () => {
      (document.querySelector("[data-testid='do-now-submit']") as HTMLButtonElement).click();
    });
    await flushReact();
  }

  it("renders nothing while closed", () => {
    render(
      <IssueDoNowSheet
        open={false}
        onOpenChange={() => {}}
        companyId="company-1"
        issue={issue}
        agents={agents}
        defaultAgentId="agent-1"
      />,
    );
    expect(document.querySelector("[data-testid='do-now-submit']")).toBeNull();
  });

  it("submits the focused issue with the chosen agent and mode", async () => {
    render(
      <IssueDoNowSheet
        open
        onOpenChange={() => {}}
        companyId="company-1"
        issue={issue}
        agents={agents}
        defaultAgentId="agent-1"
      />,
    );
    await flushReact();
    expect(document.querySelector("[data-testid='do-now-submit']")).toBeTruthy();
    await submit();
    expect(mockAgentsApi.focus).toHaveBeenCalledWith(
      "agent-1",
      { issueId: "issue-2", mode: "gracefully", note: null, pauseAgentIds: [] },
      "company-1",
    );
  });

  it("switches to right_away mode and carries the note", async () => {
    render(
      <IssueDoNowSheet
        open
        onOpenChange={() => {}}
        companyId="company-1"
        issue={issue}
        agents={agents}
        defaultAgentId="agent-1"
      />,
    );
    await flushReact();
    const rightAway = document.querySelector(
      "[data-testid='do-now-mode-right-away']",
    ) as HTMLInputElement;
    await act(async () => {
      rightAway.click();
    });
    const note = document.querySelector(
      "[data-testid='do-now-note']",
    ) as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(note, "Owner priority");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
    const call = mockAgentsApi.focus.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.mode).toBe("right_away");
    expect(call.note).toBe("Owner priority");
  });

  it("lists other agents running on the same model with a pause checkbox", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      { id: "run-2", agentId: "agent-2", status: "running" },
      { id: "run-3", agentId: "agent-3", status: "running" },
    ]);
    render(
      <IssueDoNowSheet
        open
        onOpenChange={() => {}}
        companyId="company-1"
        issue={issue}
        agents={agents}
        defaultAgentId="agent-1"
      />,
    );
    await flushReact();
    await waitFor(() => document.querySelector("[data-testid='do-now-pause-agent-2']") !== null);
    const checkbox = document.querySelector(
      "[data-testid='do-now-pause-agent-2']",
    ) as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(document.body.textContent).not.toContain("Pause Light too");
    await act(async () => {
      checkbox.click();
    });
    await submit();
    expect(mockAgentsApi.focus).toHaveBeenCalledWith(
      "agent-1",
      { issueId: "issue-2", mode: "gracefully", note: null, pauseAgentIds: ["agent-2"] },
      "company-1",
    );
  });

  it("offers to focus the agent that already runs the task", async () => {
    mockAgentsApi.focus.mockRejectedValue(
      Object.assign(new Error("The issue has an active run by another agent"), {
        details: { code: "active_run_other_agent", activeRunAgentId: "agent-2" },
      }),
    );
    render(
      <IssueDoNowSheet
        open
        onOpenChange={() => {}}
        companyId="company-1"
        issue={issue}
        agents={agents}
        defaultAgentId="agent-1"
      />,
    );
    await flushReact();
    await submit();
    const alert = document.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Fast is already running on this task");
    const switchButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Focus Fast instead"),
    );
    expect(switchButton).toBeTruthy();
  });
});

describe("focus banners and status line", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
  });

  function render(element: ReactNode) {
    act(() => {
      root ??= createRoot(container);
      root!.render(element);
    });
  }

  it("shows the switching banner before the run starts and the working banner after", () => {
    render(
      <IssueFocusTargetBanner
        agentName="Heavy"
        focus={{ issueId: "i", issueIdentifier: "EVR-156", issueTitle: null, startedAt: null, hasRun: false }}
      />,
    );
    expect(document.querySelector("[data-testid='focus-target-banner']")?.textContent).toBe(
      "Do now: Heavy is switching to this",
    );
  });

  it("shows the working banner once the focus has a run", () => {
    render(
      <IssueFocusTargetBanner
        agentName="Heavy"
        focus={{ issueId: "i", issueIdentifier: "EVR-156", issueTitle: null, startedAt: null, hasRun: true }}
      />,
    );
    expect(document.querySelector("[data-testid='focus-target-banner']")?.textContent).toBe(
      "Heavy is working on this",
    );
  });

  it("shows the paused banner with a working resume action", async () => {
    const onResume = vi.fn();
    render(
      <IssuePausedForFocusBanner focusIdentifier="EVR-156" onResume={onResume} />,
    );
    const banner = document.querySelector("[data-testid='focus-paused-banner']");
    expect(banner?.textContent).toContain("Paused for EVR-156; resumes when it ends");
    const resume = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Resume now"),
    );
    await act(async () => {
      resume!.click();
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("renders the one-line agent focus status", () => {
    render(
      <AgentFocusStatusLine
        focus={{ issueId: "i", issueIdentifier: "EVR-156", issueTitle: null, startedAt: null, hasRun: true }}
      />,
    );
    expect(document.querySelector("[data-testid='agent-focus-status-line']")?.textContent).toBe(
      "Focused on EVR-156",
    );
  });

  it("renders nothing without a focus", () => {
    render(<AgentFocusStatusLine focus={null} />);
    expect(document.querySelector("[data-testid='agent-focus-status-line']")).toBeNull();
    render(<IssueFocusTargetBanner agentName="Heavy" focus={null} />);
    expect(document.querySelector("[data-testid='focus-target-banner']")).toBeNull();
  });

  it("groups agents by adapter type and model", () => {
    const glm = makeAgent({ adapterConfig: { model: "zai/glm-5" } });
    const glmOther = makeAgent({ id: "agent-2", adapterConfig: { model: "zai/glm-5" } });
    const qwen = makeAgent({ id: "agent-3", adapterConfig: { model: "qwen/qwen3" } });
    expect(sameModelAgentKey(glm)).toBe(sameModelAgentKey(glmOther));
    expect(sameModelAgentKey(glm)).not.toBe(sameModelAgentKey(qwen));
  });
});
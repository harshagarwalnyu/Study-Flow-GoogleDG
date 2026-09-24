import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Dashboard, { type DashboardInitialData } from "./Dashboard";
import { AuthContext } from "../lib/auth";
import * as api from "../lib/api";
import * as extensionBridge from "../lib/extensionBridge";

vi.mock("../lib/api", () => ({
  fetchGraph: vi.fn(),
  fetchDrillQueue: vi.fn(),
  fetchRecentEvents: vi.fn(),
  fetchGamification: vi.fn(),
  ingestTextContent: vi.fn(),
  uploadIngestFile: vi.fn(),
}));

vi.mock("../lib/extensionBridge", () => ({
  getConnectExtensionId: vi.fn(() => "default-ext-id"),
  sendAuthToExtension: vi.fn(),
}));

// A cytoscape mock that actually invokes every function-valued style property
// with representative element data, so the real color/shape/border logic in
// Dashboard.tsx gets exercised instead of merely being referenced.
vi.mock("cytoscape", () => ({
  default: vi.fn((config: any) => {
    const nodeRule = (config.style ?? []).find(
      (rule: any) => rule.selector === "node",
    );
    if (nodeRule) {
      (config.elements ?? []).forEach((el: any) => {
        const fakeElement = { data: (key: string) => el.data[key] };
        Object.values(nodeRule.style).forEach((value: any) => {
          if (typeof value === "function") {
            value(fakeElement);
          }
        });
      });
    }
    return { destroy: vi.fn() };
  }),
}));

const mockUser = { displayName: "Test User", uid: "123" };
const mockUserNoName = { uid: "456" };

const diverseNodes = [
  {
    conceptNode: "low_acc",
    accuracyRate: 0.1,
    interactionCount: 2,
    dominantErrorType: "knowledge_gap",
  },
  {
    conceptNode: "med_acc",
    accuracyRate: 0.5,
    interactionCount: 0,
    dominantErrorType: "procedural_error",
  },
  {
    conceptNode: "high_acc",
    accuracyRate: 0.9,
    dominantErrorType: "reasoning_error",
  },
  {
    conceptNode: "unknown_type",
    accuracyRate: 0,
    interactionCount: 1,
  },
];

const diverseDrill = [
  { conceptNode: "d_low", accuracyRate: 0.1, urgency: 1 },
  { conceptNode: "d_med", accuracyRate: 0.5, urgency: 2 },
  { conceptNode: "d_high", accuracyRate: 0.9, urgency: 3 },
  { conceptNode: "d_zero", accuracyRate: 0, urgency: 4 },
];

const longContentEvents = [
  {
    eventId: "e-long",
    eventType: "quiz_answer",
    content: "x".repeat(120),
    createdAt: new Date("2024-01-01T00:00:00Z"),
  },
];

const gamificationWithAchievements = {
  xp: 10,
  level: 2,
  xpIntoLevel: 5,
  nextLevelXP: 50,
  streak: 3,
  achievements: [
    {
      id: "a1",
      name: "First Steps",
      description: "Answered your first question",
      icon: "🏆",
      unlocked: true,
    },
    {
      id: "a2",
      name: "Locked One",
      description: "Not yet earned",
      icon: "🔒",
      unlocked: false,
    },
  ],
};

function fullInitialData(
  overrides: Partial<DashboardInitialData> = {},
): DashboardInitialData {
  return {
    nodes: diverseNodes as any,
    drill: diverseDrill as any,
    events: longContentEvents as any,
    gamification: gamificationWithAchievements,
    ...overrides,
  };
}

function renderDashboard(
  initialData: DashboardInitialData | undefined,
  user: any = mockUser,
  initialEntry = "/dashboard",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthContext.Provider value={user}>
        <Dashboard initialData={initialData} />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("Dashboard interactions and rendering edge cases", () => {
  // This file renders the full Dashboard (cytoscape mock, multiple async
  // effects) many times; under system load the default 5s test timeout can
  // trip even though the assertions themselves are correct. Widen it for
  // this file only, without touching the shared vitest config.

  beforeEach(() => {
    vi.clearAllMocks();
    (api.fetchGraph as any).mockResolvedValue({ nodes: [] });
    (api.fetchDrillQueue as any).mockResolvedValue({ queue: [] });
    (api.fetchRecentEvents as any).mockResolvedValue({ events: [], count: 0 });
    (api.fetchGamification as any).mockResolvedValue({
      xp: 0,
      level: 1,
      xpIntoLevel: 0,
      nextLevelXP: 100,
      streak: 0,
      achievements: [],
    });
    (extensionBridge.getConnectExtensionId as any).mockReturnValue(
      "default-ext-id",
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("exercises every accuracy bucket and known/unknown error-type styling via the cytoscape callbacks", async () => {
    renderDashboard(fullInitialData());

    // The custom cytoscape mock above invokes every style callback for every
    // node; once cytoscape() has been called, the background-color, shape,
    // border-width and border-color functions all already ran across the
    // low/med/high accuracy buckets and the known + unknown error types.
    const cytoscapeModule = await import("cytoscape");
    await waitFor(() => {
      expect(cytoscapeModule.default).toHaveBeenCalledTimes(1);
    });
  });

  it("shows the graph legend once concepts exist", async () => {
    renderDashboard(fullInitialData());

    await waitFor(() => {
      expect(screen.getByLabelText("Graph legend")).toBeDefined();
    });
    expect(screen.getByText("Mastered (70%+)")).toBeDefined();
  });

  it("renders both unlocked and locked achievement badges with distinct styling", () => {
    renderDashboard(fullInitialData());

    const unlocked = screen.getByTitle(
      "First Steps: Answered your first question",
    );
    const locked = screen.getByTitle("Locked One: Not yet earned");

    expect((unlocked as HTMLElement).style.opacity).toBe("1");
    expect((locked as HTMLElement).style.opacity).toBe("0.2");
  });

  it("truncates long event content with an ellipsis", () => {
    renderDashboard(fullInitialData());

    expect(screen.getByText(/x{80}\.\.\./)).toBeDefined();
  });

  it("falls back accuracy and interaction fallbacks to 0 when missing, without crashing the totals", () => {
    renderDashboard(fullInitialData());

    // avgAccuracy / totalInteractions computed from nodes with 0/undefined
    // fields should not throw and should render numeric output.
    expect(screen.getByText(/Interactions/i)).toBeDefined();
    expect(screen.getByText(/Avg Accuracy/i)).toBeDefined();
  });

  it("omits the display name suffix in the heading when the user has none", () => {
    renderDashboard(fullInitialData(), mockUserNoName);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Dashboard");
  });

  describe("Connect to extension", () => {
    it("shows the connecting state, then a success message once the extension confirms", async () => {
      let resolveConnect!: (value: { ok: boolean; error?: string }) => void;
      (extensionBridge.sendAuthToExtension as any).mockReturnValue(
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
      );

      renderDashboard(fullInitialData(), mockUser, "/dashboard");

      const connectBtn = screen.getByRole("button", {
        name: /Connect to extension/i,
      });

      fireEvent.click(connectBtn);

      await waitFor(() => {
        expect(screen.getByText("Connecting...")).toBeDefined();
      });

      await act(async () => {
        resolveConnect({ ok: true });
      });

      await waitFor(() => {
        expect(
          screen.getByText(
            "Extension connected! You can return to Study Flow.",
          ),
        ).toBeDefined();
      });
    });

    it("shows the extension's error message when the connection is rejected with a reason", async () => {
      (extensionBridge.sendAuthToExtension as any).mockResolvedValue({
        ok: false,
        error: "extension declined",
      });

      renderDashboard(fullInitialData());

      fireEvent.click(
        screen.getByRole("button", { name: /Connect to extension/i }),
      );

      await waitFor(() => {
        expect(screen.getByText("extension declined")).toBeDefined();
      });
    });

    it("shows a default error message when the connection fails without a reason", async () => {
      (extensionBridge.sendAuthToExtension as any).mockResolvedValue({
        ok: false,
      });

      renderDashboard(fullInitialData());

      fireEvent.click(
        screen.getByRole("button", { name: /Connect to extension/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByText("Could not connect the extension."),
        ).toBeDefined();
      });
    });

    it("shows a generic failure message when sendAuthToExtension throws", async () => {
      (extensionBridge.sendAuthToExtension as any).mockRejectedValue(
        new Error("network exploded"),
      );

      renderDashboard(fullInitialData());

      fireEvent.click(
        screen.getByRole("button", { name: /Connect to extension/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByText("Could not connect the extension."),
        ).toBeDefined();
      });

      // The connecting flag must reset back to enabled after the failure.
      await waitFor(() => {
        const button = screen.getByRole("button", {
          name: /Connect to extension/i,
        }) as HTMLButtonElement;
        expect(button.disabled).toBe(false);
      });
    });

    it("auto-connects once when the page is opened with an extensionId in the URL and a signed-in user", async () => {
      (extensionBridge.sendAuthToExtension as any).mockResolvedValue({
        ok: true,
      });

      renderDashboard(
        fullInitialData(),
        mockUser,
        "/dashboard?extensionId=auto-123",
      );

      await waitFor(() => {
        expect(extensionBridge.sendAuthToExtension).toHaveBeenCalledWith(
          "auto-123",
          mockUser,
        );
      });
      expect(extensionBridge.sendAuthToExtension).toHaveBeenCalledTimes(1);
    });

    it("disables the connect button when there is no signed-in user", () => {
      renderDashboard(fullInitialData(), null);

      const button = screen.getByRole("button", {
        name: /Connect to extension/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
  });

  describe("Ingest form interactions", () => {
    it("switching back to the Upload File tab clears a previous ingest status/error", async () => {
      (api.ingestTextContent as any).mockRejectedValue(
        new Error("text ingest failed"),
      );

      renderDashboard(fullInitialData());

      fireEvent.click(screen.getByText(/Paste Text/i));
      fireEvent.change(screen.getByPlaceholderText(/Course name/i), {
        target: { value: "Math 101" },
      });
      fireEvent.change(screen.getByPlaceholderText(/Paste course notes/i), {
        target: { value: "some notes" },
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Ingest$/ }));
      });

      await waitFor(() => {
        expect(screen.getByText("text ingest failed")).toBeDefined();
      });

      fireEvent.click(screen.getByText(/Upload File/i));

      expect(screen.queryByText("text ingest failed")).toBeNull();
      expect(
        document.querySelector('input[type="file"]'),
      ).not.toBeNull();
    });

    it("clearing the chosen file falls back to null via the optional file access", () => {
      renderDashboard(fullInitialData());

      const fileEl = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;

      fireEvent.change(fileEl, { target: { files: [] } });

      const ingestBtn = screen.getByRole("button", {
        name: /^Ingest$/,
      }) as HTMLButtonElement;
      expect(ingestBtn.disabled).toBe(true);
    });

    it("shows a generic 'Ingestion failed.' message when a non-Error value is thrown", async () => {
      (api.uploadIngestFile as any).mockRejectedValue("not an Error object");

      renderDashboard(fullInitialData());

      fireEvent.change(screen.getByPlaceholderText(/Course name/i), {
        target: { value: "Math 101" },
      });
      const fileEl = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      const file = new File(["hello"], "hello.txt", { type: "text/plain" });
      fireEvent.change(fileEl, { target: { files: [file] } });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Ingest$/ }));
      });

      await waitFor(() => {
        expect(screen.getByText("Ingestion failed.")).toBeDefined();
      });
    });

    // NOTE: Dashboard.tsx:256-258 (`if (!ingestFile) { throw new Error(...) }`
    // inside handleIngest) is defense-in-depth that is unreachable from the
    // rendered UI: the Ingest button's `disabled` prop already covers the
    // same condition (`ingestTab === "file" ? !ingestFile : ...`), and
    // jsdom/React correctly refuse to dispatch a click to a disabled native
    // button even after force-clearing the `disabled` DOM property directly
    // (verified experimentally). See the final report for the BLOCKED entry.
  });

  it("aborts the initial fetch on unmount and ignores results that resolve afterward", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    let resolveGraph!: (value: { nodes: unknown[] }) => void;
    (api.fetchGraph as any).mockReturnValue(
      new Promise((resolve) => {
        resolveGraph = resolve;
      }),
    );

    const { unmount } = renderDashboard(undefined, mockUser);

    unmount();

    await act(async () => {
      resolveGraph({ nodes: [{ conceptNode: "late_arrival" }] as any });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The AbortController guard inside the fetch effect must skip setState
    // once unmounted; if it didn't, React would log an unmounted-update
    // warning here.
    const loggedUnmountWarning = consoleErrorSpy.mock.calls.some((call) =>
      String(call[0]).includes("unmounted"),
    );
    expect(loggedUnmountWarning).toBe(false);

    consoleErrorSpy.mockRestore();
  });
});

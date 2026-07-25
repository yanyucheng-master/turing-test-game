import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __debugTicket,
  __resetMatchmakingForTests,
  acceptMatch,
  calculateCohortRevealAt,
  cancelMatch,
  joinMatch,
  pollMatch,
} from "./matchmaking";
import { getSession } from "./store";

describe("cohort match reveal", () => {
  beforeEach(() => {
    __resetMatchmakingForTests();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    __resetMatchmakingForTests();
    vi.useRealTimers();
  });

  it("assigns cohort reveal boundaries", () => {
    const joinedAt = 1_700_000_000_000;
    const revealAt = calculateCohortRevealAt(joinedAt);
    expect(revealAt % 4_000).toBe(0);
    expect(revealAt - joinedAt).toBeGreaterThanOrEqual(800);
    expect(revealAt - joinedAt).toBeLessThanOrEqual(4_800);
  });

  it("keeps searching until cohort reveal then matches AI", async () => {
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;

    expect((await pollMatch(ticketId)).status).toBe("searching");

    vi.setSystemTime(t0.revealAt - 1);
    expect((await pollMatch(ticketId)).status).toBe("searching");

    vi.setSystemTime(t0.revealAt + 1);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status === "matched") {
      expect(status.chatStartedAt).toBe(t0.revealAt);
      expect(status.chatDeadlineAt).toBe(t0.revealAt + 120_000);
      expect("opponentSource" in status).toBe(false);
    }
  });

  it("second player in same cohort shares revealAt and never exceeds it", async () => {
    const a = joinMatch();
    const tA = __debugTicket(a.ticketId)!;

    // Stay inside the same cohort bucket.
    vi.setSystemTime(tA.joinedAt + 50);
    const b = joinMatch();
    const tB = __debugTicket(b.ticketId)!;
    expect(tB.revealAt).toBe(tA.revealAt);

    // Before boundary both still searching (even if already paired server-side).
    let statusA = await pollMatch(a.ticketId);
    let statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("searching");
    expect(statusB.status).toBe("searching");
    if (statusA.status === "searching") {
      expect(statusA.elapsedMs).toBeLessThanOrEqual(tA.revealAt - tA.joinedAt);
      // UI window equals this ticket's cohort wait — no stall past 100%.
      expect(statusA.matchWindowSec).toBe(
        Math.ceil((tA.revealAt - tA.joinedAt) / 1000),
      );
    }

    vi.setSystemTime(tA.revealAt + 1);
    statusA = await pollMatch(a.ticketId);
    statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("matched");
    expect(statusB.status).toBe("matched");
  });

  it("cancel before claim deletes unclaimed AI session", async () => {
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    vi.setSystemTime(t0.revealAt + 1);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status !== "matched") return;

    cancelMatch(ticketId);
    expect(getSession(status.gameId)).toBeUndefined();
    expect((await pollMatch(ticketId)).status).toBe("cancelled");
  });

  it("A claimed + B cancel does not delete A's session", async () => {
    const a = joinMatch();
    const tA = __debugTicket(a.ticketId)!;
    vi.setSystemTime(tA.joinedAt + 50);
    const b = joinMatch();
    expect(__debugTicket(b.ticketId)?.revealAt).toBe(tA.revealAt);

    vi.setSystemTime(tA.revealAt + 1);
    const statusA = await pollMatch(a.ticketId);
    const statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("matched");
    expect(statusB.status).toBe("matched");
    if (statusA.status !== "matched" || statusB.status !== "matched") return;

    expect(acceptMatch(a.ticketId, statusA.gameId)).toBe(true);
    expect(getSession(statusA.gameId)).toBeDefined();

    cancelMatch(b.ticketId);
    // A must survive
    expect(getSession(statusA.gameId)).toBeDefined();
    expect(getSession(statusB.gameId)).toBeUndefined();
  });

  it("acceptMatch claims the ticket", async () => {
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    vi.setSystemTime(t0.revealAt + 1);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status !== "matched") return;
    expect(acceptMatch(ticketId, status.gameId)).toBe(true);
    expect(__debugTicket(ticketId)?.claimed).toBe(true);
    cancelMatch(ticketId);
    expect(getSession(status.gameId)).toBeDefined();
  });
});

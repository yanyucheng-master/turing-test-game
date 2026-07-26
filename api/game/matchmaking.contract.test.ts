import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __debugTicket,
  __resetMatchmakingForTests,
  __setColdMatchMsForTests,
  __setTotalMatchMsForTests,
  acceptMatch,
  calculateCohortRevealAt,
  cancelMatch,
  COLD_MATCH_MAX_MS,
  joinMatch,
  MATCH_MAX_MS,
  pollMatch,
} from "./matchmaking";
import { getSession } from "./store";

describe("match schedule (≤7s, includes cold)", () => {
  beforeEach(() => {
    __resetMatchmakingForTests();
    __setColdMatchMsForTests(0);
    __setTotalMatchMsForTests(3_000);
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    __resetMatchmakingForTests();
    vi.useRealTimers();
  });

  it("hard ceiling is 7s", () => {
    const joinedAt = 1_700_000_000_000;
    expect(MATCH_MAX_MS).toBe(7_000);
    expect(COLD_MATCH_MAX_MS).toBe(2_000);
    expect(calculateCohortRevealAt(joinedAt)).toBe(joinedAt + MATCH_MAX_MS);
  });

  it("keeps searching until personal reveal then matches AI", async () => {
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    expect(t0.revealAt - t0.joinedAt).toBe(3_000);
    expect(t0.revealAt).toBeGreaterThanOrEqual(t0.coldUntil);

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

  it("searching payload exposes ceiling only in contract field, elapsed is free", async () => {
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    vi.setSystemTime(t0.joinedAt + 1_250);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("searching");
    if (status.status === "searching") {
      expect(status.elapsedMs).toBe(1_250);
      expect(status.matchWindowSec).toBe(7);
    }
  });

  it("two warm players share later revealAt for PVP", async () => {
    __setTotalMatchMsForTests(2_000);
    const a = joinMatch();
    const tA = __debugTicket(a.ticketId)!;

    vi.setSystemTime(tA.joinedAt + 50);
    __setTotalMatchMsForTests(5_000);
    const b = joinMatch();
    const tB = __debugTicket(b.ticketId)!;
    expect(tB.revealAt - tB.joinedAt).toBe(5_000);

    // Both warm (cold=0) — may pair server-side, but UI stays searching.
    let statusA = await pollMatch(a.ticketId);
    let statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("searching");
    expect(statusB.status).toBe("searching");

    // Shared activate = max(personal reveals).
    const shared = Math.max(
      __debugTicket(a.ticketId)!.revealAt,
      __debugTicket(b.ticketId)!.revealAt,
    );
    vi.setSystemTime(shared + 1);
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
    __setTotalMatchMsForTests(3_000);
    const a = joinMatch();
    const tA = __debugTicket(a.ticketId)!;
    vi.setSystemTime(tA.joinedAt + 50);
    const b = joinMatch();

    const shared = Math.max(
      __debugTicket(a.ticketId)!.revealAt,
      __debugTicket(b.ticketId)!.revealAt,
    );
    vi.setSystemTime(shared + 1);
    const statusA = await pollMatch(a.ticketId);
    const statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("matched");
    expect(statusB.status).toBe("matched");
    if (statusA.status !== "matched" || statusB.status !== "matched") return;

    expect(acceptMatch(a.ticketId, statusA.gameId)).toBe(true);
    expect(getSession(statusA.gameId)).toBeDefined();

    cancelMatch(b.ticketId);
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

describe("cold match window", () => {
  beforeEach(() => {
    __resetMatchmakingForTests();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    __resetMatchmakingForTests();
    vi.useRealTimers();
  });

  it("blocks AI and human pairing until coldUntil", async () => {
    __setColdMatchMsForTests(1_500);
    __setTotalMatchMsForTests(4_000);
    const a = joinMatch();
    const tA = __debugTicket(a.ticketId)!;
    expect(tA.coldUntil).toBe(tA.joinedAt + 1_500);
    expect(tA.revealAt).toBe(tA.joinedAt + 4_000);

    vi.setSystemTime(tA.joinedAt + 50);
    __setColdMatchMsForTests(1_500);
    __setTotalMatchMsForTests(4_000);
    const b = joinMatch();

    // Still cold — stay searching.
    vi.setSystemTime(tA.coldUntil - 1);
    expect((await pollMatch(a.ticketId)).status).toBe("searching");
    expect((await pollMatch(b.ticketId)).status).toBe("searching");

    // Warm but before personal reveal — may pair server-side, UI still searching.
    vi.setSystemTime(tA.coldUntil + 1);
    expect((await pollMatch(a.ticketId)).status).toBe("searching");
    expect((await pollMatch(b.ticketId)).status).toBe("searching");

    const shared = Math.max(
      __debugTicket(a.ticketId)!.revealAt,
      __debugTicket(b.ticketId)!.revealAt,
    );
    vi.setSystemTime(shared + 1);
    const statusA = await pollMatch(a.ticketId);
    const statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("matched");
    expect(statusB.status).toBe("matched");
  });

  it("total always includes cold and never exceeds 7s", async () => {
    __setColdMatchMsForTests(2_000);
    __setTotalMatchMsForTests(2_000); // equal to cold → reveal == coldUntil
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    expect(t0.revealAt).toBe(t0.coldUntil);
    expect(t0.revealAt - t0.joinedAt).toBeLessThanOrEqual(MATCH_MAX_MS);

    vi.setSystemTime(t0.coldUntil - 1);
    expect((await pollMatch(ticketId)).status).toBe("searching");

    vi.setSystemTime(t0.coldUntil + 1);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status === "matched") {
      expect(status.chatStartedAt).toBeGreaterThanOrEqual(t0.coldUntil);
    }
  });

  it("clamps total override above 7s down to MATCH_MAX_MS", () => {
    __setColdMatchMsForTests(500);
    __setTotalMatchMsForTests(99_000);
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    expect(t0.revealAt - t0.joinedAt).toBe(MATCH_MAX_MS);
    expect(t0.coldUntil - t0.joinedAt).toBe(500);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __debugTicket,
  __resetMatchmakingForTests,
  __setAiEntryMsForTests,
  __setColdMatchMsForTests,
  acceptMatch,
  calculateCohortRevealAt,
  cancelMatch,
  COLD_MATCH_MAX_MS,
  joinMatch,
  MATCH_MAX_MS,
  pollMatch,
} from "./matchmaking";
import { getSession } from "./store";

const BASE = 1_700_000_000_000;

function schedule(coldMs: number, aiEntryMs: number): void {
  __setColdMatchMsForTests(coldMs);
  __setAiEntryMsForTests(aiEntryMs);
}

describe("independent cold and AI-entry clocks", () => {
  beforeEach(() => {
    __resetMatchmakingForTests();
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });

  afterEach(() => {
    __resetMatchmakingForTests();
    vi.useRealTimers();
  });

  it("keeps both random clocks within their independent ceilings", () => {
    expect(MATCH_MAX_MS).toBe(7_000);
    expect(COLD_MATCH_MAX_MS).toBe(2_000);
    expect(calculateCohortRevealAt(BASE)).toBe(BASE + MATCH_MAX_MS);

    schedule(99_000, 99_000);
    const { ticketId } = joinMatch();
    const ticket = __debugTicket(ticketId)!;
    expect(ticket.coldUntil - ticket.joinedAt).toBe(COLD_MATCH_MAX_MS);
    expect(ticket.aiEntryAt - ticket.joinedAt).toBe(MATCH_MAX_MS);
  });

  it("allows AI entry before cold ends and ignores a waiting human", async () => {
    schedule(1_800, 900);
    const a = joinMatch();
    const ticketA = __debugTicket(a.ticketId)!;

    vi.setSystemTime(BASE + 100);
    schedule(0, 7_000);
    const b = joinMatch();

    vi.setSystemTime(ticketA.aiEntryAt);
    const statusA = await pollMatch(a.ticketId);
    expect(statusA.status).toBe("matched");
    if (statusA.status !== "matched") return;
    expect(statusA.chatStartedAt).toBe(BASE + 900);
    expect(getSession(statusA.gameId)?.mode).toBe("ai");
    expect((await pollMatch(b.ticketId)).status).toBe("searching");
  });

  it("gives AI priority when coldUntil equals aiEntryAt", async () => {
    schedule(1_000, 1_000);
    const a = joinMatch();

    vi.setSystemTime(BASE + 100);
    schedule(0, 7_000);
    const b = joinMatch();

    vi.setSystemTime(BASE + 1_000);
    const statusA = await pollMatch(a.ticketId);
    expect(statusA.status).toBe("matched");
    if (statusA.status !== "matched") return;
    expect(getSession(statusA.gameId)?.mode).toBe("ai");
    expect((await pollMatch(b.ticketId)).status).toBe("searching");
  });

  it("pairs humans at the first overlap instead of waiting for AI deadlines", async () => {
    schedule(500, 4_000);
    const a = joinMatch();

    vi.setSystemTime(BASE + 100);
    schedule(300, 6_000);
    const b = joinMatch();

    vi.setSystemTime(BASE + 499);
    expect((await pollMatch(a.ticketId)).status).toBe("searching");

    vi.setSystemTime(BASE + 500);
    const statusA = await pollMatch(a.ticketId);
    const statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("matched");
    expect(statusB.status).toBe("matched");
    if (statusA.status !== "matched" || statusB.status !== "matched") return;
    expect(statusA.chatStartedAt).toBe(BASE + 500);
    expect(statusB.chatStartedAt).toBe(BASE + 500);
    expect(getSession(statusA.gameId)?.mode).toBe("pvp");
    expect(getSession(statusB.gameId)?.mode).toBe("pvp");
    expect("opponentSource" in statusA).toBe(false);
  });

  it("uses FIFO when three players enter the human window together", async () => {
    schedule(1_000, 7_000);
    const a = joinMatch();

    vi.setSystemTime(BASE + 100);
    schedule(900, 7_000);
    const b = joinMatch();

    vi.setSystemTime(BASE + 200);
    schedule(800, 7_000);
    const c = joinMatch();

    vi.setSystemTime(BASE + 1_000);
    const statusC = await pollMatch(c.ticketId);
    const statusA = await pollMatch(a.ticketId);
    const statusB = await pollMatch(b.ticketId);

    expect(statusA.status).toBe("matched");
    expect(statusB.status).toBe("matched");
    expect(statusC.status).toBe("searching");
  });

  it("resolves chronological events even when the client polls late", async () => {
    schedule(1_800, 900);
    const { ticketId } = joinMatch();

    vi.setSystemTime(BASE + 2_500);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status !== "matched") return;
    expect(status.chatStartedAt).toBe(BASE + 900);
    expect(status.chatDeadlineAt).toBe(BASE + 900 + 120_000);
  });
});

describe("match lifecycle with independent clocks", () => {
  beforeEach(() => {
    __resetMatchmakingForTests();
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    schedule(0, 3_000);
  });

  afterEach(() => {
    __resetMatchmakingForTests();
    vi.useRealTimers();
  });

  it("returns elapsed search status before AI entry", async () => {
    const { ticketId } = joinMatch();
    vi.setSystemTime(BASE + 1_250);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("searching");
    if (status.status === "searching") {
      expect(status.elapsedMs).toBe(1_250);
      expect(status.matchWindowSec).toBe(7);
    }
  });

  it("cancels an unclaimed AI session", async () => {
    const { ticketId } = joinMatch();
    const ticket = __debugTicket(ticketId)!;
    vi.setSystemTime(ticket.aiEntryAt);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status !== "matched") return;

    cancelMatch(ticketId);
    expect(getSession(status.gameId)).toBeUndefined();
    expect((await pollMatch(ticketId)).status).toBe("cancelled");
  });

  it("acceptMatch claims an AI ticket at its entry time", async () => {
    const { ticketId } = joinMatch();
    const ticket = __debugTicket(ticketId)!;
    vi.setSystemTime(ticket.aiEntryAt);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status !== "matched") return;

    expect(acceptMatch(ticketId, status.gameId)).toBe(true);
    expect(__debugTicket(ticketId)?.claimed).toBe(true);
    cancelMatch(ticketId);
    expect(getSession(status.gameId)).toBeDefined();
  });

  it("does not delete the claimed peer when the other PVP ticket cancels", async () => {
    schedule(0, 5_000);
    const a = joinMatch();
    vi.setSystemTime(BASE + 50);
    const b = joinMatch();

    const statusA = await pollMatch(a.ticketId);
    const statusB = await pollMatch(b.ticketId);
    expect(statusA.status).toBe("matched");
    expect(statusB.status).toBe("matched");
    if (statusA.status !== "matched" || statusB.status !== "matched") return;

    expect(acceptMatch(a.ticketId, statusA.gameId)).toBe(true);
    cancelMatch(b.ticketId);
    expect(getSession(statusA.gameId)).toBeDefined();
    expect(getSession(statusB.gameId)).toBeUndefined();
  });
});

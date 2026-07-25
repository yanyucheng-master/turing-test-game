import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __debugTicket,
  __resetMatchmakingForTests,
  acceptMatch,
  cancelMatch,
  joinMatch,
  pollMatch,
} from "./matchmaking";
import { getSession } from "./store";

describe("visible match mask", () => {
  beforeEach(() => {
    __resetMatchmakingForTests();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    __resetMatchmakingForTests();
    vi.useRealTimers();
  });

  it("keeps searching until revealAt even after AI is committed", async () => {
    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    expect(t0.visibleMatchedAt - t0.joinedAt).toBeGreaterThanOrEqual(800);
    expect(t0.visibleMatchedAt - t0.joinedAt).toBeLessThanOrEqual(3_000);

    let status = await pollMatch(ticketId);
    expect(status.status).toBe("searching");

    // Just before reveal — still searching to the client.
    vi.setSystemTime(t0.revealAt - 1);
    status = await pollMatch(ticketId);
    expect(status.status).toBe("searching");

    vi.setSystemTime(t0.revealAt + 1);
    status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status === "matched") {
      expect(status.gameId).toBeTruthy();
      expect("opponentSource" in status).toBe(false);
    }
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

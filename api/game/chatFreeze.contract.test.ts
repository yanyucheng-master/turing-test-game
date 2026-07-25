import { afterEach, describe, expect, it, vi } from "vitest";
import { closeChat, createAiSession, peekDueEvents } from "./store";
import { queueAiGeneration } from "./aiWorker";

describe("chat freeze + player burst history", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops undelivered outbox after closeChat", () => {
    const s = createAiSession("freeze1", "human", null);
    const now = Date.now();
    // Bypass scheduleDeliverAt so deliverAt values are exact.
    s.outbox = [
      {
        seq: 1,
        type: "message",
        from: "opponent",
        text: "soon",
        deliverAt: now - 10,
      },
      {
        seq: 2,
        type: "message",
        from: "opponent",
        text: "later",
        deliverAt: now + 60_000,
      },
    ];
    s.outboxSeq = 2;

    closeChat(s, "player_judged");
    expect(s.chatClosedAt).toBeTruthy();
    expect(s.outbox.map((e) => e.text)).toEqual(["soon"]);
    expect(peekDueEvents(s, 0).map((e) => e.text)).toEqual(["soon"]);
  });

  it("writes rapid player lines to history in UI order before AI reply", () => {
    const s = createAiSession("burst1", "human", null);
    queueAiGeneration(s, "你多大");
    queueAiGeneration(s, "哪里人");

    expect(s.history.map((h) => `${h.role}:${h.content}`)).toEqual([
      "user:你多大",
      "user:哪里人",
    ]);
    expect(s.pendingPlayerBurst).toEqual(["你多大", "哪里人"]);
    // Burst timer pending — not yet one-by-one u1,a1,u2.
    expect(s.aiReplyQueue).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  closeChat,
  closeConversation,
  createAiSession,
  createPvpPair,
  enqueueOpponentMessage,
  enqueueImmediateSystemMessage,
  isChatClosed,
  peekDueEvents,
} from "./store";
import { queueAiGeneration } from "./aiWorker";

describe("chat freeze + player burst history", () => {
  it("drops undelivered outbox after closeChat and resets schedule floor", () => {
    const s = createAiSession("freeze1", "human", null);
    const now = Date.now();
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
    s.lastScheduledDeliveryAt = now + 60_000;

    closeChat(s, "player_judged");
    expect(s.chatClosedAt).toBeTruthy();
    expect(s.outbox.map((e) => e.text)).toEqual(["soon"]);
    expect(s.lastScheduledDeliveryAt).toBeLessThanOrEqual(Date.now() + 5);
    expect(peekDueEvents(s, 0).map((e) => e.text)).toEqual(["soon"]);
  });

  it("system notices deliver immediately even after delayed opponent floor", () => {
    const s = createAiSession("sys1", "human", null);
    const now = Date.now();
    s.lastScheduledDeliveryAt = now + 8_000;
    enqueueImmediateSystemMessage(s, "对方已提交判断，请在 20 秒内做出你的判断");
    const due = peekDueEvents(s, 0);
    expect(due).toHaveLength(1);
    expect(due[0].text).toContain("对方已提交判断");
    expect(due[0].deliverAt).toBeLessThanOrEqual(Date.now() + 5);
  });

  it("closeConversation freezes both PVP seats on message limit", () => {
    const { sessionA, sessionB } = createPvpPair("pvpA", "pvpB");
    enqueueOpponentMessage(sessionB, "hi", Date.now() + 30_000);
    closeConversation(sessionA, "message_limit");
    expect(isChatClosed(sessionA)).toBe(true);
    expect(isChatClosed(sessionB)).toBe(true);
    expect(sessionB.outbox.some((e) => e.text === "hi")).toBe(false);
    expect(
      sessionB.localNotices.some((n) => n.includes("对话已结束")),
    ).toBe(true);
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
    expect(s.aiReplyQueue).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendUserTranscript,
  cancelPendingAssistant,
  closeChat,
  closeConversation,
  createAiSession,
  createPvpPair,
  enqueueOpponentMessage,
  enqueueImmediateSystemMessage,
  isChatClosed,
  peekDueEvents,
  schedulePendingAssistant,
} from "./store";
import { closeChatIfExpired } from "./settle";
import { queueAiGeneration } from "./aiWorker";

describe("chat freeze + transcript ordering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("keeps pending AI out of model history until deliverAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const s = createAiSession("hist1", "human", null);
    appendUserTranscript(s, "你多大", Date.now());
    schedulePendingAssistant(s, "保密", Date.now() + 5_000, s.inputRevision);
    appendUserTranscript(s, "哪里人", Date.now() + 100);

    expect(s.history.map((h) => `${h.role}:${h.content}`)).toEqual([
      "user:你多大",
      "user:哪里人",
    ]);

    cancelPendingAssistant(s);
    expect(s.transcript.some((e) => e.state === "pending")).toBe(false);
    expect(s.outbox.some((e) => e.from === "opponent")).toBe(false);

    // After cancel + re-schedule, wait past monotonic delivery floor.
    schedulePendingAssistant(s, "南方", Date.now(), s.inputRevision);
    vi.setSystemTime(Date.now() + 500);
    const due = peekDueEvents(s, 0);
    expect(due.map((e) => e.text)).toContain("南方");
    expect(s.history.map((h) => `${h.role}:${h.content}`)).toEqual([
      "user:你多大",
      "user:哪里人",
      "assistant:南方",
    ]);
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

  it("closeChatIfExpired is false for non-time close reasons", () => {
    const s = createAiSession("exp1", "human", null);
    closeChat(s, "message_limit");
    expect(closeChatIfExpired(s)).toBe(false);
    expect(s.chatCloseReason).toBe("message_limit");
  });

  it("writes rapid player lines to transcript in UI order", () => {
    const s = createAiSession("burst1", "human", null);
    queueAiGeneration(s, "你多大");
    queueAiGeneration(s, "哪里人");

    expect(s.history.map((h) => `${h.role}:${h.content}`)).toEqual([
      "user:你多大",
      "user:哪里人",
    ]);
    expect(s.inputRevision).toBe(2);
  });
});

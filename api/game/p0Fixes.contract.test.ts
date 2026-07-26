import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JUDGMENT_GRACE_MS,
  cancelPendingAssistant,
  closeChat,
  closeConversation,
  createAiSession,
  createPvpPair,
  deleteSession,
  enqueueImmediateOpponentMessage,
  getSession,
  peekDueEvents,
  schedulePendingAssistant,
} from "./store";
import { JUDGE_RESPONSE_SEC } from "@contracts/types";
import { revealIfReady } from "./settle";

describe("P0 fixes: timeout settle, leave window, pvp delivery, cancel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("AI judgment timeout settles on the same revealIfReady call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const s = createAiSession("ai-timeout-1", "human", null);
    closeChat(s, "message_limit");
    expect(s.judgmentDeadlineAt).toBe(Date.now() + JUDGMENT_GRACE_MS);

    expect(await revealIfReady(s)).toBeNull();

    vi.setSystemTime(Date.now() + JUDGMENT_GRACE_MS + 1);
    const result = await revealIfReady(s);
    expect(result).toBeTruthy();
    expect(result!.timedOut).toBe(true);
    expect(getSession("ai-timeout-1")).toBeUndefined();
  });

  it("PVP both judgment timeouts settle via revealIfReady", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { sessionA, sessionB } = createPvpPair("pvp-to-a", "pvp-to-b");
    closeChat(sessionA, "message_limit");
    closeChat(sessionB, "message_limit");

    expect(await revealIfReady(sessionA)).toBeNull();

    vi.setSystemTime(Date.now() + JUDGMENT_GRACE_MS + 1);
    const result = await revealIfReady(sessionA);
    expect(result).toBeTruthy();
    expect(result!.timedOut).toBe(true);
    expect(getSession("pvp-to-a")).toBeUndefined();
    expect(getSession("pvp-to-b")).toBeUndefined();
  });

  it("opponent leave gives remaining player a full judgment window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { room, sessionA, sessionB } = createPvpPair("leave-a", "leave-b");

    // Mirror cleanupUnclaimedGame leave path (post-fix).
    room.left.a = true;
    deleteSession(sessionA.id);
    closeChat(sessionB, "opponent_left");
    room.verdicts.a = { guess: null, timedOut: true, at: Date.now() };
    room.firstFinisher = "a";
    room.responseDeadline = Date.now() + JUDGE_RESPONSE_SEC * 1000;

    // Immediately after leave — remaining player is NOT timed out.
    expect(await revealIfReady(sessionB)).toBeNull();
    expect(sessionB.timedOut).toBe(false);
    expect(room.verdicts.b).toBeUndefined();

    // Still inside the window.
    vi.setSystemTime(Date.now() + JUDGE_RESPONSE_SEC * 1000 - 100);
    expect(await revealIfReady(sessionB)).toBeNull();
    expect(sessionB.timedOut).toBe(false);

    // Past response deadline — settle.
    vi.setSystemTime(Date.now() + 200);
    const result = await revealIfReady(sessionB);
    expect(result).toBeTruthy();
    expect(result!.timedOut).toBe(true);
  });

  it("PVP 12th message stays visible after closeConversation", () => {
    const { sessionA, sessionB } = createPvpPair("pvp12-a", "pvp12-b");
    enqueueImmediateOpponentMessage(sessionB, "最后一条");
    closeConversation(sessionA, "message_limit");

    expect(sessionB.outbox.some((e) => e.text === "最后一条")).toBe(true);
    const due = peekDueEvents(sessionB, 0);
    expect(due.map((e) => e.text)).toContain("最后一条");
  });

  it("cancels due-but-unpulled AI outbox by transcriptId", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const s = createAiSession("cancel-due-1", "human", null);
    schedulePendingAssistant(s, "幽灵回复", Date.now(), s.inputRevision);
    expect(s.outbox).toHaveLength(1);
    // Advance past deliverAt without pulling — old code only dropped future rows.
    vi.setSystemTime(s.outbox[0].deliverAt + 1);
    expect(s.outbox[0].deliverAt).toBeLessThanOrEqual(Date.now());

    cancelPendingAssistant(s);
    expect(s.outbox).toHaveLength(0);
    expect(peekDueEvents(s, 0)).toEqual([]);
    expect(s.history.some((h) => h.content === "幽灵回复")).toBe(false);
  });
});

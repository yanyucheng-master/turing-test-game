import { describe, expect, it } from "vitest";
import {
  createAiSession,
  enqueueOpponentMessage,
  peekDueEvents,
} from "./store";

describe("outbox ordering", () => {
  it("does not advance cursor past a delayed earlier message", () => {
    const session = createAiSession(
      "test-outbox-1",
      "human",
      "test",
      "normal",
      "sane",
      "campus_night_01",
    );

    const now = Date.now();
    // seq1: far future
    enqueueOpponentMessage(session, "first", now + 60_000);
    // seq2: soon — must not overtake seq1 in delivery scheduling
    enqueueOpponentMessage(session, "second", now + 100);

    // Immediately: nothing due (seq1 not due → stop)
    expect(peekDueEvents(session, 0)).toEqual([]);

    // Force seq1 due, leave seq2 after it (monotonic schedule may push seq2 later)
    session.outbox[0].deliverAt = now - 1;
    const firstBatch = peekDueEvents(session, 0);
    expect(firstBatch.length).toBeGreaterThanOrEqual(1);
    expect(firstBatch[0].text).toBe("first");
    expect(firstBatch[0].seq).toBe(1);

    // Advance cursor past first; second becomes available when due
    session.outbox[1].deliverAt = now - 1;
    const secondBatch = peekDueEvents(session, firstBatch[firstBatch.length - 1].seq);
    expect(secondBatch.some((e) => e.text === "second")).toBe(true);
  });

  it("keeps deliverAt monotonic across enqueues", () => {
    const session = createAiSession(
      "test-outbox-2",
      "human",
      "test",
      "normal",
      "sane",
      "campus_night_01",
    );
    const t0 = Date.now();
    enqueueOpponentMessage(session, "a", t0 + 5_000);
    enqueueOpponentMessage(session, "b", t0 + 200);
    expect(session.outbox[1].deliverAt).toBeGreaterThan(
      session.outbox[0].deliverAt,
    );
  });
});

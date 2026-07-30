import {
  mysqlTable,
  mysqlEnum,
  varchar,
  boolean,
  int,
  timestamp,
  index,
  text,
} from "drizzle-orm/mysql-core";

export const games = mysqlTable("games", {
  id: varchar("id", { length: 36 }).primaryKey(),
  persona: mysqlEnum("persona", ["human", "machine"]).notNull(),
  status: mysqlEnum("status", ["active", "finished", "cancelled", "abandoned"])
    .notNull()
    .default("active"),
  guess: mysqlEnum("guess", ["human", "ai"]),
  correct: boolean("correct"),
  playerMessages: int("player_messages").notNull().default(0),
  opponentMessages: int("opponent_messages").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export type Game = typeof games.$inferSelect;

/**
 * Candidate rows contain no raw phrase until three distinct anonymous sources
 * repeat the same safe normalized fingerprint. A phrase is never available to
 * gameplay while it is pending AI or owner review.
 */
export const cultureCandidates = mysqlTable(
  "culture_candidates",
  {
    fingerprint: varchar("fingerprint", { length: 64 }).primaryKey(),
    status: mysqlEnum("status", [
      "candidate",
      "pending_ai_review",
      "pending_review",
      "active",
      "rejected",
      "expired",
    ])
      .notNull()
      .default("candidate"),
    phrase: varchar("phrase", { length: 96 }),
    approvedFingerprint: varchar("approved_fingerprint", { length: 64 }),
    origin: mysqlEnum("origin", ["learned", "curated"]),
    responseMode: mysqlEnum("response_mode", [
      "play_along",
      "react_only",
      "clarify_light",
    ])
      .notNull()
      .default("play_along"),
    supportCount: int("support_count").notNull().default(0),
    openerEligible: boolean("opener_eligible").notNull().default(false),
    useCount: int("use_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    promotedAt: timestamp("promoted_at"),
    reviewPayload: text("review_payload"),
    aiReviewedAt: timestamp("ai_reviewed_at"),
    humanReviewedAt: timestamp("human_reviewed_at"),
    rejectionReason: varchar("rejection_reason", { length: 32 }),
  },
  table => [
    index("culture_candidates_status_expires_idx").on(
      table.status,
      table.expiresAt
    ),
  ]
);

export const cultureObservations = mysqlTable(
  "culture_observations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    sourceFingerprint: varchar("source_fingerprint", {
      length: 64,
    }).notNull(),
    kind: mysqlEnum("kind", ["phrase", "reaction"]).notNull(),
    responseMode: mysqlEnum("response_mode", [
      "play_along",
      "react_only",
      "clarify_light",
    ]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  table => [
    index("culture_observations_fingerprint_kind_idx").on(
      table.fingerprint,
      table.kind
    ),
  ]
);

export type CultureCandidate = typeof cultureCandidates.$inferSelect;

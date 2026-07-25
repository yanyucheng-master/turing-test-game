import {
  mysqlTable,
  mysqlEnum,
  varchar,
  boolean,
  int,
  timestamp,
} from "drizzle-orm/mysql-core";

export const games = mysqlTable("games", {
  id: varchar("id", { length: 36 }).primaryKey(),
  persona: mysqlEnum("persona", ["human", "machine"]).notNull(),
  status: mysqlEnum("status", ["active", "finished"])
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

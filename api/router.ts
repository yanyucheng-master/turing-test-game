import { createRouter, publicQuery } from "./middleware";
import { gameRouter } from "./game/router";
import { cultureReviewRouter } from "./game/cultureReviewRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  game: gameRouter,
  cultureReview: cultureReviewRouter,
});

export type AppRouter = typeof appRouter;

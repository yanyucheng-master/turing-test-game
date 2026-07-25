import { createRouter, publicQuery } from "./middleware";
import { gameRouter } from "./game/router";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  game: gameRouter,
});

export type AppRouter = typeof appRouter;

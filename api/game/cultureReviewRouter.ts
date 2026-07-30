import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import {
  approveCultureCandidate,
  CultureReviewError,
  getCultureReviewReport,
  rejectCultureCandidate,
  retryPendingCultureReviews,
} from "./cultureMemory";
import { checkRateLimit, clientIp } from "./rateLimit";
import { hasValidCultureReviewCompanionToken } from "./cultureReviewAdmin";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

function setAdminResponseHeaders(headers: Headers): void {
  headers.set("Cache-Control", "no-store, private");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", "Cookie");
  headers.set("X-Content-Type-Options", "nosniff");
}

const ownerProcedure = publicQuery.use(({ ctx, next }) => {
  setAdminResponseHeaders(ctx.resHeaders);
  if (hasValidCultureReviewCompanionToken(ctx.req)) {
    return next({ ctx });
  }

  const ip = clientIp(ctx.req);
  if (!checkRateLimit(`${ip}:culture-review-companion`, 30, 60_000)) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Not Found",
    });
  }
  throw new TRPCError({ code: "NOT_FOUND", message: "Not Found" });
});

function throwReviewError(error: unknown): never {
  if (!(error instanceof CultureReviewError)) throw error;
  const code =
    error.code === "not_found"
      ? "NOT_FOUND"
      : error.code === "duplicate_active"
        ? "CONFLICT"
        : "BAD_REQUEST";
  throw new TRPCError({ code, message: error.message });
}

export const cultureReviewRouter = createRouter({
  session: ownerProcedure.query(() => ({ authenticated: true as const })),

  report: ownerProcedure.query(async () => getCultureReviewReport()),

  retryAiReview: ownerProcedure
    .input(z.object({ limit: z.number().int().min(1).max(20).default(10) }))
    .mutation(async ({ input }) => retryPendingCultureReviews(input.limit)),

  approve: ownerProcedure
    .input(
      z.object({
        fingerprint: fingerprintSchema,
        editedPhrase: z.string().trim().min(3).max(64).optional(),
        allowAsOpener: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const cue = await approveCultureCandidate(input);
        return {
          ok: true as const,
          phrase: cue.phrase,
          origin: cue.origin,
          openerEligible: cue.openerEligible,
        };
      } catch (error) {
        throwReviewError(error);
      }
    }),

  reject: ownerProcedure
    .input(z.object({ fingerprint: fingerprintSchema }))
    .mutation(async ({ input }) => {
      try {
        await rejectCultureCandidate(input);
        return { ok: true as const };
      } catch (error) {
        throwReviewError(error);
      }
    }),
});

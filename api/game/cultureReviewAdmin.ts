import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env";

const TOKEN_MIN_LENGTH = 24;
export const CULTURE_REVIEW_COMPANION_HEADER =
  "x-culture-review-companion-token";

function fixedLengthEqual(expected: string, actual: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const actualHash = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

export function cultureReviewTokenMatches(provided: string): boolean {
  const expected = env.cultureReviewToken.trim();
  return (
    expected.length >= TOKEN_MIN_LENGTH &&
    provided.length > 0 &&
    fixedLengthEqual(expected, provided)
  );
}

export function hasValidCultureReviewCompanionToken(req: Request): boolean {
  // The shared credential belongs only in the local Node proxy. Reject a copy
  // presented by browser fetch, even if a future CORS change is too permissive.
  if (req.headers.has("origin") || req.headers.has("sec-fetch-site")) {
    return false;
  }
  return cultureReviewTokenMatches(
    req.headers.get(CULTURE_REVIEW_COMPANION_HEADER) ?? ""
  );
}

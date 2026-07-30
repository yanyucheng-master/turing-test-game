const CULTURE_REVIEW_PROCEDURES = new Set([
  "cultureReview.session",
  "cultureReview.report",
  "cultureReview.retryAiReview",
  "cultureReview.approve",
  "cultureReview.reject",
]);

type RequestHeaders = {
  host?: string | string[];
  origin?: string | string[];
  "sec-fetch-site"?: string | string[];
};

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value)
    ? (value[0]?.trim() ?? "")
    : (value?.trim() ?? "");
}

export function isAllowedLocalRequest(
  headers: RequestHeaders,
  port: number
): boolean {
  const host = firstHeader(headers.host).toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return false;
  }

  const fetchSite = firstHeader(headers["sec-fetch-site"]).toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  const origin = firstHeader(headers.origin);
  if (!origin) return true;
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

export function isAllowedCultureReviewRpcPath(pathname: string): boolean {
  const prefix = "/api/trpc/";
  if (!pathname.startsWith(prefix)) return false;

  let procedureList: string;
  try {
    procedureList = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return false;
  }

  const procedures = procedureList.split(",").filter(Boolean);
  return (
    procedures.length > 0 &&
    procedures.every(procedure => CULTURE_REVIEW_PROCEDURES.has(procedure))
  );
}

export function normalizeRemoteOrigin(rawValue: string): string {
  let url: URL;
  try {
    url = new URL(rawValue.trim());
  } catch {
    throw new Error("ADMIN_REMOTE_URL 不是有效网址");
  }

  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(isLoopback && url.protocol === "http:")) {
    throw new Error("ADMIN_REMOTE_URL 必须使用 HTTPS");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("ADMIN_REMOTE_URL 只能填写站点根地址，不能包含路径或凭证");
  }
  return url.origin;
}

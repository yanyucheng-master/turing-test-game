import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";
import {
  isAllowedCultureReviewRpcPath,
  isAllowedLocalRequest,
  normalizeRemoteOrigin,
} from "./security";

const MAX_PROXY_BODY_BYTES = 1_000_000;
const COMPANION_TOKEN_HEADER = "x-culture-review-companion-token";
const DEFAULT_LOCAL_PORT = 3001;

export type LocalAdminConfig = {
  remoteOrigin: string;
  token: string;
  localPort: number;
  adminDist: string;
  autoOpen: boolean;
};

function projectRoot(): string {
  return path.resolve(import.meta.dirname, "..");
}

export function loadLocalAdminConfig(): LocalAdminConfig {
  const root = projectRoot();
  loadEnvFile({
    path: path.resolve(root, ".env.admin.local"),
    override: false,
    quiet: true,
  });

  const remoteOrigin = normalizeRemoteOrigin(
    process.env.ADMIN_REMOTE_URL?.trim() ?? ""
  );
  const token = process.env.CULTURE_REVIEW_TOKEN?.trim() ?? "";
  if (token.length < 24) {
    throw new Error(
      "CULTURE_REVIEW_TOKEN 至少需要 24 位，并须与 Render 环境变量完全一致"
    );
  }

  const localPort = Number.parseInt(
    process.env.ADMIN_LOCAL_PORT || String(DEFAULT_LOCAL_PORT),
    10
  );
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65_535) {
    throw new Error("ADMIN_LOCAL_PORT 必须是 1024–65535 之间的端口");
  }

  return {
    remoteOrigin,
    token,
    localPort,
    adminDist: path.resolve(root, "dist/admin"),
    autoOpen: process.env.ADMIN_AUTO_OPEN?.toLowerCase() !== "false",
  };
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8"
): void {
  setSecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_PROXY_BODY_BYTES) {
      throw new Error("request_body_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function proxyCultureReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  config: LocalAdminConfig
): Promise<void> {
  if (
    (req.method !== "GET" && req.method !== "POST") ||
    !isAllowedCultureReviewRpcPath(requestUrl.pathname)
  ) {
    sendText(res, 404, "Not Found");
    return;
  }

  let body: Buffer | undefined;
  try {
    body = req.method === "POST" ? await readRequestBody(req) : undefined;
  } catch (error) {
    const status =
      error instanceof Error && error.message === "request_body_too_large"
        ? 413
        : 400;
    sendText(res, status, status === 413 ? "Payload Too Large" : "Bad Request");
    return;
  }

  const remoteUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    config.remoteOrigin
  );
  const headers = new Headers({
    Accept: req.headers.accept ?? "application/json",
    "User-Agent": "turing-test-local-admin-companion/1",
    [COMPANION_TOKEN_HEADER]: config.token,
  });
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") {
    headers.set("Content-Type", contentType);
  }
  const trpcAccept = req.headers["trpc-accept"];
  if (typeof trpcAccept === "string") {
    headers.set("trpc-accept", trpcAccept);
  }

  let upstream: Response;
  try {
    upstream = await fetch(remoteUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      // Render Free can take close to a minute to wake from an idle spin-down.
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    sendText(
      res,
      502,
      JSON.stringify({
        error: {
          message: "无法连接 Render 管理接口，请检查网络和 ADMIN_REMOTE_URL",
        },
      }),
      "application/json; charset=utf-8"
    );
    return;
  }

  setSecurityHeaders(res);
  res.statusCode = upstream.status;
  res.setHeader(
    "Content-Type",
    upstream.headers.get("content-type") ?? "application/json; charset=utf-8"
  );
  const payload = Buffer.from(await upstream.arrayBuffer());
  res.end(payload);
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

async function serveAdminAsset(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  config: LocalAdminConfig
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const relativePath =
    requestUrl.pathname === "/"
      ? "index.html"
      : decodeURIComponent(requestUrl.pathname.slice(1));
  const target = path.resolve(config.adminDist, relativePath);
  const relative = path.relative(config.adminDist, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(res, 404, "Not Found");
    return;
  }

  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("not_file");
    const contents = await readFile(target);
    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      MIME_TYPES[path.extname(target).toLowerCase()] ??
        "application/octet-stream"
    );
    res.end(req.method === "HEAD" ? undefined : contents);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

export function createLocalAdminServer(config: LocalAdminConfig) {
  return createServer((req, res) => {
    void (async () => {
      setSecurityHeaders(res);
      if (!isAllowedLocalRequest(req.headers, config.localPort)) {
        sendText(res, 404, "Not Found");
        return;
      }

      let requestUrl: URL;
      try {
        requestUrl = new URL(
          req.url ?? "/",
          `http://127.0.0.1:${config.localPort}`
        );
      } catch {
        sendText(res, 400, "Bad Request");
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        await proxyCultureReviewRequest(req, res, requestUrl, config);
        return;
      }
      await serveAdminAsset(req, res, requestUrl, config);
    })().catch(() => {
      if (!res.headersSent) {
        sendText(res, 500, "Internal Server Error");
      } else {
        res.destroy();
      }
    });
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function startLocalAdminServer(): Promise<void> {
  const config = loadLocalAdminConfig();
  const server = createLocalAdminServer(config);
  const url = `http://127.0.0.1:${config.localPort}`;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.localPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`本机管理员已启动：${url}`);
  console.log("管理员页面仅监听 127.0.0.1；关闭此窗口即可停止。");
  if (config.autoOpen) openBrowser(url);

  const close = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  startLocalAdminServer().catch(error => {
    console.error(
      error instanceof Error ? `本机管理员启动失败：${error.message}` : error
    );
    process.exitCode = 1;
  });
}

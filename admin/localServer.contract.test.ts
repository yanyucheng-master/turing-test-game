import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalAdminServer, type LocalAdminConfig } from "./localServer";
import {
  isAllowedCultureReviewRpcPath,
  isAllowedLocalRequest,
  normalizeRemoteOrigin,
} from "./security";

const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  runningServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  runningServers.splice(runningServers.indexOf(probe), 1);
  return port;
}

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { force: true, recursive: true }))
  );
});

describe("local admin companion security", () => {
  it("allows only its loopback host and same-origin browser requests", () => {
    expect(
      isAllowedLocalRequest(
        {
          host: "127.0.0.1:3001",
          origin: "http://127.0.0.1:3001",
          "sec-fetch-site": "same-origin",
        },
        3001
      )
    ).toBe(true);
    expect(
      isAllowedLocalRequest(
        {
          host: "admin.attacker.example:3001",
          origin: "https://admin.attacker.example",
        },
        3001
      )
    ).toBe(false);
    expect(
      isAllowedLocalRequest(
        {
          host: "127.0.0.1:3001",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        3001
      )
    ).toBe(false);
  });

  it("proxies only the five review procedures", () => {
    expect(
      isAllowedCultureReviewRpcPath(
        "/api/trpc/cultureReview.session,cultureReview.report"
      )
    ).toBe(true);
    expect(isAllowedCultureReviewRpcPath("/api/trpc/cultureReview.login")).toBe(
      false
    );
    expect(isAllowedCultureReviewRpcPath("/api/trpc/game.stats")).toBe(false);
  });

  it("requires HTTPS except for loopback test targets", () => {
    expect(normalizeRemoteOrigin("https://game.onrender.com/")).toBe(
      "https://game.onrender.com"
    );
    expect(normalizeRemoteOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000"
    );
    expect(() => normalizeRemoteOrigin("http://game.onrender.com")).toThrow(
      "HTTPS"
    );
    expect(() =>
      normalizeRemoteOrigin("https://game.onrender.com/admin")
    ).toThrow("根地址");
  });

  it("keeps the shared secret server-side while forwarding approved RPC calls", async () => {
    let observedToken = "";
    let remoteRequests = 0;
    const remote = createServer((req, res) => {
      remoteRequests += 1;
      observedToken =
        typeof req.headers["x-culture-review-companion-token"] === "string"
          ? req.headers["x-culture-review-companion-token"]
          : "";
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end('{"result":{"data":{"json":{"authenticated":true}}}}');
    });
    const remotePort = await listen(remote);

    const adminDist = await mkdtemp(
      path.join(tmpdir(), "turing-admin-companion-")
    );
    temporaryDirectories.push(adminDist);
    await mkdir(path.join(adminDist, "assets"));
    await writeFile(
      path.join(adminDist, "index.html"),
      "<!doctype html><title>local owner only</title>",
      "utf8"
    );

    const localPort = await reservePort();
    const config: LocalAdminConfig = {
      remoteOrigin: `http://127.0.0.1:${remotePort}`,
      token: "local-companion-contract-token-32-characters",
      localPort,
      adminDist,
      autoOpen: false,
    };
    const companion = createLocalAdminServer(config);
    await listen(companion, localPort);

    const localOrigin = `http://127.0.0.1:${localPort}`;
    const page = await fetch(localOrigin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("local owner only");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );

    const report = await fetch(
      `${localOrigin}/api/trpc/cultureReview.session`,
      {
        headers: {
          Origin: localOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
      }
    );
    expect(report.status).toBe(200);
    expect(await report.text()).toContain('"authenticated":true');
    expect(observedToken).toBe(config.token);
    expect(remoteRequests).toBe(1);

    const blocked = await fetch(`${localOrigin}/api/trpc/game.stats`, {
      headers: { Origin: localOrigin, "Sec-Fetch-Site": "same-origin" },
    });
    expect(blocked.status).toBe(404);
    expect(remoteRequests).toBe(1);
  });
});

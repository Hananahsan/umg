import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { UmgApp } from "../app.js";
import { buildOverview, type Overview } from "./api.js";
import { assetsPresent, serveAsset } from "./static.js";
import { log } from "../util/log.js";

const HOST = "127.0.0.1";

export interface InspectorOptions {
  /** The app over the user's real database. Absent in `--demo` mode. */
  app?: UmgApp;
  /** Lazily built so a healthy database never pays for the demo dataset. */
  demoFactory?: () => Promise<UmgApp>;
  /** Serve the demo dataset as the default view. */
  demoFirst?: boolean;
  port?: number;
  /** Serve JSON only — for `vite dev` proxying during UI work. */
  apiOnly?: boolean;
}

export interface InspectorHandle {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

type Source = "database" | "demo";

export async function startInspector(
  opts: InspectorOptions,
): Promise<InspectorHandle> {
  if (!opts.app && !opts.demoFactory) {
    throw new Error("Inspector needs either a database app or a demo factory");
  }

  let demoApp: UmgApp | null = null;
  const overviewCache = new Map<Source, Overview>();

  async function appFor(source: Source): Promise<UmgApp> {
    if (source === "demo") {
      if (!opts.demoFactory) throw new HttpError(404, "demo dataset disabled");
      demoApp ??= await opts.demoFactory();
      return demoApp;
    }
    if (!opts.app) throw new HttpError(404, "no database opened; started with --demo");
    return opts.app;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log.warn("inspector request failed", { error: String(err) });
      sendJson(res, status, { error: String(err instanceof Error ? err.message : err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${HOST}`);

    // DNS-rebinding guard: a page on another origin must not reach this server.
    if (!hostAllowed(req.headers.host, (server.address() as AddressInfo)?.port)) {
      throw new HttpError(403, "forbidden host header");
    }

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, read_only: true });
    }

    if (url.pathname === "/api/overview") {
      const source = resolveSource(url.searchParams.get("source"), opts);
      const cached = overviewCache.get(source);
      if (cached && url.searchParams.get("refresh") !== "1") {
        return sendJson(res, 200, cached);
      }
      const overview = await buildOverview(await appFor(source), source);
      overviewCache.set(source, overview);
      return sendJson(res, 200, overview);
    }

    if (url.pathname.startsWith("/api/")) {
      throw new HttpError(404, `unknown endpoint: ${url.pathname}`);
    }

    if (opts.apiOnly) {
      throw new HttpError(404, "running with --api-only; static assets not served");
    }
    if (!serveAsset(url.pathname, res)) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        "Inspector UI assets are missing.\n" +
          "Run `npm run build` (or `npm run build:ui` after changing inspector-ui/).\n",
      );
    }
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, HOST, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });

  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${HOST}:${port}`,
    port,
    server,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      demoApp?.close();
    },
  };
}

function resolveSource(param: string | null, opts: InspectorOptions): Source {
  if (param === "demo") return "demo";
  if (param === "database") return "database";
  return opts.demoFirst || !opts.app ? "demo" : "database";
}

/** Only same-machine loopback hosts on our own port. */
function hostAllowed(host: string | undefined, port: number | undefined): boolean {
  if (!host) return false;
  const expected = new Set(
    port
      ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
      : ["127.0.0.1", "localhost", "[::1]"],
  );
  return expected.has(host.toLowerCase());
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export { assetsPresent };

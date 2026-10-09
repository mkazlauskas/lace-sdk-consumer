import { readFileSync, statSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { Plugin, ProxyOptions } from "vite";

// The fee sponsor relay of the Vite dev and preview servers. The hosted fee
// sponsor sends no CORS headers and its client key is a bearer secret, so
// the browser calls this relay on its own origin, without a key, and the
// relay forwards the call with the key it reads from the server process's
// environment or `.env` files. The key never reaches the browser bundle:
// only `VITE_` variables do. A `vite build` output has no relay; a deployed
// app needs a relay on its own backend.

/** Where the browser calls the fee sponsor: this path on the app's own origin. */
export const SPONSOR_RELAY_PATH = "/sponsor";
/** The proxy context of the relay: the relay path and everything below it, never a longer name such as `/sponsorship`. */
export const SPONSOR_RELAY_CONTEXT = `^${SPONSOR_RELAY_PATH}(?:[/?]|$)`;
export const DEFAULT_SPONSOR_URL = "https://sponsor-preprod.lw.iog.io";

/** The variables the relay reads: `SPONSOR_*`, and the `VITE_*` names it checks for a misplaced key. */
export type SponsorRelayEnvironment = Record<string, string | undefined>;

/**
 * The sponsor's client API: the only routes the relay forwards. Lease ids
 * are UUIDs, so a dot segment or an encoded slash never reaches the service.
 */
const CLIENT_ROUTES: readonly (readonly [method: string, path: RegExp])[] = [
  ["GET", /^\/health$/],
  ["POST", /^\/v1\/leases$/],
  ["DELETE", /^\/v1\/leases\/[\dA-Za-z-]+$/],
  ["POST", /^\/v1\/leases\/[\dA-Za-z-]+\/witness$/],
  ["GET", /^\/v1\/collateral$/],
  ["POST", /^\/v1\/collateral\/witness$/],
];

/** Browser credentials that must never reach the sponsor: the relay's key is the only credential it sends. */
const DROPPED_REQUEST_HEADERS = ["authorization", "proxy-authorization", "cookie"] as const;

/**
 * `Sec-Fetch-Site` values of requests from this app's own pages: their
 * fetches, and a relay URL the operator opens from the address bar.
 */
const OWN_FETCH_SITES = new Set(["same-origin", "none"]);

// RFC 6750 token68, as the SDK's sponsor client requires of a key.
const BEARER_TOKEN = /^[\w.~+/-]+=*$/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The base the relay resolves a service path against. A path that changes the host, as `//host/...` does, is refused. */
const SERVICE_BASE = "http://relay.invalid";

/**
 * The relay's variables from the `.env` files Vite reads for `mode` in
 * `envDir`, with the process environment over them, in Vite's order. The
 * relay reads the files itself, not through Vite's `loadEnv`, whose debug
 * log (`vite --debug`, `DEBUG=vite:env`) prints every variable it loads.
 */
export function readSponsorRelayEnvironment(mode: string, envDir: string | false): SponsorRelayEnvironment {
  const files = envDir === false ? [] : [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`].map((name) => join(envDir, name));
  const merged: Record<string, string | undefined> = {};
  for (const file of files) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    Object.assign(merged, parseEnv(readFileSync(file, "utf8")));
  }
  Object.assign(merged, process.env);
  return Object.fromEntries(Object.entries(merged).filter(([name]) => name.startsWith("SPONSOR_") || name.startsWith("VITE_")));
}

/** The sponsor's base URL: https, or http to a loopback host for a sponsor running locally. */
export function sponsorTarget(sponsorUrl: string | undefined): string {
  const value = sponsorUrl?.trim() || DEFAULT_SPONSOR_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`SPONSOR_URL is not a URL: ${value}`);
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) {
    throw new Error("SPONSOR_URL must be an https URL, or http to a loopback host, without credentials, query or fragment");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Refuses a sponsor key the client bundle would carry. Vite inlines every
 * `VITE_` variable a module reads, so a key under such a name is one import
 * away from every visitor.
 */
export function assertNoClientSponsorKey(env: SponsorRelayEnvironment): void {
  const exposed = Object.keys(env).filter((name) => name.startsWith("VITE_") && /SPONSOR/.test(name) && /KEY|SECRET|TOKEN/.test(name));
  if (exposed.length > 0) {
    throw new Error(`${exposed.join(", ")} would be inlined into the browser bundle. Name the fee sponsor key SPONSOR_API_KEY, without the VITE_ prefix.`);
  }
}

/**
 * The normalized service path and query of a relay URL, or undefined when
 * the path would leave the service: `//host/...` and `/\host/...` name
 * another host. The relay checks this path and forwards this same path.
 */
export function servicePathOf(url: string): string | undefined {
  const rest = url.slice(SPONSOR_RELAY_PATH.length);
  let parsed: URL;
  try {
    parsed = new URL(rest.startsWith("/") ? rest : `/${rest}`, SERVICE_BASE);
  } catch {
    return undefined;
  }
  return parsed.origin === SERVICE_BASE ? `${parsed.pathname}${parsed.search}` : undefined;
}

type Refusal = { status: number; error: string; detail: string };
type RelayRequest = { method?: string; url?: string; headers: IncomingHttpHeaders };

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
};

/**
 * Why a request does not come from this app's own pages. A page on another
 * site cannot read the relay's answers, but a CORS-simple request, such as a
 * `POST` without a preflight, would still reach the sponsor with the key.
 * Browsers mark such a request with `Sec-Fetch-Site` and, for a `POST`, with
 * an `Origin` other than the relay's own.
 */
function crossSiteRefusalOf(headers: IncomingHttpHeaders): Refusal | undefined {
  const refusal = { status: 403, error: "cross_site_request", detail: "The sponsor relay serves only the pages of its own origin." };
  const site = header(headers, "sec-fetch-site");
  if (site !== undefined && !OWN_FETCH_SITES.has(site)) return refusal;
  const origin = header(headers, "origin");
  if (origin === undefined) return undefined;
  const host = header(headers, "host") ?? header(headers, ":authority");
  try {
    return new URL(origin).host === host ? undefined : refusal;
  } catch {
    // `Origin: null`, from a sandboxed frame or a file.
    return refusal;
  }
}

/** Whether a request carries a body. */
const hasBody = (headers: IncomingHttpHeaders) => header(headers, "transfer-encoding") !== undefined || (header(headers, "content-length") ?? "0") !== "0";
const mediaTypeOf = (headers: IncomingHttpHeaders) => header(headers, "content-type")?.split(";")[0].trim().toLowerCase();

/** Why the relay answers a request itself instead of forwarding it, or undefined to forward. */
export function relayRefusalOf({ method, url = "", headers }: RelayRequest, apiKey: string | undefined): Refusal | undefined {
  const path = servicePathOf(url);
  const pathname = path === undefined ? undefined : new URL(path, SERVICE_BASE).pathname;
  if (pathname === undefined || !CLIENT_ROUTES.some(([routeMethod, route]) => routeMethod === method && route.test(pathname))) {
    return { status: 404, error: "not_found", detail: `The sponsor relay forwards only the fee sponsor's client API, not ${method} ${pathname ?? url.slice(SPONSOR_RELAY_PATH.length)}` };
  }
  const crossSite = crossSiteRefusalOf(headers);
  if (crossSite) return crossSite;
  // The sponsor reads JSON only. A JSON body from another origin needs a
  // CORS preflight, which never reaches the relay.
  if (hasBody(headers) && mediaTypeOf(headers) !== "application/json") {
    return { status: 415, error: "unsupported_media_type", detail: "The sponsor relay forwards only JSON bodies." };
  }
  if (apiKey === undefined) {
    return {
      status: 503,
      error: "relay_not_configured",
      detail: "The development server has no SPONSOR_API_KEY. Set it in its environment or in .env, then restart the server.",
    };
  }
  if (!BEARER_TOKEN.test(apiKey)) {
    return { status: 503, error: "relay_not_configured", detail: "The development server's SPONSOR_API_KEY is not a bearer token." };
  }
  return undefined;
}

/** Answers a request the relay does not forward with the sponsor's error body, `{ error, detail }`, which the SDK reports as a `CardanoCustodySponsorError`. */
function answer(res: ServerResponse, { status, error, detail }: Refusal) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error, detail }));
}

/**
 * The proxy options of the relay, for `server.proxy` and `preview.proxy`
 * under `SPONSOR_RELAY_CONTEXT`. It forwards the client API, called from
 * the relay's own origin, to `SPONSOR_URL` with
 * `authorization: Bearer <SPONSOR_API_KEY>` in place of the browser's own
 * authorization and cookies, and returns the service's status and body
 * unchanged. Without a key it forwards nothing. Any program that can reach
 * the dev server, unlike a page of another origin, can spend the key's
 * quotas through it.
 */
export function sponsorRelay(env: SponsorRelayEnvironment): ProxyOptions {
  assertNoClientSponsorKey(env);
  const target = sponsorTarget(env.SPONSOR_URL);
  const apiKey = env.SPONSOR_API_KEY?.trim() || undefined;
  return {
    target,
    changeOrigin: true,
    bypass(req: IncomingMessage, res: ServerResponse | undefined) {
      const refusal = relayRefusalOf(req, apiKey);
      if (!refusal) {
        // Forward the normalized path the check accepted, not the raw one.
        req.url = `${SPONSOR_RELAY_PATH}${servicePathOf(req.url ?? "")}`;
        return undefined;
      }
      if (!res) return false;
      answer(res, refusal);
      // A string with the response ended tells Vite the request is handled.
      return req.url ?? SPONSOR_RELAY_PATH;
    },
    rewrite: (url) => url.slice(SPONSOR_RELAY_PATH.length),
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        for (const name of DROPPED_REQUEST_HEADERS) proxyReq.removeHeader(name);
        proxyReq.setHeader("authorization", `Bearer ${apiKey}`);
      });
      proxy.on("proxyRes", (proxyRes) => {
        delete proxyRes.headers["set-cookie"];
      });
    },
  };
}

/**
 * The relay as a Vite plugin: it reads its variables for the config's mode
 * from the config's `envDir`, as Vite does, and sets `server.proxy` and
 * `preview.proxy`. It runs for `vite build` too, so a build refuses a
 * `VITE_` sponsor key.
 */
export function sponsorRelayPlugin(): Plugin {
  return {
    name: "lace-sponsor-relay",
    config(config, { mode }) {
      const root = config.root ? resolve(config.root) : process.cwd();
      const envDir = config.envDir === false ? false : config.envDir ? resolve(root, config.envDir) : root;
      const proxy = { [SPONSOR_RELAY_CONTEXT]: sponsorRelay(readSponsorRelayEnvironment(mode, envDir)) };
      return { server: { proxy }, preview: { proxy } };
    },
  };
}

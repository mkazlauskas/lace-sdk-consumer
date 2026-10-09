import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { createServer, preview } from "vite";
import {
  DEFAULT_SPONSOR_URL,
  SPONSOR_RELAY_CONTEXT,
  assertNoClientSponsorKey,
  readSponsorRelayEnvironment,
  relayRefusalOf,
  sponsorRelay,
  sponsorTarget,
} from "../sponsor-relay.ts";

// The fee sponsor relay, through real Vite servers, against a local
// stand-in for the sponsor that records what reaches it. No test reads this
// checkout's own `.env`: every server takes its env files from a temporary
// directory, and the relay's variables in this process's environment are
// set aside while the tests run.

const KEY = "relay-test-key";
const CONFIG_FILE = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const REPOSITORY = dirname(CONFIG_FILE);
const LEASE_WITNESS = "/v1/leases/0b6c3c1e-2d6f-4f43-9a55-7f6f0b9e7a10/witness";
const RELAY_VARIABLES = ["SPONSOR_URL", "SPONSOR_API_KEY"];
const savedEnvironment = Object.fromEntries(RELAY_VARIABLES.map((name) => [name, process.env[name]]));
const upstream = { requests: [], server: undefined, url: "" };
const servers = [];
let root;
let envDir;

/** One request with exactly this path and these headers, as a browser or another client could send it. */
function send(base, method, path, { headers = {}, body } = {}) {
  const { hostname, port } = new URL(base);
  const length = body === undefined ? {} : { "content-length": Buffer.byteLength(body) };
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname, port, method, path, headers: { ...length, ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
const json = (response) => JSON.parse(response.text);
const origin = (server) => `http://127.0.0.1:${server.httpServer.address().port}`;

/** A Vite dev server, rooted in a temporary directory, whose relay forwards to the stand-in with `env` as its environment. */
async function relayServer(env) {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, watch: null, proxy: { [SPONSOR_RELAY_CONTEXT]: sponsorRelay({ SPONSOR_URL: upstream.url, ...env }) } },
  });
  await server.listen();
  servers.push(server);
  return origin(server);
}

/** The app's own vite.config.ts, as `npm run dev` and `npm run preview` load it, with its env files from `envDir`. */
const appConfig = () => ({ configFile: CONFIG_FILE, root: REPOSITORY, envDir, cacheDir: join(envDir, ".vite"), logLevel: "silent" });

before(async () => {
  for (const name of RELAY_VARIABLES) delete process.env[name];
  root = mkdtempSync(join(tmpdir(), "sponsor-relay-"));
  envDir = mkdtempSync(join(tmpdir(), "sponsor-relay-env-"));
  mkdirSync(join(envDir, "dist"));
  upstream.server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      upstream.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(req.url === "/v1/leases" ? 201 : 200, { "content-type": "application/json", "set-cookie": "sponsor=1" });
      res.end(JSON.stringify({ echoed: req.url }));
    });
  });
  await new Promise((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
  upstream.url = `http://127.0.0.1:${upstream.server.address().port}`;
  // The app's env files: a key for every mode, and another for development.
  writeFileSync(join(envDir, ".env"), `SPONSOR_URL=${upstream.url}\nSPONSOR_API_KEY=file-key\n`);
  writeFileSync(join(envDir, ".env.development"), "SPONSOR_API_KEY=development-key\n");
});

afterEach(() => {
  for (const name of RELAY_VARIABLES) delete process.env[name];
});

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await new Promise((resolve) => upstream.server.close(resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(envDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnvironment)) if (value !== undefined) process.env[name] = value;
});

test("forwards the client API with the relay's key in place of the browser's credentials", async () => {
  const relay = await relayServer({ SPONSOR_API_KEY: KEY });
  upstream.requests.length = 0;
  const body = JSON.stringify({ transaction: "84a0" });
  const headers = { authorization: "Bearer browser-token", cookie: "session=1", "proxy-authorization": "Basic x", "content-type": "application/json" };
  const response = await send(relay, "POST", `/sponsor${LEASE_WITNESS}`, { headers, body });
  assert.equal(response.status, 200);
  assert.deepEqual(json(response), { echoed: LEASE_WITNESS });
  assert.equal(response.headers["set-cookie"], undefined);
  const [forwarded] = upstream.requests;
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.authorization, `Bearer ${KEY}`);
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers["proxy-authorization"], undefined);
  assert.equal(forwarded.body, body);

  // The service's status comes back unchanged. A lease request has no body.
  assert.equal((await send(relay, "POST", "/sponsor/v1/leases")).status, 201);
  assert.deepEqual(json(await send(relay, "GET", "/sponsor/health")), { echoed: "/health" });
});

test("answers outside the client API itself and forwards nothing", async () => {
  const relay = await relayServer({ SPONSOR_API_KEY: KEY });
  upstream.requests.length = 0;
  const outside = [
    ["POST", "/sponsor/admin/keys"],
    ["GET", "/sponsor/v1/leases"],
    ["DELETE", "/sponsor/v1/leases/a%2Fadmin"],
    ["GET", "/sponsor"],
    // A service path that starts with `//` or `/\` names another host to a URL parser.
    ["GET", "/sponsor//admin/health"],
    ["GET", "/sponsor//u:p@admin:1/v1/collateral"],
    ["GET", "/sponsor/\\evil.example/health"],
  ];
  for (const [method, path] of outside) {
    const response = await send(relay, method, path);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(json(response).error, "not_found");
  }
  // A longer path is not the relay's.
  await send(relay, "GET", "/sponsorship/health");
  assert.deepEqual(upstream.requests, []);
});

test("forwards the normalized path it checked", async () => {
  const relay = await relayServer({ SPONSOR_API_KEY: KEY });
  upstream.requests.length = 0;
  assert.equal((await send(relay, "GET", "/sponsor/v1/../health?probe=1")).status, 200);
  assert.deepEqual(upstream.requests.map(({ url }) => url), ["/health?probe=1"]);
});

test("refuses a request from another origin, which a browser may send without a preflight, and forwards nothing", async () => {
  const relay = await relayServer({ SPONSOR_API_KEY: KEY });
  upstream.requests.length = 0;
  const textBody = { headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ transaction: "84a0" }) };
  const foreign = [
    // A cross-site page's no-cors POST.
    { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", origin: "https://evil.example" },
    // Another dev server on localhost is the same site but another origin.
    { "sec-fetch-site": "same-site", origin: "http://localhost:3000" },
    // A browser without Fetch Metadata still names the origin of a POST.
    { origin: "http://localhost:3000" },
    // A sandboxed frame or a file.
    { origin: "null" },
  ];
  for (const headers of foreign) {
    for (const [path, options] of [["/sponsor/v1/leases", {}], [`/sponsor${LEASE_WITNESS}`, textBody]]) {
      const response = await send(relay, "POST", path, { ...options, headers: { ...options.headers, ...headers } });
      assert.equal(response.status, 403, `${JSON.stringify(headers)} ${path}`);
      assert.equal(json(response).error, "cross_site_request");
    }
  }
  assert.deepEqual(upstream.requests, []);

  // The app's own page names the relay's own origin; the operator may open a relay URL from the address bar.
  const sameOrigin = { "sec-fetch-site": "same-origin", origin: relay, "content-type": "application/json" };
  assert.equal((await send(relay, "POST", `/sponsor${LEASE_WITNESS}`, { headers: sameOrigin, body: "{}" })).status, 200);
  assert.equal((await send(relay, "GET", "/sponsor/health", { headers: { "sec-fetch-site": "none" } })).status, 200);
  assert.equal(upstream.requests.length, 2);
});

test("forwards only JSON bodies", async () => {
  const relay = await relayServer({ SPONSOR_API_KEY: KEY });
  upstream.requests.length = 0;
  const response = await send(relay, "POST", "/sponsor/v1/collateral/witness", { headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(response.status, 415);
  assert.equal(json(response).error, "unsupported_media_type");
  assert.deepEqual(upstream.requests, []);
});

test("without a key, answers a clear error and forwards nothing", async () => {
  const relay = await relayServer({ SPONSOR_API_KEY: "" });
  upstream.requests.length = 0;
  const response = await send(relay, "GET", "/sponsor/health");
  assert.equal(response.status, 503);
  const body = json(response);
  assert.equal(body.error, "relay_not_configured");
  assert.match(body.detail, /SPONSOR_API_KEY/);
  assert.deepEqual(upstream.requests, []);
});

test("refuses a malformed key without naming it", () => {
  const refusal = relayRefusalOf({ method: "GET", url: "/sponsor/health", headers: {} }, "key with\nnewline");
  assert.equal(refusal.error, "relay_not_configured");
  assert.doesNotMatch(refusal.detail, /newline/);
  assert.equal(relayRefusalOf({ method: "GET", url: "/sponsor/health?x=1", headers: {} }, KEY), undefined);
});

test("the app's config relays /sponsor on the dev server with the key from its env files or its environment", async () => {
  const fromFiles = await createServer({ ...appConfig(), server: { host: "127.0.0.1", port: 0, watch: null } });
  await fromFiles.listen();
  servers.push(fromFiles);
  upstream.requests.length = 0;
  assert.equal((await send(origin(fromFiles), "GET", "/sponsor/health")).status, 200);
  assert.equal((await send(origin(fromFiles), "POST", "/sponsor/v1/leases")).status, 201);
  // `.env.development` overrides `.env` in development mode.
  assert.deepEqual(upstream.requests.map(({ url, headers }) => [url, headers.authorization]), [
    ["/health", "Bearer development-key"],
    ["/v1/leases", "Bearer development-key"],
  ]);

  // The process environment overrides every env file.
  process.env.SPONSOR_API_KEY = "process-key";
  const fromProcess = await createServer({ ...appConfig(), server: { host: "127.0.0.1", port: 0, watch: null } });
  await fromProcess.listen();
  servers.push(fromProcess);
  upstream.requests.length = 0;
  await send(origin(fromProcess), "GET", "/sponsor/health");
  assert.equal(upstream.requests[0].headers.authorization, "Bearer process-key");
});

test("the app's config relays /sponsor on the preview server", async () => {
  const server = await preview({ ...appConfig(), build: { outDir: join(envDir, "dist") }, preview: { host: "127.0.0.1", port: 0 } });
  servers.push(server);
  upstream.requests.length = 0;
  assert.equal((await send(origin(server), "POST", "/sponsor/v1/leases")).status, 201);
  // Production mode reads `.env`, not `.env.development`.
  assert.equal(upstream.requests[0].headers.authorization, "Bearer file-key");
});

test("the dev server refuses to serve an env file, with or without a query", async () => {
  writeFileSync(join(root, ".env"), "SPONSOR_API_KEY=fs-probe-marker\n");
  writeFileSync(join(root, ".env.local"), "SPONSOR_API_KEY=fs-probe-marker\n");
  const relay = await relayServer({ SPONSOR_API_KEY: KEY });
  const paths = ["/.env", "/.env?raw", "/.env?import&raw", "/.env?raw&import", "/.env?inline", "/.env.local?raw", `/@fs${root}/.env?raw??`, `/@fs${root}/.env?import&raw??`];
  for (const path of paths) {
    const response = await send(relay, "GET", path);
    assert.equal(response.status, 403, path);
    assert.ok(!response.text.includes("fs-probe-marker"), path);
  }
});

test("reads only its own and VITE_ variables, from the env files of the mode and the environment, in Vite's order", () => {
  process.env.SPONSOR_URL = "https://from-process.example";
  const development = readSponsorRelayEnvironment("development", envDir);
  assert.equal(development.SPONSOR_URL, "https://from-process.example");
  assert.equal(development.SPONSOR_API_KEY, "development-key");
  assert.equal(development.PATH, undefined);
  assert.equal(readSponsorRelayEnvironment("production", envDir).SPONSOR_API_KEY, "file-key");
  assert.equal(readSponsorRelayEnvironment("production", false).SPONSOR_API_KEY, undefined);
});

test("accepts only an https sponsor URL, or http to a loopback host", () => {
  assert.equal(sponsorTarget(undefined), DEFAULT_SPONSOR_URL);
  assert.equal(sponsorTarget("https://sponsor.example/base/"), "https://sponsor.example/base");
  assert.equal(sponsorTarget("http://localhost:3000"), "http://localhost:3000");
  for (const url of ["http://sponsor.example", "https://user:pass@sponsor.example", "https://sponsor.example?x=1", "not a url"]) {
    assert.throws(() => sponsorTarget(url), /SPONSOR_URL/);
  }
});

test("refuses a sponsor key the browser bundle would carry", () => {
  assert.throws(() => assertNoClientSponsorKey({ VITE_SPONSOR_API_KEY: "x" }), /VITE_SPONSOR_API_KEY would be inlined/);
  assert.throws(() => sponsorRelay({ VITE_SPONSOR_KEY: "x" }), /VITE_SPONSOR_KEY/);
  assert.doesNotThrow(() => assertNoClientSponsorKey({ SPONSOR_API_KEY: "x", VITE_PASSKEY_SIGNER_URL: "https://passkey-preview.lace.io" }));
});

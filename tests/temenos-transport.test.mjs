import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createTemenosRelay, temenosRelayPlugin } from '../temenos-relay.ts';
import { readTemenosTokenFile, TemenosCredentialError } from '../temenos-relay-credential.ts';
import { createTemenosFetch } from '../src/midnight/temenos-fetch.ts';
import { TEMENOS_LEDGER_QUERY, TEMENOS_ROUTES, TEMENOS_UPSTREAM, TEMENOS_RELAY_PATH, TEMENOS_RELAY_HEADER, TEMENOS_TIMEOUT_MS, TEMENOS_MAX_IN_FLIGHT } from '../src/midnight/temenos-transport.ts';
import { AkxChannelBinder } from '../node_modules/@input-output-hk/temenos-attestation-verifier/dist/phases/channel/akxChannelBinder.js';
import { AkxEvidenceProvider } from '../node_modules/@input-output-hk/temenos-attestation-verifier/dist/phases/evidence/akxEvidenceProvider.js';
import { RealWardenClient } from '../node_modules/@input-output-hk/temenos-attestation-verifier/dist/phases/warden/realWardenClient.js';
import { transcriptHash } from '../node_modules/@input-output-hk/temenos-attestation-verifier/dist/akx/transcript.js';
import { TEMENOS_URL } from '../src/midnight/config.ts';

const b64 = n => Buffer.alloc(n, 7).toString('base64');
const envelope = path => JSON.stringify(path.endsWith('/session') ? { sid: b64(16), nonceC: b64(32) }
  : path.endsWith('/complete') ? { sid: b64(16), enc: b64(32) } : { sid: b64(16), ciphertext: b64(32) });
const response = (body = '{}', status = 200) => new Response(body, { status, headers: { [TEMENOS_RELAY_HEADER]: '1' } });

// Streams only: no listening socket, browser, environment files or live traffic.
function fakeUpstream({ status = 200, headers = {}, body = '{"public":true}', chunks, error, hang = false } = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    const call = { url, options, body: '' };
    calls.push(call);
    const outgoing = new Writable({ autoDestroy: false, write(chunk, encoding, done) { call.body += chunk.toString(); done(); } });
    call.outgoing = outgoing;
    options.signal.addEventListener('abort', () => outgoing.destroy(new Error('aborted')), { once: true });
    outgoing.on('finish', () => queueMicrotask(() => {
      if (error) { outgoing.destroy(new Error(error)); return; }
      if (hang) return;
      const incoming = new PassThrough();
      incoming.statusCode = status;
      incoming.headers = headers;
      call.incoming = incoming;
      callback(incoming);
      queueMicrotask(() => {
        for (const chunk of chunks ?? [body]) incoming.write(chunk);
        incoming.end();
      });
    }));
    return outgoing;
  };
  return { calls, request };
}

function invoke(handler, path = '/attestation.json', { method = 'GET', headers = {}, body = '', raw, delayed = false, encrypted = false } = {}) {
  const req = new PassThrough();
  Object.assign(req, { url: raw ?? `${TEMENOS_RELAY_PATH}${path}`, method, headers: { host: 'localhost:5198', ...headers }, socket: { encrypted } });
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, writableEnded: false, writeHead(status, values) { this.status = status; this.headers = values; },
    end(bytes) { this.body = String(bytes); this.writableEnded = true; this.emit('finish'); } });
  let next = false;
  const done = handler(req, res, () => { next = true; });
  if (!delayed) req.end(body);
  return { req, res, done, get next() { return next; } };
}

test('exact pinned routes, HTTPS validation, raw body/status fidelity and header isolation', async () => {
  for (const route of TEMENOS_ROUTES.filter(route => route.kind === 'akx')) {
    const fake = fakeUpstream({ status: 409, body: '{"error":"session state"}', headers: { 'set-cookie': 'upstream-cookie', location: 'https://elsewhere.invalid' } });
    const body = route.method === 'POST' ? envelope(route.path) : '';
    const run = invoke(createTemenosRelay(fake.request), route.path, { method: route.method, body,
      headers: { origin: 'http://localhost:5198', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-untrusted': 'drop' } });
    await run.done;
    assert.equal(run.res.status, 409);
    assert.equal(run.res.body, '{"error":"session state"}');
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.url, `${TEMENOS_UPSTREAM}${route.path}`);
    assert.equal(call.options.rejectUnauthorized, true);
    assert.equal(call.options.method, route.method);
    assert.equal(call.body, body);
    assert.equal(call.options.headers['x-untrusted'], undefined);
    assert.equal(call.options.headers.origin, undefined);
    assert.equal(call.options.headers.cookie, undefined);
    assert.equal(run.res.headers['set-cookie'], undefined);
    assert.equal(run.res.headers.location, undefined);
    assert.equal(run.res.headers['access-control-allow-origin'], undefined);
    assert.equal(run.res.headers['cache-control'], 'no-store');
    assert.equal(run.res.headers['x-lace-temenos-error-origin'], 'upstream');
  }
});

test('reject path tricks, unlisted hosts/methods/query and preserve unrelated relay boundaries', async () => {
  const fake = fakeUpstream();
  const handler = createTemenosRelay(fake.request);
  for (const suffix of ['/attestation.json?url=https://evil.invalid', '//evil.invalid/attestation.json', '/%2e%2e/attestation.json', '/tee_attestation/../attestation.json', '/attestation.json#fragment', '/attestation.json/', '/https://evil.invalid', '/tee_attestation/session%2fcomplete', '/\\evil.invalid']) {
    const run = invoke(handler, suffix); await run.done; assert.equal(run.res.status, 404, suffix);
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS', 'DELETE']) {
    const run = invoke(handler, '/attestation.json', { method }); await run.done; assert.equal(run.res.status, 404);
  }
  for (const raw of ['/sponsor/health', '/temenos-relay-other', '/']) {
    const run = invoke(handler, '', { raw }); await run.done; assert.equal(run.next, true);
  }
  assert.equal(fake.calls.length, 0);
});

test('reject browser cross-origin requests and credentials without forwarding', async () => {
  const fake = fakeUpstream();
  for (const headers of [{ origin: 'https://localhost:5198' }, { origin: 'null' }, { origin: 'http://evil.invalid' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { cookie: 'secret' }, { authorization: 'secret' }, { 'proxy-authorization': 'secret' }]) {
    const run = invoke(createTemenosRelay(fake.request), undefined, { headers }); await run.done; assert.equal(run.res.status, 403);
  }
  assert.equal(fake.calls.length, 0);
});

test('request size, encoding, media type and public/ciphertext envelope limits fail closed', async () => {
  const fake = fakeUpstream();
  for (const [body, headers, status] of [
    ['{}', {}, 415], ['{}', { 'content-type': 'application/json' }, 400],
    ['plaintext-proof', { 'content-type': 'application/json' }, 400],
    [JSON.stringify({ sid: b64(16), ciphertext: b64(32), plaintext: 'proof' }), { 'content-type': 'application/json' }, 400],
    [JSON.stringify({ sid: b64(15), ciphertext: b64(32) }), { 'content-type': 'application/json' }, 400],
    ['', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 415],
    ['', { 'content-type': 'application/json', 'content-length': 17 * 1024 * 1024 }, 413],
  ]) {
    const run = invoke(createTemenosRelay(fake.request), '/tee_attestation/proxy', { method: 'POST', body, headers });
    await run.done; assert.equal(run.res.status, status);
  }
  const run = invoke(createTemenosRelay(fake.request), '/tee_attestation/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(4097),
  });
  await run.done; assert.equal(run.res.status, 413);
  const get = invoke(createTemenosRelay(fake.request), undefined, { headers: { 'transfer-encoding': 'chunked' }, body: '{}' });
  await get.done; assert.equal(get.res.status, 400);
  assert.equal(fake.calls.length, 0);
});

test('proxy HTTP 400 identifies relay validation versus upstream response without exposing content', async () => {
  const localUpstream = fakeUpstream();
  const local = invoke(createTemenosRelay(localUpstream.request), '/tee_attestation/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await local.done;
  assert.equal(local.res.status, 400);
  assert.equal(local.res.headers['x-lace-temenos-400-origin'], 'relay');
  assert.equal(local.res.headers['x-lace-temenos-error-origin'], 'relay');
  assert.equal(localUpstream.calls.length, 0);

  const remoteUpstream = fakeUpstream({ status: 400, body: '{"error":"synthetic upstream failure"}',
    headers: { 'x-lace-temenos-400-origin': 'relay' } });
  const remote = invoke(createTemenosRelay(remoteUpstream.request), '/tee_attestation/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: envelope('/tee_attestation/proxy'),
  });
  await remote.done;
  assert.equal(remote.res.status, 400);
  assert.equal(remote.res.headers['x-lace-temenos-400-origin'], 'upstream');
  assert.equal(remoteUpstream.calls.length, 1);
  assert.equal(remote.res.body, '{"error":"synthetic upstream failure"}');

  const otherUpstream = fakeUpstream({ status: 409, body: '{}' });
  const other = invoke(createTemenosRelay(otherUpstream.request), '/tee_attestation/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: envelope('/tee_attestation/proxy'),
  });
  await other.done;
  assert.equal(other.res.headers['x-lace-temenos-400-origin'], undefined);
  assert.equal(other.res.headers['x-lace-temenos-error-origin'], 'upstream');
});

test('session completion forwards a bodyless upstream 204 cleanly', async () => {
  const fake = fakeUpstream({ status: 204, body: '' });
  const run = invoke(createTemenosRelay(fake.request), '/tee_attestation/session/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: envelope('/tee_attestation/session/complete'),
  });
  await run.done;
  assert.equal(run.res.status, 204);
  assert.equal(run.res.body, '');
  assert.equal(fake.calls.length, 1);
});

test('redirects, TLS failures, oversized and compressed responses do not escape the relay', async () => {
  for (const options of [{ status: 302, headers: { location: 'http://evil.invalid' } }, { error: 'certificate rejected' },
    { headers: { 'content-length': 2 * 1024 * 1024 } }, { headers: { 'content-encoding': 'gzip' } },
    { chunks: [Buffer.alloc(600_000), Buffer.alloc(600_000)] }]) {
    const fake = fakeUpstream(options);
    const run = invoke(createTemenosRelay(fake.request)); await run.done;
    assert.ok([502, 413].includes(run.res.status));
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].outgoing.destroyed, true);
    assert.doesNotMatch(run.res.body, /certificate|evil/);
  }
});

test('deadline and disconnect abort upstream; concurrency slots are released', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeUpstream({ hang: true });
  const handler = createTemenosRelay(fake.request);
  const running = Array.from({ length: TEMENOS_MAX_IN_FLIGHT }, () => invoke(handler));
  await new Promise(resolve => setImmediate(resolve));
  const full = invoke(handler); await full.done; assert.equal(full.res.status, 503);
  running[0].res.emit('close'); await running[0].done;
  assert.equal(fake.calls[0].options.signal.aborted, true);
  const replacement = invoke(handler);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(TEMENOS_TIMEOUT_MS);
  await Promise.all([...running.map(run => run.done), replacement.done]);
  assert.equal(replacement.res.status, 504);
  for (const call of fake.calls) assert.equal(call.outgoing.destroyed, true);
  const slow = invoke(handler, undefined, { delayed: true });
  t.mock.timers.tick(TEMENOS_TIMEOUT_MS); await slow.done;
  assert.equal(slow.res.status, 504);
});

test('Vite installs identical bounded middleware for dev and preview', () => {
  const plugin = temenosRelayPlugin();
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let installed;
    plugin[hook]({ middlewares: { use(handler) { installed = handler; } } });
    assert.equal(typeof installed, 'function');
  }
});

test('scoped fetch preserves body/status/signal, omits credentials, and never replaces global fetch', async () => {
  const original = globalThis.fetch;
  for (const route of TEMENOS_ROUTES) {
    const abort = new AbortController();
    let call;
    const transport = createTemenosFetch(async (url, init) => { call = { url, init }; return response('{"error":"upstream"}', 503); });
    const body = route.method === 'POST' ? envelope(route.path) : undefined;
    const result = await transport(route.source, { method: route.method, body,
      headers: body ? { 'content-type': 'application/json' } : {}, signal: abort.signal });
    assert.equal(result.status, 503);
    assert.equal(call.url, `${TEMENOS_RELAY_PATH}${route.path}`);
    assert.equal(call.init.body, body);
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.mode, 'same-origin');
    abort.abort(); assert.equal(call.init.signal.aborted, true);
  }
  assert.equal(globalThis.fetch, original);
});

test('scoped fetch rejects alternate destinations/credentials and missing static backend', async () => {
  let calls = 0;
  const transport = createTemenosFetch(async () => { calls++; return response(); });
  for (const url of ['http://attestation.proofserver.preview.wastedp.io/attestation.json', `${TEMENOS_UPSTREAM}.evil/attestation.json`,
    'https://attestation.proofserver.wastedp.io/attestation.json', 'https://indexer.preprod.midnight.network/api/v3/graphql',
    'https://user:pass@attestation.proofserver.preview.wastedp.io/attestation.json', `${TEMENOS_UPSTREAM}/x/../attestation.json`,
    `${TEMENOS_UPSTREAM}/attestation.json?x=1`, `${TEMENOS_UPSTREAM}/attestation.json#x`, 'https://warden.wastedp.io/admin']) {
    await assert.rejects(transport(url), /not allowed/);
  }
  for (const init of [{ credentials: 'include' }, { headers: { authorization: 'secret' } }, { headers: { cookie: 'secret' } }]) {
    await assert.rejects(transport(`${TEMENOS_UPSTREAM}/attestation.json`, init), /not allowed/);
  }
  assert.equal(calls, 0);
  await assert.rejects(createTemenosFetch(async () => new Response('<html>SPA fallback</html>'))(`${TEMENOS_UPSTREAM}/attestation.json`), /relay unavailable/);
});

test('actual pinned provider uses only the two evidence routes and rejects malformed evidence', async () => {
  const paths = [];
  const fetchImpl = createTemenosFetch(async path => { paths.push(path); return response('{}'); });
  const provider = AkxEvidenceProvider.fromConfig({ attestationHost: new URL(TEMENOS_UPSTREAM).host,
    akxServerUrl: `${TEMENOS_UPSTREAM}/tee_attestation` }, { fetchImpl });
  await assert.rejects(provider.obtainEvidence('test-nonce'), /epoch|webserver_tls/);
  assert.deepEqual(paths.sort(), [`${TEMENOS_RELAY_PATH}/attestation.json`, `${TEMENOS_RELAY_PATH}/tee_attestation/enclave-key`].sort());
});

test('actual pinned binder authenticates handshake, sends only ciphertext, and invalidates on forgery', async () => {
  const epoch = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const epochPublic = new Uint8Array(await crypto.subtle.exportKey('raw', epoch.publicKey));
  const session = await crypto.subtle.generateKey('X25519', true, ['deriveBits']);
  const sessionPublic = new Uint8Array(await crypto.subtle.exportKey('raw', session.publicKey));
  const calls = [];
  let tamper = false;
  const fetchImpl = createTemenosFetch(async (path, init) => {
    const body = JSON.parse(init.body); calls.push({ path, body });
    // The real verifier's outer envelope must pass the actual relay unchanged.
    const fake = fakeUpstream();
    const run = invoke(createTemenosRelay(fake.request), undefined, { raw: path, method: init.method,
      headers: Object.fromEntries(new Headers(init.headers)), body: init.body });
    await run.done;
    assert.equal(run.res.status, 200);
    assert.equal(fake.calls[0].body, init.body);
    if (path.endsWith('/session')) {
      const transcript = await transcriptHash(Buffer.from(body.sid, 'base64'), Buffer.from(body.nonceC, 'base64'), sessionPublic);
      const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', epoch.privateKey, transcript));
      if (tamper) signature[0] ^= 1;
      return response(JSON.stringify({ enclaveSessionPub: Buffer.from(sessionPublic).toString('base64'), signature: Buffer.from(signature).toString('base64') }));
    }
    if (path.endsWith('/complete')) return response();
    return response(JSON.stringify({ ciphertext: b64(32) })); // Deliberate unauthenticated response.
  });
  const binder = AkxChannelBinder.fromConfig({ akxServerUrl: `${TEMENOS_UPSTREAM}/tee_attestation` }, { fetchImpl });
  const material = { kind: 'akx-epoch-key', epochPublic, epoch: 1 };
  const channel = await binder.bind(TEMENOS_URL, material);
  const secret = new TextEncoder().encode('synthetic private proof material');
  await assert.rejects(channel.prove({ body: secret }), /authentication/);
  const sent = calls.at(-1);
  assert.equal(sent.path, `${TEMENOS_RELAY_PATH}/tee_attestation/proxy`);
  assert.deepEqual(Object.keys(sent.body).sort(), ['ciphertext', 'sid']);
  // 0.3 encrypts the versioned HTTP envelope, not just the raw proof bytes.
  const inner = JSON.stringify({ version: 1, request: { method: 'POST', path: '/prove', query: [],
    headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(secret).toString('base64') } });
  assert.equal(Buffer.from(sent.body.ciphertext, 'base64').length, Buffer.byteLength(inner) + 16);
  assert.equal(Buffer.from(sent.body.ciphertext, 'base64').includes(Buffer.from(secret)), false);
  assert.equal(await channel.isUsable(), false);
  const count = calls.length;
  await assert.rejects(channel.prove({ body: secret }), /no longer usable/);
  assert.equal(calls.length, count);
  tamper = true;
  await assert.rejects(binder.bind(TEMENOS_URL, material), /signature/);
  assert.equal(calls.length, count + 1); // No complete or proof after a forged handshake.
});

test('transport pins match installed SDK config and shared production factory retains roots/config', async () => {
  globalThis.self ??= globalThis;
  const sdk = await import('@laceio/sdk/midnight');
  let captured;
  const props = { networkId: 'preview', proofServerApiUrl: TEMENOS_URL,
    getLedgerIndexerUrl: async () => sdk.MIDNIGHT_PUBLIC_ENDPOINTS.preprod.indexerAddress,
    trustRoots: { amdRootCertificates: ['synthetic root; stub verifier only'] },
    verifier: { createVerifier: config => { captured = config; return { establishVerifiedSession: async () => ({ close: async () => {} }) }; } } };
  await (await sdk.createVeriteeAttestedProver(props).establishAttestedSession(() => {})).close();
  assert.equal(captured.attestationHost, new URL(TEMENOS_UPSTREAM).host);
  assert.equal(captured.akxServerUrl, `${TEMENOS_UPSTREAM}/tee_attestation`);
  assert.equal(captured.indexerUrl, TEMENOS_ROUTES.find(route => route.kind === 'ledger').source);
  assert.equal(`${captured.wardenUrl}/dapps/verify_attestation`, TEMENOS_ROUTES.find(route => route.kind === 'warden').source);
  assert.throws(() => sdk.createVeriteeAttestedProver({ ...props, proofServerApiUrl: 'https://api.proofserver.wastedp.io' }), /No baked (?:Temenos|Veritee) attestation config/);
  const manifest = JSON.parse(await readFile(new URL('../node_modules/@input-output-hk/temenos-attestation-verifier/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  const runtime = await readFile(new URL('../src/midnight/runtime.ts', import.meta.url), 'utf8');
  const factory = await readFile(new URL('../src/midnight/temenos-provider.ts', import.meta.url), 'utf8');
  assert.match(runtime, /createAttestedProver: \(await import\('\.\/temenos-provider'\)\)\.createConsumerTemenosProver/);
  for (const name of ['AkxEvidenceProvider', 'AkxChannelBinder', 'RealLedgerClient', 'RealWardenClient']) assert.ok(factory.includes(`${name}.fromConfig(config, { fetchImpl })`));
  assert.ok(factory.includes('amdRootCertificates: [...AMD_ROOT_CERTIFICATES]'));
  const ledger = await readFile(new URL('../node_modules/@input-output-hk/temenos-attestation-verifier/dist/phases/ledger/contractState.js', import.meta.url), 'utf8');
  assert.ok(ledger.includes(`const STATE_QUERY = '${TEMENOS_LEDGER_QUERY}'`));
});

const ledgerBody = JSON.stringify({ query: TEMENOS_LEDGER_QUERY, variables: { address: 'a'.repeat(64) } });
const syntheticToken = 'synthetic-preprod-project-token';
const wardenBody = JSON.stringify({ dapp_id: 'b'.repeat(64), payload: {}, tee_attestation: {
  version: '1', attestation: { mode: 'raw_sev_snp', evidence: { report: b64(1184), runtime_data: b64(32),
    vcek: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n' } }, msg: b64(32), sig: b64(32), pcr: b64(32),
} });
const jsonHeaders = { 'content-type': 'application/json' };

// Synthetic self-signed certificate, used only for PEM transport syntax. Neither
// its trust nor its validity period is consulted; no real attestation is stored.
const syntheticPem = `-----BEGIN CERTIFICATE-----
MIIBjjCCATSgAwIBAgIBATAKBggqhkjOPQQDAjAmMSQwIgYDVQQDDBtzeW50aGV0
aWMtdHJhbnNwb3J0LmludmFsaWQwHhcNMjYxMDE0MTAzNDA1WhcNMjYxMDE1MTAz
NDA1WjAmMSQwIgYDVQQDDBtzeW50aGV0aWMtdHJhbnNwb3J0LmludmFsaWQwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAASj6jYASMrqadwPnuFvTbAR+3FsU1nqF328
/XgsoS6Qzm4NNwQjmaq1RFe7P3wYwAjYcBL/SgZhBoP8u3wuQPuEo1MwUTAdBgNV
HQ4EFgQUWa8ed4nizBaatCHWcwPXqB8o1H0wHwYDVR0jBBgwFoAUWa8ed4nizBaa
tCHWcwPXqB8o1H0wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAT
Ikuscd1wASnWeNr3hhnkdpJ9oyeGXII3JHQKjO82nwIhAJYI0uJEcB4Rg7hoVSut
XwKoURme8x3z9kMc/obzUos5
-----END CERTIFICATE-----
`;

test('installed Warden client carries three PEM blocks verbatim through scoped fetch and relay', async () => {
  assert.equal(new X509Certificate(syntheticPem).verify(new X509Certificate(syntheticPem).publicKey), true);
  for (const pem of [syntheticPem, syntheticPem.repeat(3),
    ` \t\r\n${syntheticPem.replaceAll('\n', '\r\n')}\t\r\n${syntheticPem}\n${syntheticPem}\t `,
    syntheticPem.trim().repeat(3)]) {
    for (const [status, verified] of [[202, true], [200, false], [400, true]]) {
      const upstreamBody = JSON.stringify({ verified, call_id: 'synthetic-call', verification_recording: { job_id: 'synthetic-job' } });
      const fake = fakeUpstream({ status, body: upstreamBody });
      const handler = createTemenosRelay(fake.request, () => { throw new Error('must not read token'); });
      let originalBody;
      const fetchImpl = createTemenosFetch(async (path, init) => {
        originalBody = init.body;
        const run = invoke(handler, undefined, { raw: path, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body });
        await run.done;
        assert.equal(run.res.status, status);
        assert.equal(run.res.body, upstreamBody);
        return new Response(run.res.body, { status: run.res.status, headers: run.res.headers });
      });
      const raw = JSON.parse(wardenBody).tee_attestation;
      raw.attestation.evidence.vcek = pem;
      const client = RealWardenClient.fromConfig({ wardenUrl: 'https://warden.wastedp.io' }, { fetchImpl });
      const verdict = await client.verifyAttestation('b'.repeat(64), { enclaveKey: { rawAttestation: raw } });
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].body, originalBody);
      assert.equal(fake.calls[0].body, JSON.stringify({ dapp_id: 'b'.repeat(64), tee_attestation: raw, payload: {} }));
      assert.equal(fake.calls[0].options.headers.project_id, undefined);
      assert.equal(verdict.verified, status === 202);
      if (verdict.verified) {
        assert.equal(verdict.callId, 'synthetic-call');
        assert.equal(verdict.recordingJobId, 'synthetic-job');
      }
    }
  }
});

test('Warden rejects malformed PEM chains and oversized chains before any upstream call', async () => {
  const fake = fakeUpstream();
  const handler = createTemenosRelay(fake.request, () => { throw new Error('must not read token'); });
  const end = '-----END CERTIFICATE-----';
  const damaged = [
    ['', 'empty'], [' \r\n\t', 'whitespace only'],
    [`garbage${syntheticPem}`, 'leading garbage'],
    [`${syntheticPem}garbage\n${syntheticPem}`, 'inter-block garbage'],
    [`${syntheticPem}garbage`, 'trailing garbage'],
    ['-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----', 'empty block'],
    [syntheticPem.replace('BEGIN CERTIFICATE', 'BEGIN PRIVATE KEY'), 'wrong marker'],
    [syntheticPem.replace(end, end.slice(0, -1)), 'truncated marker'],
    [syntheticPem.replace(end, ''), 'missing end'],
    [syntheticPem.replace('MIIB', '!IIB'), 'invalid base64'],
    [syntheticPem.replace('MIIB', 'IIB'), 'truncated base64'],
    [syntheticPem.replace('MIIB', 'M=IB'), 'interior padding'],
    ['-----BEGIN CERTIFICATE-----\nZh==\n-----END CERTIFICATE-----', 'noncanonical padding bits'],
    [syntheticPem.replace('MIIB', 'MI\rIB'), 'bare CR inside base64'],
    [syntheticPem.replace('MIIB', 'MI IB'), 'space inside base64'],
  ];
  for (const [invalid, name] of damaged) {
    const variants = invalid.trim() ? [invalid, syntheticPem + invalid + syntheticPem] : [invalid];
    for (const pem of variants) {
      const body = JSON.parse(wardenBody);
      body.tee_attestation.attestation.evidence.vcek = pem;
      const run = invoke(handler, '/warden/verify-attestation', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
      await run.done;
      assert.equal(run.res.status, 400, name);
    }
  }
  const limit = TEMENOS_ROUTES.find(route => route.kind === 'warden').limit;
  for (const pem of [syntheticPem.repeat(Math.ceil(limit / syntheticPem.length)),
    `-----BEGIN CERTIFICATE-----\n${'A'.repeat(limit)}\n${end}`]) {
    const body = JSON.parse(wardenBody);
    body.tee_attestation.attestation.evidence.vcek = pem;
    const run = invoke(handler, '/warden/verify-attestation', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
    await run.done;
    assert.equal(run.res.status, 413);
  }
  assert.equal(fake.calls.length, 0);
});

test('ledger query is a fixed public read; token goes only to official Preprod, never back to browser', async () => {
  const fake = fakeUpstream({ body: JSON.stringify({ data: { contractAction: { state: '00aabb' } }, extension: syntheticToken }) });
  const handler = createTemenosRelay(fake.request, () => syntheticToken);
  const run = invoke(handler, '/ledger/contract-state', { method: 'POST', headers: jsonHeaders, body: ledgerBody });
  await run.done;
  assert.equal(run.res.status, 200);
  assert.deepEqual(JSON.parse(run.res.body), { data: { contractAction: { state: '00aabb' } } });
  assert.equal(fake.calls[0].url, 'https://midnight-preprod.blockfrost.io/api/v0');
  assert.equal(fake.calls[0].options.headers.project_id, syntheticToken);
  assert.equal(fake.calls[0].body, ledgerBody);
  assert.equal(JSON.stringify(run.res.headers).includes(syntheticToken), false);
  for (const options of [
    { status: 401, body: syntheticToken },
    { status: 200, body: JSON.stringify({ errors: [{ message: syntheticToken }] }) },
    { status: 200, body: JSON.stringify({ data: { contractAction: { state: syntheticToken } } }) },
  ]) {
    const upstream = fakeUpstream(options);
    const failure = invoke(createTemenosRelay(upstream.request, () => syntheticToken), '/ledger/contract-state', { method: 'POST', headers: jsonHeaders, body: ledgerBody });
    await failure.done;
    assert.equal(failure.res.body.includes(syntheticToken), false);
    assert.equal(failure.res.status, options.status === 401 ? 401 : options.body.includes('errors') ? 200 : 502);
  }
});

test('ledger refuses mutations, alternate queries/addresses, caller credentials and missing token', async () => {
  const fake = fakeUpstream();
  let reads = 0;
  const handler = createTemenosRelay(fake.request, () => { reads++; throw new TemenosCredentialError(); });
  for (const body of [
    { query: 'mutation { anything }', variables: { address: 'a'.repeat(64) } },
    { query: TEMENOS_LEDGER_QUERY + ' query Other { state }', variables: { address: 'a'.repeat(64) } },
    { query: TEMENOS_LEDGER_QUERY, variables: { address: 'a'.repeat(63) } },
    { query: TEMENOS_LEDGER_QUERY, variables: { address: 'x'.repeat(64) } },
    { query: TEMENOS_LEDGER_QUERY, variables: { address: 'a'.repeat(64), url: 'https://evil.invalid' } },
    { ...JSON.parse(ledgerBody), operationName: 'extra' },
  ]) {
    const run = invoke(handler, '/ledger/contract-state', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
    await run.done; assert.equal(run.res.status, 400);
  }
  for (const path of ['/ledger/contract-state?url=https://evil.invalid', '/ledger/contract-state/']) {
    const run = invoke(handler, path, { method: 'POST', headers: jsonHeaders, body: ledgerBody });
    await run.done; assert.equal(run.res.status, 404);
  }
  const credential = invoke(handler, '/ledger/contract-state', { method: 'POST', headers: { ...jsonHeaders, project_id: 'caller-token' }, body: ledgerBody });
  await credential.done; assert.equal(credential.res.status, 403);
  assert.equal(reads, 0);
  const missing = invoke(handler, '/ledger/contract-state', { method: 'POST', headers: jsonHeaders, body: ledgerBody });
  await missing.done; assert.equal(missing.res.status, 503);
  assert.match(missing.res.body, /TEMENOS_BLOCKFROST_PREPROD_TOKEN_FILE/);
  assert.equal(fake.calls.length, 0);
});

test('token file must be private, owned, regular, bounded and header-safe; errors reveal no path/content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'temenos-synthetic-'));
  const file = join(dir, 'token');
  try {
    writeFileSync(file, syntheticToken + '\n', { mode: 0o600 });
    assert.equal(readTemenosTokenFile(file), syntheticToken);
    const moduleUrl = new URL('../temenos-relay-credential.ts', import.meta.url).href;
    for (const debug of ['http', 'https', 'http*']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { readTemenosTokenFile, TemenosCredentialError } from ${JSON.stringify(moduleUrl)}; try { readTemenosTokenFile(${JSON.stringify(file)}); process.exit(1); } catch (error) { if (!(error instanceof TemenosCredentialError)) process.exit(2); }`],
      { env: { NODE_DEBUG: debug }, encoding: 'utf8' });
      assert.equal(result.status, 0);
      assert.equal((result.stdout + result.stderr).includes(syntheticToken), false);
    }
    const refused = path => assert.throws(() => readTemenosTokenFile(path), error => error instanceof TemenosCredentialError && !error.message.includes(dir) && !error.message.includes(syntheticToken));
    refused(undefined); refused('relative-token'); refused(join(dir, 'absent')); refused(dir);
    chmodSync(file, 0o644); refused(file); chmodSync(file, 0o600);
    const link = join(dir, 'link'); symlinkSync(file, link); refused(link);
    for (const body of ['', 'short', 'bad\r\nAuthorization: injected', 'x'.repeat(513), 'é'.repeat(32)]) { writeFileSync(file, body); refused(file); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Warden carries only public evidence and preserves acceptance/rejection without a token', async () => {
  for (const status of [202, 400]) {
    const body = JSON.stringify({ verified: status === 202, detail: 'synthetic verdict' });
    const fake = fakeUpstream({ status, body });
    const handler = createTemenosRelay(fake.request, () => { throw new Error('must not read token'); });
    const run = invoke(handler, '/warden/verify-attestation', { method: 'POST', headers: jsonHeaders, body: wardenBody });
    await run.done;
    assert.equal(run.res.status, status); assert.equal(run.res.body, body);
    assert.equal(fake.calls[0].url, 'https://warden.wastedp.io/dapps/verify_attestation');
    assert.equal(fake.calls[0].body, wardenBody);
    assert.equal(fake.calls[0].options.headers.project_id, undefined);
  }
  const fake = fakeUpstream();
  for (const mutate of [body => { body.payload = { proof: 'plaintext' }; }, body => { body.tee_attestation.private = 'secret'; },
    body => { body.tee_attestation.attestation.evidence.secret = 'secret'; }, body => { body.dapp_id = 'not-public-address'; },
    body => { body.tee_attestation.attestation.mode = 'other'; }, body => { body.tee_attestation.msg = 'not-base64'; }]) {
    const body = JSON.parse(wardenBody); mutate(body);
    const run = invoke(createTemenosRelay(fake.request), '/warden/verify-attestation', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
    await run.done; assert.equal(run.res.status, 400);
  }
  assert.equal(fake.calls.length, 0);
});

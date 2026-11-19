import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractRequestLoopbackUrl,
  extractWebServerUrl,
  normalizeLoopbackHubUrl,
  readHubDiscovery,
  removeHubDiscoveryIfOwned,
  writeHubDiscovery,
} from '../src/hub-discovery.mjs';
import { createHubClient, redactHubUrl, resolveHubCandidates } from '../src/hub-client.mjs';

test('normalizeLoopbackHubUrl accepts loopback variants and rejects non-loopback or missing-port URLs', () => {
  assert.equal(normalizeLoopbackHubUrl('http://127.0.0.1:3080/'), 'http://127.0.0.1:3080');
  assert.equal(normalizeLoopbackHubUrl('http://localhost:63720/some/path?x=1'), 'http://localhost:63720');
  assert.equal(normalizeLoopbackHubUrl('http://localhost.:63720'), 'http://localhost:63720');
  assert.equal(normalizeLoopbackHubUrl('http://[::1]:3080'), 'http://[::1]:3080');
  assert.equal(normalizeLoopbackHubUrl('http://0.0.0.0:4123'), 'http://127.0.0.1:4123');
  assert.equal(normalizeLoopbackHubUrl('http://[::]:4123'), 'http://127.0.0.1:4123');
  assert.equal(normalizeLoopbackHubUrl('http://[::ffff:127.0.0.1]:4123'), 'http://127.0.0.1:4123');
  assert.equal(normalizeLoopbackHubUrl('http://127.0.0.1:80'), 'http://127.0.0.1:80');
  assert.equal(normalizeLoopbackHubUrl(normalizeLoopbackHubUrl('http://127.0.0.1:80')), 'http://127.0.0.1:80');
  assert.equal(normalizeLoopbackHubUrl('https://127.0.0.1:443'), 'https://127.0.0.1:443');
  assert.equal(normalizeLoopbackHubUrl('https://127.0.0.1:8443'), 'https://127.0.0.1:8443');

  assert.equal(normalizeLoopbackHubUrl('http://10.0.0.1:3080'), null);
  assert.equal(normalizeLoopbackHubUrl('https://evil.example:3080'), null);
  assert.equal(normalizeLoopbackHubUrl('ftp://127.0.0.1:3080'), null);
  assert.equal(normalizeLoopbackHubUrl('http://user:pass@127.0.0.1:3080'), null);
  assert.equal(normalizeLoopbackHubUrl('http://127.0.0.1'), null);
  assert.equal(normalizeLoopbackHubUrl('http://127.0.0.1\\path:9999'), null);
  assert.equal(normalizeLoopbackHubUrl('http://127.0.0.1:3\t080'), null);
  assert.equal(normalizeLoopbackHubUrl('http://127.0.0.1:0'), null);
  assert.equal(normalizeLoopbackHubUrl('http://127.0.0.1:65536'), null);
  assert.equal(normalizeLoopbackHubUrl('not-a-url'), null);
});

test('writeHubDiscovery / readHubDiscovery / removeHubDiscoveryIfOwned enforce ownership and validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-disc-'));
  const file = join(dir, 'hub.json');
  try {
    assert.equal(readHubDiscovery({ file: join(dir, 'missing.json') }), null);

    assert.throws(() => writeHubDiscovery({ url: 'http://evil.example:3080', pid: process.pid, file }));
    assert.throws(() => writeHubDiscovery({ url: 'http://127.0.0.1:51234', pid: 0, file }));
    assert.throws(() => writeHubDiscovery({ url: 'http://127.0.0.1:51234', pid: -1, file }));

    const written = writeHubDiscovery({ url: 'http://0.0.0.0:51234/', pid: process.pid, file });
    assert.equal(written.url, 'http://127.0.0.1:51234');
    assert.equal(written.pid, process.pid);

    const read = readHubDiscovery({ file });
    assert.equal(read?.url, 'http://127.0.0.1:51234');
    assert.equal(read?.pid, process.pid);

    // Different PID, mismatched URL, or invalid URL must never remove the active record.
    assert.equal(removeHubDiscoveryIfOwned({ pid: process.pid + 1, file }), false);
    assert.equal(removeHubDiscoveryIfOwned({ pid: process.pid, url: 'http://127.0.0.1:59999', file }), false);
    assert.equal(removeHubDiscoveryIfOwned({ pid: process.pid, url: 'not-a-url', file }), false);
    assert.equal(removeHubDiscoveryIfOwned({ pid: process.pid, url: 'http://evil.example:3080', file }), false);
    assert.notEqual(readHubDiscovery({ file }), null);

    // Non-loopback manual corruption or malformed JSON in hub.json is rejected on read.
    writeFileSync(file, JSON.stringify({ url: 'http://evil.example:3080', pid: process.pid }));
    assert.equal(readHubDiscovery({ file }), null);
    writeFileSync(file, '{not-valid-json');
    assert.equal(readHubDiscovery({ file }), null);

    // Matching PID + URL cleans up cleanly.
    writeHubDiscovery({ url: 'http://127.0.0.1:51234', pid: process.pid, file });
    assert.equal(removeHubDiscoveryIfOwned({ pid: process.pid, url: 'http://127.0.0.1:51234', file }), true);
    assert.equal(readHubDiscovery({ file }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractWebServerUrl and extractRequestLoopbackUrl normalize server bindings safely', () => {
  assert.equal(extractWebServerUrl({ url: 'http://localhost:55000/' }), 'http://localhost:55000');
  assert.equal(
    extractWebServerUrl({ url: 'http://127.0.0.1:3080', address: () => ({ address: '127.0.0.1', port: 54321 }) }),
    'http://127.0.0.1:54321',
  );
  assert.equal(extractWebServerUrl({ port: 55001, host: '0.0.0.0' }), 'http://127.0.0.1:55001');
  assert.equal(extractWebServerUrl({ port: 55003, host: '127.0.0.1', protocol: 'https:' }), 'https://127.0.0.1:55003');
  assert.equal(extractWebServerUrl({ port: 55004, host: '127.0.0.1', https: {} }), 'https://127.0.0.1:55004');
  assert.equal(extractWebServerUrl({ port: 55005, host: '127.0.0.1', https: false }), 'http://127.0.0.1:55005');
  assert.equal(extractWebServerUrl({ server: { address: () => ({ address: '::', port: 55002 }) } }), 'http://127.0.0.1:55002');
  assert.equal(extractWebServerUrl({}), null);

  // Mock requests without a bound socket.localPort / localAddress must return null, and spoofed Host is ignored.
  assert.equal(extractRequestLoopbackUrl({ socket: { remoteAddress: '127.0.0.1' } }), null);
  assert.equal(extractRequestLoopbackUrl({ socket: { localPort: 63720 } }), null);
  assert.equal(extractRequestLoopbackUrl({ socket: { localAddress: '10.0.0.5', localPort: 63720 } }), null);
  assert.equal(
    extractRequestLoopbackUrl({
      headers: { host: 'evil.example:9999' },
      socket: { localAddress: '127.0.0.1', localPort: 63720 },
    }),
    'http://127.0.0.1:63720',
  );
  assert.equal(
    extractRequestLoopbackUrl({ socket: { localAddress: '::ffff:127.0.0.1', localPort: 63720 } }),
    'http://127.0.0.1:63720',
  );
  assert.equal(
    extractRequestLoopbackUrl({ socket: { localAddress: '::1', localPort: 63721 } }),
    'http://[::1]:63721',
  );
});

test('resolveHubCandidates honors env override, custom config fallback, and live discovery priority', () => {
  const liveDisc = { url: 'http://127.0.0.1:63720', pid: process.pid };
  const deadDisc = { url: 'http://127.0.0.1:63721', pid: 999999999 };

  assert.deepEqual(
    resolveHubCandidates({
      env: { DSHPLUGIN_CREW_HUB: 'http://127.0.0.1:4444/' },
      config: { hub_url: 'http://127.0.0.1:5555' },
      discovery: liveDisc,
      active: 'http://127.0.0.1:6666',
    }),
    ['http://127.0.0.1:4444'],
  );

  // Default 3080 prefers live hub.json first so Desktop ephemeral ports connect immediately.
  assert.deepEqual(
    resolveHubCandidates({
      env: {},
      config: { hub_url: 'http://127.0.0.1:3080' },
      discovery: liveDisc,
    }),
    ['http://127.0.0.1:63720', 'http://127.0.0.1:3080'],
  );

  // Explicit custom hub_url tries custom first, falling back to live discovery.
  assert.deepEqual(
    resolveHubCandidates({
      env: {},
      config: { hub_url: 'http://127.0.0.1:3095/' },
      discovery: liveDisc,
    }),
    ['http://127.0.0.1:3095', 'http://127.0.0.1:63720'],
  );

  // Stale discovery record whose PID is dead is ignored.
  assert.deepEqual(
    resolveHubCandidates({
      env: {},
      config: { hub_url: 'http://127.0.0.1:3080' },
      discovery: deadDisc,
    }),
    ['http://127.0.0.1:3080'],
  );
});

async function allocateUnusedPort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function closeServer(srv) {
  if (!srv) return;
  srv.closeAllConnections?.();
  if (srv.listening) {
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

async function startStubHub(label, port = 0) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/_dsh/dsh-crew/ping') {
      res.end(JSON.stringify({ ok: true, service: 'dsh-crew-hub', label }));
      return;
    }
    if (req.url === '/_dsh/dsh-crew/jobs') {
      res.end(JSON.stringify({ ok: true, jobs: [{ id: `job-${label}`, status: 'done' }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return { server, port: actualPort, url: `http://127.0.0.1:${actualPort}` };
}

test('createHubClient dynamically discovers and switches to a restarted hub port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-e2e-'));
  const file = join(dir, 'hub.json');
  const stubA = await startStubHub('A');
  let stubB = null;

  try {
    // Point config at an unused ephemeral port (simulating stale default 3080 on Desktop),
    // while hub.json is absent initially -> negative probe.
    const unusedPort = await allocateUnusedPort();
    const client = createHubClient({
      env: {},
      readConfig: () => ({ hub_url: `http://127.0.0.1:${unusedPort}` }),
      readDiscovery: () => readHubDiscovery({ file }),
    });

    assert.equal(client.getActiveHubUrl(), null);
    assert.equal(await client.hubAvailable(), false);
    assert.equal(client.getActiveHubUrl(), null);

    // Hub A starts and writes hub.json -> immediately discovered without waiting for negative TTL.
    writeHubDiscovery({ url: stubA.url, pid: process.pid, file });
    assert.equal(await client.hubAvailable(), true);
    assert.equal(client.getActiveHubUrl(), stubA.url);
    assert.deepEqual(await client.hub.list(), [{ id: 'job-A', status: 'done' }]);

    // Simulate Desktop restart: Hub A shuts down, Hub B binds a new ephemeral port.
    await closeServer(stubA.server);
    stubB = await startStubHub('B');
    writeHubDiscovery({ url: stubB.url, pid: process.pid, file });

    // Calling hub.list() directly hits ECONNREFUSED on A, re-discovers B, and succeeds!
    const jobsB = await client.hub.list();
    assert.deepEqual(jobsB, [{ id: 'job-B', status: 'done' }]);
    assert.equal(client.getActiveHubUrl(), stubB.url);
  } finally {
    await closeServer(stubA.server);
    await closeServer(stubB?.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createHubClient recovers when a hub restarts on the same port', async () => {
  const stub1 = await startStubHub('same-1');
  let stub2 = null;
  try {
    const client = createHubClient({
      env: {},
      readConfig: () => ({ hub_url: stub1.url }),
      readDiscovery: () => null,
    });
    assert.deepEqual(await client.hub.list(), [{ id: 'job-same-1', status: 'done' }]);

    await closeServer(stub1.server);
    stub2 = await startStubHub('same-2', stub1.port);

    assert.deepEqual(await client.hub.list(), [{ id: 'job-same-2', status: 'done' }]);
    assert.equal(client.getActiveHubUrl(), stub2.url);
  } finally {
    await closeServer(stub1.server);
    await closeServer(stub2?.server);
  }
});

test('createHubClient switches immediately when config.hub_url changes while old hub stays up', async () => {
  const stubA = await startStubHub('live-A');
  const stubB = await startStubHub('live-B');
  try {
    let currentHubUrl = stubA.url;
    const client = createHubClient({
      env: {},
      readConfig: () => ({ hub_url: currentHubUrl }),
      readDiscovery: () => null,
    });

    assert.equal(await client.hubAvailable(), true);
    assert.equal(client.getActiveHubUrl(), stubA.url);
    assert.deepEqual(await client.hub.list(), [{ id: 'job-live-A', status: 'done' }]);

    // While stubA is STILL responding, point config.hub_url to stubB.
    currentHubUrl = stubB.url;
    assert.equal(await client.hubAvailable(), true);
    assert.equal(client.getActiveHubUrl(), stubB.url);
    assert.deepEqual(await client.hub.list(), [{ id: 'job-live-B', status: 'done' }]);
  } finally {
    await closeServer(stubA.server);
    await closeServer(stubB.server);
  }
});

test('createHubClient coalesces single-flight probes, enforces CAS activeBase reset, and redacts URLs', async () => {
  assert.equal(redactHubUrl('http://user:secret@127.0.0.1:3080/prefix/?token=x#frag'), 'http://127.0.0.1:3080/prefix');
  assert.equal(redactHubUrl('not-a-url'), null);

  let pingCount = 0;
  let releasePing;
  const pingGate = new Promise((resolve) => { releasePing = resolve; });

  let configUrl = 'http://127.0.0.1:41001';
  let releasePostA;
  const postAGate = new Promise((resolve) => { releasePostA = resolve; });

  const client = createHubClient({
    env: {},
    readConfig: () => ({ hub_url: configUrl }),
    readDiscovery: () => null,
    fetchImpl: async (url, init) => {
      if (url === 'http://127.0.0.1:41001/_dsh/dsh-crew/ping') {
        pingCount += 1;
        await pingGate;
        return new Response(JSON.stringify({ ok: true, service: 'dsh-crew-hub' }), { status: 200 });
      }
      if (url === 'http://127.0.0.1:41002/_dsh/dsh-crew/ping') {
        return new Response(JSON.stringify({ ok: true, service: 'dsh-crew-hub' }), { status: 200 });
      }
      if (url === 'http://127.0.0.1:41001/_dsh/dsh-crew/worker-probe') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.mode === 'bad-html') {
          return new Response('<html>502 Bad Gateway</html>', { status: 502 });
        }
        return new Response(JSON.stringify({ ok: true, result: { status: 'verified' } }), { status: 200 });
      }
      if (url === 'http://127.0.0.1:41001/_dsh/dsh-crew/jobs' && init?.method === 'POST') {
        await postAGate;
        throw Object.assign(new Error('late transport failure'), { code: 'ECONNRESET' });
      }
      return new Response(JSON.stringify({ ok: true, jobs: [{ id: 'B' }] }), { status: 200 });
    },
  });

  // 1. Concurrent hubAvailable() calls coalesce into a single ping flight.
  const p1 = client.hubAvailable();
  const p2 = client.hubAvailable();
  releasePing();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(pingCount, 1);
  assert.equal(client.getActiveHubUrl(), 'http://127.0.0.1:41001');

  // 2. Non-JSON response throws a status-carrying error.
  await assert.rejects(
    () => client.hub.probe({ mode: 'bad-html' }),
    (err) => err instanceof Error && err.status === 502 && /non-JSON/i.test(err.message),
  );

  // 3. In-flight POST on hub 41001 fails AFTER activeBase moved to 41002 -> must NOT clear 41002!
  configUrl = 'http://127.0.0.1:41001';
  const slowPost = client.hub.spawn({ prompt: 'hi' });
  configUrl = 'http://127.0.0.1:41002';
  assert.equal(await client.hubAvailable({ force: true }), true);
  assert.equal(client.getActiveHubUrl(), 'http://127.0.0.1:41002');
  releasePostA();
  await assert.rejects(slowPost, /late transport failure/);
  assert.equal(client.getActiveHubUrl(), 'http://127.0.0.1:41002');
});

// Marathon & running events · S5 — the webhook SSRF guard (spec §7.2). OWNER REVIEW (D35). No database. The resolver is injected: no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { isBlockedAddress, parseWebhookUrl, checkWebhookUrl, sendPinned, pinnedLookup, URL_REASONS } from '../src/shared/webhook-url-guard.mjs';

const resolver = map => async (host) => { if (!(host in map)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return map[host].map(a => (typeof a === 'string' ? { address: a, family: a.includes(':') ? 6 : 4 } : a)); };
const PUBLIC = '93.184.216.34';

test('every blocked IPv4 range, edge to edge, and public neighbours that must pass', () => {
  const blocked = ['0.0.0.0', '0.255.255.255', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.55', '192.88.99.1', '192.168.1.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'];
  for (const a of blocked) assert.equal(isBlockedAddress(a), true, a);
  for (const a of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.255.255', '169.255.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.254', '11.0.0.1', '126.255.255.255', '128.0.0.1']) assert.equal(isBlockedAddress(a), false, a);
});

test('IPv6: loopback, unspecified, unique-local, link-local, multicast, documentation, Teredo, discard; IPv4-mapped / NAT64 / 6to4 judged by the embedded IPv4', () => {
  const blocked = ['::', '::1', '::0:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', 'ff00::', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '100::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::192.168.0.1', '2002:7f00:1::1', '2002:a9fe:a9fe::1', '2002:c0a8:0101::', '::127.0.0.1', '::10.1.2.3', '64:ff9b:1::1'];
  for (const a of blocked) assert.equal(isBlockedAddress(a), true, a);
  for (const a of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1']) assert.equal(isBlockedAddress(a), false, a);
  for (const bad of ['', 'not an ip', '1.2.3', '1.2.3.4.5', '300.1.1.1', '::g', '1::2::3', 'fe80::1%eth0', null, undefined, 42]) assert.equal(isBlockedAddress(bad), true, `unparseable is blocked: ${bad}`);
});

test('URL shape: https only, port 443 only, no credentials, no IP literals in ANY notation, host denylist, single-label names, length', () => {
  const cases = {
    'http://hooks.example.com/x': 'not_https', 'ftp://hooks.example.com': 'not_https', 'javascript:alert(1)': 'not_https', 'hooks.example.com/x': 'not_https', '': 'not_https', 'https://': 'not_https',
    'https://user:pw@hooks.example.com/x': 'credentials_in_url', 'https://user@hooks.example.com/x': 'credentials_in_url',
    'https://hooks.example.com:8443/x': 'bad_port', 'https://hooks.example.com:80/x': 'bad_port', 'https://hooks.example.com:0/x': 'bad_port',
    'https://127.0.0.1/x': 'ip_literal', 'https://[::1]/x': 'ip_literal', 'https://[::ffff:127.0.0.1]/x': 'ip_literal', 'https://2130706433/x': 'ip_literal', 'https://0x7f000001/x': 'ip_literal', 'https://017700000001/x': 'ip_literal',
    'https://0x7f.0.0.1/x': 'ip_literal', 'https://127.1/x': 'ip_literal', 'https://169.254.169.254/latest/meta-data': 'ip_literal', 'https://8.8.8.8/x': 'ip_literal', 'https://1.1.1.1.:443/x': 'ip_literal',
    'https://localhost/x': 'blocked_host', 'https://LOCALHOST./x': 'blocked_host', 'https://app.localhost/x': 'blocked_host', 'https://printer.local/x': 'blocked_host', 'https://db.internal/x': 'blocked_host',
    'https://metadata.google.internal/x': 'blocked_host', 'https://router.lan/x': 'blocked_host', 'https://x.home.arpa/x': 'blocked_host', 'https://intranet/x': 'blocked_host', 'https://kubernetes.default.svc.cluster.internal/': 'blocked_host',
    [`https://hooks.example.com/${'a'.repeat(2000)}`]: 'too_long',
  };
  for (const [url, reason] of Object.entries(cases)) assert.deepEqual([url.slice(0, 60), parseWebhookUrl(url).reason], [url.slice(0, 60), reason]);
  for (const reason of Object.values(cases)) assert.ok(URL_REASONS.includes(reason));
  const ok = parseWebhookUrl('https://Hooks.Example.COM./path?q=1#frag');
  assert.deepEqual([ok.ok, ok.host, ok.url], [true, 'hooks.example.com', 'https://hooks.example.com/path?q=1'], 'host normalised, trailing dot and fragment dropped');
  assert.equal(parseWebhookUrl('https://hooks.example.com:443/x').ok, true, 'the explicit default port is 443');
  assert.equal(parseWebhookUrl('https://münchen.example/x').host, 'xn--mnchen-3ya.example', 'IDNA to punycode');
  assert.equal(parseWebhookUrl(`https://hooks.example.com/${'a'.repeat(1900)}`).ok, true);
});

test('DNS: EVERY address must be public — one private answer refuses the URL; none → unresolvable; resolver errors → unresolvable', async () => {
  const resolve = resolver({
    'ok.example.com': [PUBLIC, '2606:4700:4700::1111'], 'internal.example.com': ['10.0.0.5'], 'mixed.example.com': [PUBLIC, '10.0.0.5'], 'mixed6.example.com': [PUBLIC, 'fd00::1'], 'metadata.example.com': ['169.254.169.254'],
    'mapped.example.com': ['::ffff:127.0.0.1'], 'empty.example.com': [], 'loop.example.com': ['127.0.0.1'], 'nat64.example.com': ['64:ff9b::a00:1'],
  });
  const reasons = {};
  for (const host of Object.keys({ 'ok.example.com': 1, 'internal.example.com': 1, 'mixed.example.com': 1, 'mixed6.example.com': 1, 'metadata.example.com': 1, 'mapped.example.com': 1, 'empty.example.com': 1, 'loop.example.com': 1, 'nat64.example.com': 1, 'nx.example.com': 1 })) reasons[host] = await checkWebhookUrl(`https://${host}/hook`, { resolve });
  assert.equal(reasons['ok.example.com'].ok, true);
  assert.deepEqual(reasons['ok.example.com'].addresses.map(a => a.address), [PUBLIC, '2606:4700:4700::1111']);
  for (const h of ['internal', 'mixed', 'mixed6', 'metadata', 'mapped', 'loop', 'nat64']) assert.deepEqual([h, reasons[`${h}.example.com`]], [h, { ok: false, reason: 'blocked_address' }]);
  for (const h of ['empty', 'nx']) assert.deepEqual([h, reasons[`${h}.example.com`]], [h, { ok: false, reason: 'unresolvable' }]);
  // a resolver that throws, and one that returns garbage
  assert.deepEqual(await checkWebhookUrl('https://x.example.com/', { resolve: async () => { throw new Error('boom'); } }), { ok: false, reason: 'unresolvable' });
  assert.deepEqual(await checkWebhookUrl('https://x.example.com/', { resolve: async () => [{ nothing: true }] }), { ok: false, reason: 'unresolvable' });
  assert.deepEqual(await checkWebhookUrl('http://x.example.com/', { resolve: async () => { throw new Error('must not resolve'); } }), { ok: false, reason: 'not_https' }, 'shape is judged BEFORE any DNS lookup');
});

test('DNS REBINDING: a name that was public at registration and is private at delivery fails the delivery-time check (the guard is run again, on a fresh answer)', async () => {
  let answer = [PUBLIC];
  const resolve = async () => answer.map(a => ({ address: a, family: 4 }));
  assert.equal((await checkWebhookUrl('https://rebind.example.com/hook', { resolve })).ok, true);
  answer = ['127.0.0.1'];
  assert.deepEqual(await checkWebhookUrl('https://rebind.example.com/hook', { resolve }), { ok: false, reason: 'blocked_address' });
  answer = [PUBLIC, '169.254.169.254'];
  assert.equal((await checkWebhookUrl('https://rebind.example.com/hook', { resolve })).reason, 'blocked_address');
});

test('pinnedLookup answers ONLY with the validated address, with and without `all`', async () => {
  const lookup = pinnedLookup({ address: PUBLIC, family: 4 });
  assert.deepEqual(await new Promise(r => lookup('anything.example', {}, (e, a, f) => r([e, a, f]))), [null, PUBLIC, 4]);
  assert.deepEqual(await new Promise(r => lookup('anything.example', { all: true }, (e, a) => r([e, a]))), [null, [{ address: PUBLIC, family: 4 }]]);
  assert.deepEqual(await new Promise(r => lookup('evil.example', (e, a) => r([e, a]))), [null, PUBLIC]);
});

// ── A real TLS server on loopback: the sender is given the address it must dial, the name it must present ──

const dir = mkdtempSync(path.join(tmpdir(), 'ffwh-'));
let tlsOk = true;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=hooks.example.test', '-addext', 'subjectAltName=DNS:hooks.example.test'], { stdio: 'ignore' });
} catch { tlsOk = false; }
after(() => rmSync(dir, { recursive: true, force: true }));

function server(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const s = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, (req, res) => { seen.push({ host: req.headers.host, sni: req.socket.servername, url: req.url, headers: req.headers }); handler(req, res); });
    s.listen(0, '127.0.0.1', () => resolve({ s, seen, port: s.address().port }));
  });
}
// the sender dials port 443 by contract; tests redirect that to the local port through a lookup-compatible shim is NOT possible, so the
// server is reached by overriding the port through the URL's own port only in this harness (the guard refuses it everywhere else).
const sendTo = (srv, over = {}) => sendPinned({ url: `https://hooks.example.test:${srv.port}/hook?x=1`, address: '127.0.0.1', family: 4, headers: { 'Content-Type': 'application/json', 'X-Test': '1' }, body: '{"a":1}', timeoutMs: 3000, tls: { ca: readFileSync(path.join(dir, 'c.pem')) }, ...over });

test('sendPinned: dials the pinned address, presents the NAME (SNI + Host), validates the certificate, sends the body as given', { skip: !tlsOk && 'openssl not available' }, async () => {
  const srv = await server((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  try {
    // the module always dials 443 (the guard only ever lets 443 through); make the harness reach the local port by wrapping https.request once
    const real = https.request;
    https.request = (opts, cb) => real({ ...opts, port: srv.port }, cb);
    const res = await sendTo(srv);
    https.request = real;
    assert.equal(res.status, 200);
    assert.equal(res.snippet, '{"ok":true}');
    assert.deepEqual([srv.seen[0].sni, srv.seen[0].host.startsWith('hooks.example.test'), srv.seen[0].url, srv.seen[0].headers['x-test']], ['hooks.example.test', true, '/hook?x=1', '1']);
    assert.equal(srv.seen[0].headers['content-length'], '7');
  } finally { https.request = https.request; srv.s.close(); }
});

test('sendPinned: a wrong certificate name or no trusted CA is tls_error (never rejectUnauthorized:false); a 3xx is returned as is (never followed); the body is read up to 4 KB; a slow server times out', { skip: !tlsOk && 'openssl not available' }, async () => {
  const srv = await server((req, res) => {
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' }); return res.end('moved'); }
    if (req.url.startsWith('/big')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('x'.repeat(100_000)); }
    if (req.url.startsWith('/slow')) return undefined;
    res.writeHead(200); return res.end('ok');
  });
  const real = https.request;
  https.request = (opts, cb) => real({ ...opts, port: srv.port }, cb);
  try {
    const ca = readFileSync(path.join(dir, 'c.pem'));
    // no CA → the self-signed certificate is refused
    await assert.rejects(sendPinned({ url: 'https://hooks.example.test/hook', address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 3000 }), err => err.code === 'tls_error');
    // CA given but the NAME does not match the certificate
    await assert.rejects(sendPinned({ url: 'https://other.example.test/hook', address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 3000, tls: { ca } }), err => err.code === 'tls_error');
    const redirect = await sendPinned({ url: 'https://hooks.example.test/redirect', address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 3000, tls: { ca } });
    assert.equal(redirect.status, 302);
    assert.equal(srv.seen.filter(s => s.url.startsWith('/redirect')).length, 1, 'the Location was not followed');
    const big = await sendPinned({ url: 'https://hooks.example.test/big', address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 3000, tls: { ca } });
    assert.ok(big.snippet.length <= 4096 && big.snippet.length > 1000);
    await assert.rejects(sendPinned({ url: 'https://hooks.example.test/slow', address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 300, tls: { ca } }), err => err.code === 'timeout');
    // a refused connection is a network_error
    srv.s.close();
    await assert.rejects(sendPinned({ url: 'https://hooks.example.test/hook', address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 1000, tls: { ca } }), err => ['network_error', 'tls_error'].includes(err.code));
  } finally { https.request = real; srv.s.close(); }
});

test('sendPinned never dials any address but the one it was given, whatever name the URL carries', { skip: !tlsOk && 'openssl not available' }, async () => {
  const srv = await server((req, res) => { res.writeHead(200); res.end('pinned'); });
  const real = https.request;
  let dialled = null;
  https.request = (opts, cb) => { dialled = opts; return real({ ...opts, port: srv.port }, cb); };
  try {
    // a hostname that would resolve elsewhere in DNS is never looked up: the lookup option is the pin
    const res = await sendPinned({ url: 'https://hooks.example.test/hook', address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 3000, tls: { ca: readFileSync(path.join(dir, 'c.pem')) } });
    assert.equal(res.snippet, 'pinned');
    const answer = await new Promise(r => dialled.lookup('hooks.example.test', {}, (e, a, f) => r([a, f])));
    assert.deepEqual(answer, ['127.0.0.1', 4]);
    assert.equal(dialled.rejectUnauthorized, true);
    assert.equal(dialled.servername, 'hooks.example.test');
    assert.equal(dialled.agent, false, 'no shared keep-alive agent: one validated socket per attempt');
  } finally { https.request = real; srv.s.close(); }
});
void writeFileSync;

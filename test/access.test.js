import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessIdentity, createAccessVerifier } from '../src/access.js';

const TEAM = 'margaux.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const NOW = 1_800_000_000_000;

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const json = (value) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  return { privateKey: pair.privateKey, jwk };
}

async function sign(key, kid, claims, header = {}) {
  const head = json({ alg: 'RS256', kid, ...header });
  const body = json(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const goodClaims = (over = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  sub: 'user-1',
  email: 'friend@example.com',
  exp: NOW / 1000 + 600,
  ...over,
});

function setup(keys) {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }));
  };
  const verify = createAccessVerifier({ teamDomain: TEAM, audience: AUD, fetchImpl, now: () => NOW });
  return { verify, fetches: () => fetches };
}

test('accepts a valid token and returns the stable subject', async () => {
  const key = await makeKey('k1');
  const { verify } = setup([key]);
  const who = await verify(await sign(key, 'k1', goodClaims()));
  assert.deepEqual(who, { sub: 'user-1', email: 'friend@example.com' });
});

test('rejects wrong audience, wrong issuer, expired and not-yet-valid tokens', async () => {
  const key = await makeKey('k1');
  const { verify } = setup([key]);
  for (const over of [
    { aud: ['other'] },
    { iss: 'https://evil.cloudflareaccess.com' },
    { exp: NOW / 1000 - 3600 },
    { nbf: NOW / 1000 + 3600 },
    { sub: '' },
  ]) {
    await assert.rejects(verify(await sign(key, 'k1', goodClaims(over))), { status: 401 });
  }
});

test('rejects a token signed by another key, a tampered payload and a bad algorithm', async () => {
  const key = await makeKey('k1');
  const attacker = await makeKey('k1');
  const { verify } = setup([key]);
  await assert.rejects(verify(await sign(attacker, 'k1', goodClaims())), { status: 401 });

  const good = await sign(key, 'k1', goodClaims());
  const [h, , s] = good.split('.');
  await assert.rejects(verify(`${h}.${json(goodClaims({ sub: 'admin' }))}.${s}`), { status: 401 });

  await assert.rejects(verify(await sign(key, 'k1', goodClaims(), { alg: 'none' })), { status: 401 });
  await assert.rejects(verify(await sign(key, 'k1', goodClaims(), { alg: 'HS256' })), { status: 401 });
});

test('rejects missing, malformed and oversized tokens', async () => {
  const { verify } = setup([await makeKey('k1')]);
  for (const bad of [null, '', 'abc', 'a.b', 'a.b.c', 'x'.repeat(9000)]) {
    await assert.rejects(verify(bad), { status: 401 });
  }
});

test('refetches keys for an unknown kid (rotation) and fails closed when keys are unavailable', async () => {
  const old = await makeKey('k1');
  const rotated = await makeKey('k2');
  const keys = [old];
  const verify = createAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) })),
  });
  await verify(await sign(old, 'k1', goodClaims()));
  keys.push(rotated);
  await verify(await sign(rotated, 'k2', goodClaims()));

  const down = createAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    now: () => NOW,
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  await assert.rejects(down(await sign(old, 'k1', goodClaims())), { status: 503 });
});

test('refuses to be built with a bad team domain or no audience', () => {
  assert.throws(() => createAccessVerifier({ teamDomain: 'evil.example.com', audience: AUD }));
  assert.throws(() => createAccessVerifier({ teamDomain: TEAM, audience: '' }));
  assert.throws(() => createAccessVerifier({ teamDomain: undefined, audience: AUD }));
});

test('accessIdentity uses the header and never sets a cookie', async () => {
  const key = await makeKey('k1');
  const { verify } = setup([key]);
  const identify = accessIdentity(verify);
  const token = await sign(key, 'k1', goodClaims());
  const ok = await identify(new Request('https://x.test/api/maps', { headers: { 'cf-access-jwt-assertion': token } }));
  assert.deepEqual(ok, { userId: 'access:user-1', setCookie: null });
  await assert.rejects(identify(new Request('https://x.test/api/maps')), { status: 401 });
  // The plain email header is never trusted.
  await assert.rejects(
    identify(new Request('https://x.test/api/maps', { headers: { 'cf-access-authenticated-user-email': 'a@b.c' } })),
    { status: 401 },
  );
});

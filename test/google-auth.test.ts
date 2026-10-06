import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorizeGoogle, type GoogleAuthOptions } from '../src/cli/connections/google-auth.js';
import { SetupCancelled, SetupIssue } from '../src/cli/errors.js';

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function close(server: Server): Promise<void> { await new Promise<void>(resolve => server.close(() => resolve())); }
async function assertPortReleased(port: number): Promise<void> {
  const server = createServer();
  try { await listen(server, port); } finally { await close(server); }
}
function begin(tokenPath: string, options: GoogleAuthOptions = {}) {
  let ready!: (url: URL) => void;
  const url = new Promise<URL>(resolve => { ready = resolve; });
  const operation = authorizeGoogle({
    clientId: 'test-client', clientSecret: 'private-client-secret', tokenPath, port: 0, timeoutMs: 1000,
    notify: message => {
      assert.ok(!message.includes('private-client-secret'));
      ready(new URL(message.split('\n').find(line => line.startsWith('https://'))!));
    }, ...options,
  });
  operation.catch(() => {});
  return { url, operation };
}
function callback(auth: URL): URL {
  const url = new URL(auth.searchParams.get('redirect_uri')!);
  url.searchParams.set('state', auth.searchParams.get('state')!);
  url.searchParams.set('code', 'private-authorization-code');
  return url;
}

test('Google OAuth validates callback state/path, exchanges the code once and persists private credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-google-auth-'));
  try {
    const tokenPath = join(dir, 'google.json');
    let exchanges = 0;
    const request: typeof fetch = async (input, options) => {
      exchanges++;
      assert.equal(String(input), 'https://oauth2.googleapis.com/token');
      assert.equal(options?.redirect, 'error'); assert.equal(options?.method, 'POST');
      const body = options!.body as URLSearchParams;
      assert.equal(body.get('code'), 'private-authorization-code');
      assert.equal(body.get('client_secret'), 'private-client-secret');
      assert.equal(body.get('grant_type'), 'authorization_code');
      return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 });
    };
    const flow = begin(tokenPath, { request });
    const auth = await flow.url;
    assert.equal(auth.hostname, 'accounts.google.com');
    const valid = callback(auth), port = Number(valid.port);
    const wrongPath = new URL(valid); wrongPath.pathname = '/wrong';
    assert.equal((await fetch(wrongPath)).status, 400);
    const wrongState = new URL(valid); wrongState.searchParams.set('state', 'invalid');
    assert.equal((await fetch(wrongState)).status, 400);
    assert.equal(exchanges, 0);
    assert.equal((await fetch(valid)).status, 200);
    await flow.operation;
    const saved = JSON.parse(await readFile(tokenPath, 'utf8'));
    assert.equal(saved.refresh_token, 'private-refresh'); assert.equal(saved.access_token, 'private-access');
    assert.ok(saved.expires_at > Date.now()); assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal(exchanges, 1); await assertPortReleased(port);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Google OAuth timeout closes the loopback listener and leaves existing tokens intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-google-timeout-'));
  try {
    const tokenPath = join(dir, 'google.json'); await writeFile(tokenPath, 'previous');
    const flow = begin(tokenPath, { timeoutMs: 80 });
    const auth = await flow.url, port = Number(callback(auth).port);
    await assert.rejects(flow.operation, (error: unknown) => error instanceof SetupIssue && /истекло/.test(error.message));
    assert.equal(await readFile(tokenPath, 'utf8'), 'previous'); await assertPortReleased(port);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Google OAuth cancellation closes the listener while waiting for the browser', async () => {
  const abort = new AbortController();
  const flow = begin('unused-google-token-path', { signal: abort.signal });
  const auth = await flow.url, port = Number(callback(auth).port);
  abort.abort(); await assert.rejects(flow.operation, SetupCancelled); await assertPortReleased(port);
});

test('Google OAuth cancellation during token exchange propagates and releases the listener', async () => {
  const abort = new AbortController();
  let started!: () => void;
  const exchange = new Promise<void>(resolve => { started = resolve; });
  const flow = begin('unused-google-token-path', {
    signal: abort.signal,
    request: async (_input, options) => {
      started();
      return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    },
  });
  const auth = await flow.url, url = callback(auth), port = Number(url.port);
  await fetch(url); await exchange; abort.abort();
  await assert.rejects(flow.operation, SetupCancelled); await assertPortReleased(port);
});

test('Google OAuth provider denial and malformed token data never replace previous tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-google-errors-'));
  try {
    const tokenPath = join(dir, 'google.json'); await writeFile(tokenPath, 'previous');
    let exchanges = 0;
    const denied = begin(tokenPath, { request: async () => { exchanges++; return Response.json({}); } });
    const url = callback(await denied.url); url.searchParams.delete('code'); url.searchParams.set('error', 'access_denied');
    await fetch(url); await assert.rejects(denied.operation, SetupIssue);
    assert.equal(exchanges, 0); await assertPortReleased(Number(url.port));

    for (const response of [
      new Response('private-token-response', { status: 401 }),
      new Response('<html>private-token-response</html>'),
      Response.json({ access_token: 'private-access', expires_in: 3600 }),
      Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: -1 }),
      Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 1e308 }),
    ]) {
      const flow = begin(tokenPath, { request: async () => response });
      const url = callback(await flow.url); await fetch(url);
      await assert.rejects(flow.operation, (error: unknown) => error instanceof SetupIssue && !/private|<html>/.test(error.message));
      assert.equal(await readFile(tokenPath, 'utf8'), 'previous'); await assertPortReleased(Number(url.port));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Google OAuth validates missing credentials before opening the requested port', async () => {
  const probe = createServer(), port = await listen(probe); await close(probe);
  await assert.rejects(authorizeGoogle({ clientId: 'test-client', clientSecret: '', port }), /GOOGLE_CLIENT_SECRET/);
  await assertPortReleased(port);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(authorizeGoogle({ clientId: 'test-client', clientSecret: 'private', port, signal: abort.signal }), SetupCancelled);
  await assertPortReleased(port);
});

test('Google OAuth handles an occupied loopback port without disturbing its existing listener', async () => {
  const occupied = createServer(), port = await listen(occupied);
  try {
    await assert.rejects(authorizeGoogle({ clientId: 'test-client', clientSecret: 'private', port }), /локальный порт/);
    assert.ok(occupied.listening);
  } finally { await close(occupied); }
  await assertPortReleased(port);
});

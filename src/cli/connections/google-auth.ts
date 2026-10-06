import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { secret, secretsDir } from '../../config.js';
import { writeSecret } from '../../store.js';
import { SetupCancelled, SetupIssue } from '../errors.js';

export interface GoogleAuthOptions {
  notify?: (message: string) => void;
  signal?: AbortSignal;
  port?: number;
  request?: typeof fetch;
  tokenPath?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}

function credential(value: string | undefined, name: string): string {
  try {
    const result = value ?? secret(name);
    if (!result.trim() || /[\r\n\0]/.test(result)) throw new Error();
    return result;
  } catch { throw new SetupIssue(`Укажи ${name} перед входом Google.`); }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    // An unfinished local HTTP request must not keep the setup process alive.
    server.closeAllConnections();
  });
}

/** Loopback OAuth shared by interactive onboarding and legacy setup commands. */
export async function authorizeGoogle(options: GoogleAuthOptions = {}): Promise<void> {
  const clientId = credential(options.clientId, 'GOOGLE_CLIENT_ID');
  const clientSecret = credential(options.clientSecret, 'GOOGLE_CLIENT_SECRET');
  const port = options.port ?? 8765;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new SetupIssue('Некорректный порт Google OAuth.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SetupIssue('Некорректное время ожидания Google OAuth.');
  if (options.signal?.aborted) throw new SetupCancelled();

  const lifetime = new AbortController();
  const cancel = () => lifetime.abort(new SetupCancelled());
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => lifetime.abort(new SetupIssue('Время входа Google истекло. Повтори подключение.')), timeoutMs);
  const interrupted = new Promise<never>((_, reject) => {
    lifetime.signal.addEventListener('abort', () => reject(lifetime.signal.reason), { once: true });
  });
  // The interruption can arrive before the first race is installed.
  interrupted.catch(() => {});
  const state = randomBytes(24).toString('hex');
  let redirect = '';
  let acceptCode!: (value: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { acceptCode = resolve; rejectCode = reject; });
  codePromise.catch(() => {});
  const server = createServer((req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', redirect); } catch { res.writeHead(400); res.end('Invalid callback'); return; }
    if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      res.writeHead(400); res.end('Invalid callback'); return;
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code) {
      res.end('Авторизация отменена. Вернись в терминал.');
      rejectCode(new SetupIssue('Google не подтвердил вход. Повтори подключение.'));
      return;
    }
    res.end('Авторизация получена. Можно закрыть окно.');
    acceptCode(code);
  });

  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(new SetupIssue('Не удалось открыть локальный порт Google OAuth. Закрой другой процесс на этом порту и повтори вход.')));
        server.listen(port, '127.0.0.1', () => resolve());
      }),
      interrupted,
    ]);
    const address = server.address();
    if (!address || typeof address === 'string') throw new SetupIssue('Не удалось открыть Google OAuth.');
    redirect = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: 'code',
      scope: ['calendar.events', 'calendar.app.created', 'calendar.calendarlist.readonly'].map(scope => `https://www.googleapis.com/auth/${scope}`).join(' '),
      access_type: 'offline', prompt: 'consent', state,
    }).toString();
    (options.notify ?? console.log)(`Открой в браузере:\n${url.href}\nДля VPS предварительно пробрось SSH-порт ${address.port}.`);
    const code = await Promise.race([codePromise, interrupted]);
    const request = options.request ?? fetch;
    let response: Response;
    try {
      response = await Promise.race([request('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error',
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirect, grant_type: 'authorization_code' }),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]),
      }), interrupted]);
    } catch (error) {
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      throw new SetupIssue('Не удалось обменять код Google. Проверь соединение и повтори вход.');
    }
    if (!response.ok) throw new SetupIssue(`Google OAuth: HTTP ${response.status}. Повтори вход.`);
    let token: unknown;
    try { token = await Promise.race([response.json(), interrupted]); }
    catch { if (lifetime.signal.aborted) throw lifetime.signal.reason; throw new SetupIssue('Google вернул некорректный ответ авторизации.'); }
    if (!token || typeof token !== 'object') throw new SetupIssue('Google вернул некорректные данные авторизации.');
    const value = token as Record<string, unknown>;
    if (typeof value.access_token !== 'string' || !value.access_token.trim() ||
        typeof value.refresh_token !== 'string' || !value.refresh_token.trim() ||
        typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
        !Number.isFinite(Date.now() + value.expires_in * 1000)) {
      throw new SetupIssue('Google не вернул токены с корректным сроком действия. Повтори вход с подтверждением доступа.');
    }
    if (lifetime.signal.aborted) throw lifetime.signal.reason;
    const saved = {
      access_token: value.access_token, refresh_token: value.refresh_token,
      expires_in: value.expires_in, expires_at: Date.now() + value.expires_in * 1000,
    };
    await writeSecret(options.tokenPath ?? join(secretsDir(), 'google.json'), JSON.stringify(saved));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    await closeServer(server);
  }
}

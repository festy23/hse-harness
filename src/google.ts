import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { secret, secretsDir } from './config.js';
import { writeSecret } from './store.js';
import { budgets, withOperation, type OperationContext } from './operations.js';
import { limitedResponse } from './calendar/http.js';

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
export class Google {
  private tokens?: Tokens;
  private refreshing?: Promise<string>;
  async token(ctx?: OperationContext): Promise<string> {
    ctx?.throwIfAborted();
    this.tokens ??= JSON.parse(await readFile(join(secretsDir(), 'google.json'), 'utf8')) as Tokens;
    if (this.tokens.expires_at > Date.now() + 60_000) {
      return this.tokens.access_token;
    }
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    const token = await this.refreshing;
    ctx?.throwIfAborted();
    return token;
  }
  private async refresh(): Promise<string> {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: secret('GOOGLE_CLIENT_ID'),
        client_secret: secret('GOOGLE_CLIENT_SECRET'),
        refresh_token: this.tokens!.refresh_token,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`Google OAuth: ${r.status}; повторите setup google`);
    }
    const t = (await limitedResponse(r, 1_000_000).json()) as {
      access_token: string;
      expires_in: number;
    };
    this.tokens = {
      ...this.tokens!,
      access_token: t.access_token,
      expires_at: Date.now() + t.expires_in * 1000,
    };
    await writeSecret(join(secretsDir(), 'google.json'), JSON.stringify(this.tokens));
    return t.access_token;
  }
  async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    ctx?: OperationContext,
  ): Promise<T> {
    return withOperation('request', budgets.calendarRequest, ctx, async (op) => {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.token(op)}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: op.signal,
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw Object.assign(new Error(`Google Calendar: ${r.status}`), { status: r.status });
      }
      return r.status === 204 ? (undefined as T) : ((await limitedResponse(r).json()) as T);
    });
  }
}

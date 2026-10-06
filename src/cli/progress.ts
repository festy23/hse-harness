import { SetupCancelled } from './errors.js';

/** A progress indicator must never own stdin or exit before a setup transaction can roll back. */
export async function withProgress<T>(
  message: string,
  action: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const cancellation = new AbortController();
  const output = process.stdout;
  const animate = Boolean(output.isTTY && process.env.TERM !== 'dumb');
  const title = message.replace(/[\r\n]/g, ' ').replace(/[…\.]+$/, '');
  const frames = ['◒', '◐', '◓', '◑'];
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let outcome: 'success' | 'error' | 'cancelled' = 'error';

  const paint = (text: string): void => {
    if (!animate) {
      output.write(text + '\n');
      return;
    }
    const columns = Math.max(8, output.columns || 80);
    const characters = [...text];
    const line = characters.length >= columns
      ? characters.slice(0, columns - 2).join('') + '…' : text;
    output.write('\r\u001b[2K' + line);
  };

  const cancel = (): void => {
    if (cancellation.signal.aborted) return;
    clearInterval(timer);
    cancellation.abort(new SetupCancelled());
    paint('◌ Отменяю проверку…');
  };

  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  if (animate) output.write('\u001b[?25l');
  paint(`◌ ${title}…`);
  if (animate) timer = setInterval(() => paint(`${frames[frame++ % frames.length]} ${title}…`), 100);

  try {
    // Wait for cleanup even when the adapter cannot yet abort its network request.
    // Returning early would allow a late SDK write after credentials were rolled back.
    const result = await action(cancellation.signal);
    if (cancellation.signal.aborted) throw new SetupCancelled();
    outcome = 'success';
    return result;
  } catch (error) {
    if (cancellation.signal.aborted || error instanceof SetupCancelled) {
      outcome = 'cancelled';
      throw new SetupCancelled();
    }
    throw error;
  } finally {
    clearInterval(timer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    paint(outcome === 'success' ? `✓ ${title}`
      : outcome === 'cancelled' ? '○ Проверка отменена' : '○ Проверка не завершена');
    if (animate) output.write('\u001b[?25h\n');
  }
}

import { readFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeSecret } from '../store.js';
import { calendarSettings, type Config, type StudyProfile, type CalendarSelection } from '../config.js';
import { SetupIssue } from './errors.js';

export type SetupConfig = Config & Record<string, unknown>;

async function optionalFile(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SetupIssue(`Не удалось прочитать файл настроек: ${path}`);
  }
}

export function upsertEnv(contents: string, name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(value)) {
    throw new SetupIssue('Значение настройки должно занимать одну строку');
  }
  const quote = ["'", '`', '"'].find(mark => !value.includes(mark) && (mark !== '"' || !/\\[nr]/.test(value)));
  if (!quote) throw new SetupIssue('Значение настройки содержит неподдерживаемое сочетание кавычек');
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const lines = contents.split(/\r?\n/).filter(line => !pattern.test(line));
  while (lines.at(-1) === '') lines.pop();
  return [...lines, `${name}=${quote}${value}${quote}`, ''].join('\n');
}

export function normalizeSetupConfig(value: unknown): SetupConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupIssue('Конфигурация должна быть JSON-объектом');
  const raw = value as Record<string, unknown>;
  if (('timetableId' in raw || 'agentCalendarId' in raw) && !raw.calendars) {
    throw new SetupIssue('Устаревшие поля timetableId/agentCalendarId. Перенеси их в calendars по config.example.json');
  }
  for (const field of ['calendars', 'features']) {
    if (raw[field] !== undefined && (!raw[field] || typeof raw[field] !== 'object' || Array.isArray(raw[field]))) {
      throw new SetupIssue(`Поле ${field} должно быть объектом`);
    }
  }
  let calendars: ReturnType<typeof calendarSettings>;
  try { calendars = calendarSettings(raw); }
  catch (error) { throw new SetupIssue(`Календари: ${(error as Error).message}`); }
  const config: Record<string, unknown> = { ownerId: 0, chats: [], folders: [], model: '', pollSeconds: 60, ...raw, ...calendars };
  if (!Number.isSafeInteger(config.ownerId) || Number(config.ownerId) < 0) throw new SetupIssue('ownerId должен быть неотрицательным целым числом');
  if (!Array.isArray(config.chats) || config.chats.some(c => !c || typeof c.id !== 'string' || !/^-?\d+$/.test(c.id) || typeof c.title !== 'string')) {
    throw new SetupIssue('chats должен быть списком объектов с числовым id и названием title');
  }
  if (!Array.isArray(config.folders) || config.folders.some(f => typeof f !== 'string')) throw new SetupIssue('folders должен быть списком названий папок');
  if (typeof config.model !== 'string') throw new SetupIssue('model должен быть строкой');
  if (!Number.isFinite(config.pollSeconds) || Number(config.pollSeconds) < 15) throw new SetupIssue('pollSeconds должен быть числом не меньше 15');
  if (raw.profile !== undefined) {
    const profile = raw.profile as StudyProfile;
    if (!profile || typeof profile !== 'object' || ['name', 'university', 'program', 'group', 'academicYear', 'subjects', 'details'].some(key => typeof profile[key as keyof StudyProfile] !== 'string') || !Number.isInteger(profile.course) || profile.course < 1 || profile.course > 6) {
      throw new SetupIssue('profile должен содержать имя, вуз, программу, группу, курс 1–6, учебный год, предметы и дополнительные сведения');
    }
  }
  return config as SetupConfig;
}

/** A completed section commits its config and credentials; failures restore the draft and environment. */
export class SetupState {
  config!: SetupConfig;
  private version?: string;
  private pending?: Map<string, string>;
  private authBackups?: Map<string, string | undefined>;

  constructor(
    readonly root = process.cwd(),
    readonly envPath = resolve(root, process.env.DOTENV_CONFIG_PATH ?? '.env'),
    readonly configPath = resolve(root, process.env.STUDY_CONFIG ?? 'config.local.json'),
  ) {}

  get authDir(): string { return resolve(this.root, process.env.STUDY_SECRETS_DIR ?? 'secrets'); }
  get runtimeDir(): string { return resolve(this.root, process.env.STUDY_DATA_DIR ?? 'data'); }
  async prepare(): Promise<void> {
    await Promise.all([this.authDir, this.runtimeDir, join(this.runtimeDir, 'pi')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  }

  async load(): Promise<void> {
    this.version = await optionalFile(this.configPath);
    let parsed: unknown;
    try { parsed = JSON.parse(this.version ?? '{}'); }
    catch { throw new SetupIssue(`Некорректный JSON в ${this.configPath}. Исправь файл; прежние данные не изменены.`); }
    this.config = normalizeSetupConfig(parsed);
  }

  async save(): Promise<void> {
    if (this.pending) return;
    await this.commit(new Map());
  }

  async env(name: string, value: string): Promise<void> {
    upsertEnv('', name, value); // Validate before changing either the environment or the file.
    if (!this.pending) {
      await this.transaction(() => this.env(name, value));
      return;
    }
    this.pending.set(name, value);
    process.env[name] = value;
  }

  /** Protect fresh account sign-ins. Token refreshes for the existing account remain independent. */
  async protectAuth(file: 'google.json' | 'pi-auth.json' | 'telegram.session'): Promise<void> {
    if (!this.authBackups) throw new SetupIssue('Авторизация должна выполняться внутри шага настройки');
    const path = join(this.authDir, file);
    if (!this.authBackups.has(path)) this.authBackups.set(path, await optionalFile(path));
  }

  async transaction<T>(action: () => Promise<T>): Promise<T> {
    if (this.pending) throw new SetupIssue('Другой шаг настройки уже выполняется');
    const previousConfig = structuredClone(this.config);
    const environment = { ...process.env };
    const changes = new Map<string, string>();
    this.pending = changes;
    const backups = new Map<string, string | undefined>();
    this.authBackups = backups;
    try {
      const result = await action();
      await this.commit(changes);
      return result;
    } catch (error) {
      this.config = previousConfig;
      try {
        for (const [path, contents] of backups) {
          if (contents === undefined) await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
          else await writeSecret(path, contents);
        }
      } finally {
        for (const name of changes.keys()) {
          if (environment[name] === undefined) delete process.env[name];
          else process.env[name] = environment[name];
        }
      }
      throw error;
    } finally { this.pending = undefined; this.authBackups = undefined; }
  }

  async profile(profile: StudyProfile): Promise<void> { this.config.profile = profile; await this.save(); }

  async calendars(timetable: CalendarSelection, agent: CalendarSelection): Promise<void> {
    const selected = [timetable.provider, agent.provider];
    const settings = calendarSettings({
      features: { googleCalendar: selected.includes('google'), icloudCalendar: selected.includes('icloud'), yandexCalendar: selected.includes('yandex') },
      calendars: { timetable, agent },
    });
    Object.assign(this.config, settings);
    delete this.config.timetableId;
    delete this.config.agentCalendarId;
    await this.save();
  }

  private async commit(changes: Map<string, string>): Promise<void> {
    const validated = normalizeSetupConfig(this.config);
    if (await optionalFile(this.configPath) !== this.version) {
      throw new SetupIssue('Настройки изменились в другом окне. Перезапусти CLI, чтобы загрузить актуальные данные');
    }
    const originalEnv = await optionalFile(this.envPath);
    let updatedEnv = originalEnv ?? '';
    for (const [name, value] of changes) updatedEnv = upsertEnv(updatedEnv, name, value);
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.envPath), { recursive: true, mode: 0o700 });
    if (changes.size) await writeSecret(this.envPath, updatedEnv);
    const nextVersion = JSON.stringify(validated, null, 2) + '\n';
    try { await writeSecret(this.configPath, nextVersion); }
    catch (error) {
      if (changes.size) {
        if (originalEnv === undefined) await unlink(this.envPath);
        else await writeSecret(this.envPath, originalEnv);
      }
      throw error;
    }
    this.config = validated;
    this.version = nextVersion;
  }
}

import ICAL from 'ical.js';
import ical, { type VEvent, type DateWithTimeZone } from 'node-ical';
import { TZ, deadline, validateTask, type Task } from '../domain.js';
import { OperationError } from '../operations.js';
import type { CalendarEvent } from './collection.js';
type Component = InstanceType<typeof ICAL.Component>;
function parsedComponent(value: unknown): Component {
  if (typeof value !== 'string' && !Array.isArray(value)) {
    throw new Error('Invalid iCalendar component');
  }
  return new ICAL.Component(value as string | unknown[]);
}
export type ResourceId = { url: string; recurrenceId?: string };
const encodeId = (id: ResourceId) => `ics.${Buffer.from(JSON.stringify(id)).toString('base64url')}`;
function string(value: unknown): string {
  return typeof value === 'object' && value && 'val' in value
    ? String(value.val)
    : String(value ?? '');
}
function stamp(date: DateWithTimeZone, allDay = false): string {
  return allDay
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: date.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date)
    : date.toISOString();
}

function normalized(root: Component): Component {
  const copy = parsedComponent(structuredClone(root.toJSON()));
  for (const event of copy.getAllSubcomponents('vevent')) {
    for (const name of ['dtstart', 'dtend', 'recurrence-id', 'exdate', 'rdate']) {
      for (const property of event.getAllProperties(name)) {
        const time = property.getFirstValue();
        if (
          time instanceof ICAL.Time &&
          !time.isDate &&
          time.zone.tzid === 'floating' &&
          !property.getParameter('tzid')
        ) {
          property.setParameter('tzid', TZ);
        }
      }
    }
  }
  return copy;
}
function parsed(root: Component): VEvent {
  const events = Object.values(ical.sync.parseICS(normalized(root).toString())).filter(
    (e): e is VEvent => e?.type === 'VEVENT',
  );
  if (events.length !== 1) {
    throw new Error('CalDAV resource должен содержать одно семейство VEVENT с одним UID');
  }
  return events[0]!;
}
function fromEvent(
  base: VEvent,
  id: ResourceId,
  component: Component,
  start = base.start,
  end = base.end ?? base.start,
): CalendarEvent {
  const meta = component.getFirstPropertyValue('x-hse-study-task');
  const allDay = base.datetype === 'date';
  return {
    id: encodeId(id),
    title: string(base.summary) || 'Занятие',
    description: string(base.description),
    start: stamp(start, allDay),
    end: stamp(end, allDay),
    allDay,
    status: base.status === 'CANCELLED' ? 'cancelled' : 'confirmed',
    recurrence: base.rrule?.toString(),
    ...(meta
      ? {
          task: validateTask(
            JSON.parse(Buffer.from(String(meta), 'base64').toString('utf8')) as Task,
          ),
        }
      : {}),
  };
}
function rootOf(data: unknown): Component {
  if (typeof data !== 'string' || !data.trim()) {
    throw new Error('CalDAV не вернул содержимое события');
  }
  if (Buffer.byteLength(data) > 2 * 1024 * 1024) {
    throw new OperationError('payload-limit', 'Событие CalDAV превышает 2 MiB');
  }
  const root = parsedComponent(ICAL.parse(data));
  if (root.name !== 'vcalendar') {
    throw new Error('CalDAV вернул некорректный iCalendar');
  }
  return root;
}
function masterOf(root: Component): Component {
  const masters = root.getAllSubcomponents('vevent').filter((e) => !e.hasProperty('recurrence-id'));
  if (masters.length !== 1) {
    throw new Error('Не найдено однозначное основное событие');
  }
  return masters[0]!;
}
function recurrenceInstant(root: Component, event: Component): string | undefined {
  const only = parsedComponent(structuredClone(root.toJSON()));
  only.removeAllSubcomponents('vevent');
  only.addSubcomponent(parsedComponent(structuredClone(event.toJSON())));
  const eventData = parsed(only),
    value = eventData.recurrenceid;
  return value
    ? stamp(
        value,
        event.getFirstPropertyValue('recurrence-id') instanceof ICAL.Time &&
          (event.getFirstPropertyValue('recurrence-id') as ICAL.Time).isDate,
      )
    : undefined;
}
function dates(component: Component, start: string, end: string, allDay = false): void {
  component.removeAllProperties('dtstart');
  component.removeAllProperties('dtend');
  component.removeAllProperties('duration');
  if (allDay && (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))) {
    throw new Error('Для allDay нужны даты YYYY-MM-DD');
  }
  component.addPropertyWithValue(
    'dtstart',
    allDay ? ICAL.Time.fromDateString(start) : ICAL.Time.fromJSDate(new Date(start), true),
  );
  component.addPropertyWithValue(
    'dtend',
    allDay ? ICAL.Time.fromDateString(end) : ICAL.Time.fromJSDate(new Date(end), true),
  );
  component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(Date.now()), true));
  component.updatePropertyWithValue(
    'last-modified',
    ICAL.Time.fromJSDate(new Date(Date.now()), true),
  );
  component.updatePropertyWithValue(
    'sequence',
    Number(component.getFirstPropertyValue('sequence') ?? 0) + 1,
  );
}
function serialize(event: CalendarEvent): string {
  if (!event.start || !event.end) {
    throw new Error('Для события нужны start/end');
  }
  const root = new ICAL.Component('vcalendar');
  root.updatePropertyWithValue('version', '2.0');
  root.updatePropertyWithValue('prodid', '-//HSE Study Assistant//EN');
  const e = new ICAL.Component('vevent');
  root.addSubcomponent(e);
  e.updatePropertyWithValue('uid', `${event.id}@hse-study-assistant`);
  e.updatePropertyWithValue('summary', event.title);
  e.updatePropertyWithValue('description', event.description ?? '');
  e.updatePropertyWithValue('status', event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED');
  dates(e, event.start, event.end, event.allDay);
  if (event.task) {
    e.updatePropertyWithValue(
      'x-hse-study-task',
      Buffer.from(JSON.stringify(event.task)).toString('base64'),
    );
  }
  return root.toString();
}

export interface CalendarComputeJob {
  type: 'calendar';
  action: 'list' | 'range' | 'get' | 'serialize' | 'move';
  data?: string;
  url?: string;
  id?: ResourceId;
  from?: string;
  to?: string;
  event?: CalendarEvent;
  start?: string;
  end?: string;
}
function getEvent(data: string, target: ResourceId): CalendarEvent {
  const root = rootOf(data),
    base = parsed(root),
    component = masterOf(root);
  if (!target.recurrenceId) {
    return fromEvent(base, target, component);
  }
  const override = Object.values(base.recurrences ?? {}).find(
    (e) =>
      e.recurrenceid &&
      stamp(e.recurrenceid as DateWithTimeZone, base.datetype === 'date') === target.recurrenceId,
  );
  if (override) {
    return fromEvent(override as VEvent, target, component);
  }
  const at = Date.parse(deadline(target.recurrenceId).value),
    allDay = base.datetype === 'date';
  const instance = ical
    .expandRecurringEvent(base, {
      from: new Date(at - (allDay ? 86400_000 : 0)),
      to: new Date(at + (allDay ? 86400_000 : 1000)),
    })
    .find((e) => (allDay ? stamp(e.start, true) === target.recurrenceId : +e.start === at));
  if (!instance) {
    throw new Error('CalDAV: экземпляр занятия больше не существует');
  }
  return fromEvent(instance.event, target, component, instance.start, instance.end);
}
export function calendarCompute(job: CalendarComputeJob): CalendarEvent | CalendarEvent[] | string {
  if (job.action === 'serialize') {
    return serialize(job.event!);
  }
  if (job.action === 'get') {
    return getEvent(job.data!, job.id!);
  }
  if (job.action === 'move') {
    const target = job.id!;
    const root = rootOf(job.data),
      master = masterOf(root);
    let component = master;
    if (target.recurrenceId) {
      getEvent(job.data!, target);
      const override = root
        .getAllSubcomponents('vevent')
        .find(
          (e) =>
            e.hasProperty('recurrence-id') && recurrenceInstant(root, e) === target.recurrenceId,
        );
      if (override) {
        if (override.getFirstProperty('recurrence-id')?.getParameter('range')) {
          throw new Error('Перенос RANGE-серии требует отдельного согласования');
        }
        component = override;
      } else {
        component = parsedComponent(structuredClone(master.toJSON()));
        for (const name of ['rrule', 'rdate', 'exdate', 'recurrence-id']) {
          component.removeAllProperties(name);
        }
        component.addPropertyWithValue(
          'recurrence-id',
          /^\d{4}-\d{2}-\d{2}$/.test(target.recurrenceId)
            ? ICAL.Time.fromDateString(target.recurrenceId)
            : ICAL.Time.fromJSDate(new Date(target.recurrenceId), true),
        );
        root.addSubcomponent(component);
      }
    } else if (master.hasProperty('rrule') || master.hasProperty('rdate')) {
      throw new Error(
        'Выберите конкретный экземпляр занятия через get_schedule; перенос всей серии не согласован',
      );
    }
    dates(component, job.start!, job.end!);
    return root.toString();
  }
  const root = rootOf(job.data);
  if (!root.getAllSubcomponents('vevent').length) {
    return [];
  }
  const base = parsed(root),
    component = masterOf(root);
  if (job.action === 'list') {
    return [fromEvent(base, { url: job.url! }, component)];
  }
  const out: CalendarEvent[] = [];
  for (const instance of ical.expandRecurringEvent(base, {
    from: new Date(job.from!),
    to: new Date(+new Date(job.to!) - 1),
    expandOngoing: true,
  })) {
    if (instance.event.status === 'CANCELLED') {
      continue;
    }
    if (out.length >= 20_000) {
      throw new OperationError('payload-limit', 'Слишком много экземпляров календаря');
    }
    const recurrenceId =
      base.rrule || base.rdate
        ? stamp(instance.event.recurrenceid ?? instance.start, base.datetype === 'date')
        : undefined;
    out.push(
      fromEvent(
        instance.event,
        { url: job.url!, recurrenceId },
        component,
        instance.start,
        instance.end,
      ),
    );
  }
  return out;
}

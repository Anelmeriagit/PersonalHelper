// Часовые пояса (этап 5, «Часовые пояса», часть 1). Пояс аккаунта — название IANA ('Europe/Berlin'), не смещение: летнее время считает Intl.
// Нет поля tz у аккаунта = DEFAULT_TZ (Москва): прежние аккаунты не меняются. Время слотов и дат везде «по настенным часам» пояса владельца записи.
// Здесь только чистые функции без Redis. Парный файл сайта — js/tz.js (часть 4): менять только вместе.
export const DEFAULT_TZ = 'Europe/Moscow';
export const WEST_TZ = 'Etc/GMT+12'; // самый западный пояс (UTC−12): конец его суток — верхняя граница «все сутки этой даты где бы то ни было» (ручной запуск cron)
const MOSCOW_MS = 3 * 3600e3; // Москва: UTC+3 круглый год (без перехода на летнее время), быстрый путь без Intl

// Формат с запасом по полям; DateTimeFormat дорого создавать, поэтому по одному на пояс.
const fmts = new Map();
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    fmts.set(tz, f);
  }
  return f;
}

// Название пояса → каноническое название или null. Принимаются только названия вида «Область/Город» (и 'UTC'); смещения вроде '+03:00' нет.
export function cleanTz(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length > 64) return null;
  if (s !== 'UTC' && !/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(s)) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone; } catch { return null; }
}

// Пояс аккаунта (запись getAcc) или DEFAULT_TZ.
export function tzOf(acc) {
  return acc && typeof acc.tz === 'string' && cleanTz(acc.tz) ? cleanTz(acc.tz) : DEFAULT_TZ;
}

// → { month:'YYYY-MM', date:'YYYY-MM-DD', hour, minute } — настенное время пояса. Время берётся через Date.now(), чтобы тесты могли его подменять.
export function nowIn(tz = DEFAULT_TZ, d = new Date(Date.now())) {
  const parts = fmt(tz).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  const month = g('year') + '-' + g('month');
  return { month, date: month + '-' + g('day'), hour: parseInt(g('hour'), 10), minute: parseInt(g('minute'), 10) };
}

// Смещение пояса от UTC в мс на момент ms (восток — плюс).
export function offsetAt(ms, tz = DEFAULT_TZ) {
  if (tz === DEFAULT_TZ) return MOSCOW_MS;
  const p = fmt(tz).formatToParts(new Date(ms));
  const g = (t) => parseInt(p.find((x) => x.type === t).value, 10);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
}

// Момент (мс, UTC), когда настенные часы пояса показывают date ('YYYY-MM-DD') и minutes минут от полуночи (0…1440). Два шага, чтобы попасть
// на правильную сторону перехода на летнее время; слоты (07:00…23:30) переходов не задевают. В «пропавший» час перехода даёт ближайший существующий момент.
export function zonedToMs(date, minutes, tz = DEFAULT_TZ) {
  const wall = Date.parse(date + 'T00:00:00Z') + minutes * 60000;
  if (tz === DEFAULT_TZ) return wall - MOSCOW_MS;
  const first = wall - offsetAt(wall, tz);
  return wall - offsetAt(first, tz);
}

// Последняя миллисекунда суток date по настенным часам пояса.
export const dayEndIn = (date, tz = DEFAULT_TZ) => zonedToMs(date, 1440, tz) - 1;

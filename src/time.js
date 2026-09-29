'use strict';
// "Today" and "revenue by hour" must follow the restaurant's clock, not the server's:
// Vercel runs in UTC. Set RESTAURANT_TZ to any IANA zone; the default is India.

const DEFAULT_TZ = process.env.RESTAURANT_TZ || 'Asia/Kolkata';

const formatters = new Map();
function partsIn(tz, instant) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

// Milliseconds to add to a UTC instant to get the wall-clock time in tz.
function offsetMs(tz, instant) {
  const p = partsIn(tz, instant);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(instant / 1000) * 1000;
}

// UTC instant of local midnight for the calendar date y-m-d in tz (DST-safe).
function midnight(tz, y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(tz, guess);
  return guess - offsetMs(tz, first);
}

const pad = (n) => String(n).padStart(2, '0');

// { start, end, date, offset } for a 'YYYY-MM-DD' (or today), where [start, end)
// are UTC ms bounds of that local day and offset is the tz offset during it.
function dayRange(tz, dateStr, now) {
  let y, m, d;
  if (dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) return null;
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    ({ y, m, d } = partsIn(tz, now));
  }
  const start = midnight(tz, y, m, d);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = midnight(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { start, end, date: `${y}-${pad(m)}-${pad(d)}`, offset: offsetMs(tz, start + 12 * 3600000) };
}

module.exports = { DEFAULT_TZ, dayRange, offsetMs };

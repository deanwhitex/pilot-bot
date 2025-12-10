// calendar.js
import { google } from "googleapis";

const TIMEZONE = process.env.TZ || "Africa/Johannesburg";

// ----------------------------------------------------------
// CALENDAR IDS – read from Render env:
//   GOOGLE_CALENDAR_1, GOOGLE_CALENDAR_2, GOOGLE_CALENDAR_3
// ----------------------------------------------------------
const CALENDARS = [
  process.env.GOOGLE_CALENDAR_1,
  process.env.GOOGLE_CALENDAR_2,
  process.env.GOOGLE_CALENDAR_3,
].filter(Boolean);

if (CALENDARS.length === 0) {
  console.warn(
    "⚠️ No GOOGLE_CALENDAR_1/2/3 set – calendar functions will return empty."
  );
}

// ----------------------------------------------------------
// GOOGLE AUTH
// ----------------------------------------------------------
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const gcal = google.calendar({ version: "v3", auth });

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------
function normalizeDate(input) {
  if (input instanceof Date) return input;
  if (!input) return new Date();
  const d = new Date(input);
  return isNaN(d.getTime()) ? new Date() : d;
}

function startOfDay(input) {
  const d = normalizeDate(input);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(input) {
  const d = normalizeDate(input);
  d.setHours(23, 59, 59, 999);
  return d;
}

function stripLinks(text = "") {
  return text.replace(/https?:\/\/\S+/g, "").trim();
}

function attachCalendar(ev, calendarId) {
  return {
    ...ev,
    calendarId,
    summary: stripLinks(ev.summary || ""),
    description: stripLinks(ev.description || ""),
  };
}

// ----------------------------------------------------------
// CORE QUERIES
// ----------------------------------------------------------
export async function getEventsForDate(dateLike) {
  const start = startOfDay(dateLike);
  const end = endOfDay(dateLike);
  return getEventsForRange(start, end);
}

export async function getEventsForRange(startLike, endLike) {
  if (CALENDARS.length === 0) return [];

  const timeMin = normalizeDate(startLike).toISOString();
  const timeMax = normalizeDate(endLike).toISOString();

  const allEvents = [];

  for (const calId of CALENDARS) {
    try {
      const res = await gcal.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
      });

      const items = res.data.items || [];
      for (const ev of items) {
        allEvents.push(attachCalendar(ev, calId));
      }
    } catch (err) {
      console.error(`Calendar list error for ${calId}:`, err.message || err);
    }
  }

  // Sort after merging so you see a single chronological list
  allEvents.sort(
    (a, b) =>
      new Date(a.start.dateTime || a.start.date) -
      new Date(b.start.dateTime || b.start.date)
  );

  return allEvents;
}

// ----------------------------------------------------------
// FIND OPEN SLOTS (08:00–22:00)
// ----------------------------------------------------------
const MIN_HOUR = 8;
const MAX_HOUR = 22;

export async function findOpenSlots(dateLike, durationMin = 60, limit = 100) {
  const date = normalizeDate(dateLike);
  const events = await getEventsForDate(date);

  const dayStart = new Date(date);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  const free = [];
  let cursor = dayStart;

  for (const ev of events) {
    const evStart = new Date(ev.start.dateTime || ev.start.date);

    if (evStart - cursor >= durationMin * 60000) {
      free.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + durationMin * 60000),
      });
    }

    const evEnd = new Date(ev.end.dateTime || ev.end.date);
    if (evEnd > cursor) cursor = evEnd;
  }

  if (dayEnd - cursor >= durationMin * 60000) {
    free.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + durationMin * 60000),
    });
  }

  return free.slice(0, limit);
}

// ----------------------------------------------------------
// CREATE EVENT (always on primary calendar)
// ----------------------------------------------------------
export async function createEvent({ title, start, end }) {
  const calId = CALENDARS[0] || "primary";

  const body = {
    summary: title,
    start: {
      dateTime: normalizeDate(start).toISOString(),
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: normalizeDate(end).toISOString(),
      timeZone: TIMEZONE,
    },
  };

  const res = await gcal.events.insert({
    calendarId: calId,
    requestBody: body,
  });

  return attachCalendar(res.data, calId);
}

// ----------------------------------------------------------
// SEARCH / CANCEL / RESCHEDULE
// ----------------------------------------------------------
export async function searchEventsByText(query) {
  if (CALENDARS.length === 0) return [];
  if (!query) return [];

  // Look from 30 days ago to 1 year ahead
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const results = [];

  for (const calId of CALENDARS) {
    try {
      const res = await gcal.events.list({
        calendarId: calId,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        q: query,
      });

      const items = res.data.items || [];
      for (const ev of items) {
        results.push(attachCalendar(ev, calId));
      }
    } catch (err) {
      console.error(`Search error for ${calId}:`, err.message || err);
    }
  }

  return results;
}

export async function cancelEventById(calendarId, eventId) {
  try {
    await gcal.events.delete({
      calendarId,
      eventId,
    });
  } catch (err) {
    console.error(`Cancel error for ${calendarId}/${eventId}:`, err.message || err);
    throw err;
  }
}

export async function rescheduleEventById(calendarId, eventId, newStart, newEnd) {
  try {
    const res = await gcal.events.patch({
      calendarId,
      eventId,
      requestBody: {
        start: {
          dateTime: normalizeDate(newStart).toISOString(),
          timeZone: TIMEZONE,
        },
        end: {
          dateTime: normalizeDate(newEnd).toISOString(),
          timeZone: TIMEZONE,
        },
      },
    });

    return attachCalendar(res.data, calendarId);
  } catch (err) {
    console.error(
      `Reschedule error for ${calendarId}/${eventId}:`,
      err.message || err
    );
    throw err;
  }
}




// calendar.js – Google Calendar helper layer for Pilot

import { google } from "googleapis";

const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;

// ----------------------------------------------------------
// CALENDAR IDS (from env)
// ----------------------------------------------------------
const CALENDARS = [
  process.env.CALENDAR_1,
  process.env.CALENDAR_2,
  process.env.CALENDAR_3,
].filter(Boolean);

if (CALENDARS.length === 0) {
  console.warn("⚠️ No CALENDAR_1/2/3 set – calendar functions will return empty.");
}

// ----------------------------------------------------------
// GOOGLE AUTH – SERVICE ACCOUNT
// ----------------------------------------------------------
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  // handle "\n" in env key
  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

// ----------------------------------------------------------
// UTILS
// ----------------------------------------------------------
function sanitizeEvent(ev, calendarId) {
  const stripLinks = (txt) =>
    txt ? txt.replace(/https?:\/\/\S+/g, "").trim() : "";

  return {
    ...ev,
    calendarId,
    summary: stripLinks(ev.summary || ""),
    description: stripLinks(ev.description || ""),
  };
}

function sortEventsByStart(a, b) {
  return new Date(a.start.dateTime || a.start.date) -
    new Date(b.start.dateTime || b.start.date);
}

// ----------------------------------------------------------
// GET ALL EVENTS FOR A SINGLE DAY (merged across calendars)
// ----------------------------------------------------------
export async function getEventsForDate(date) {
  const d = date instanceof Date ? new Date(date) : new Date(date);

  const start = new Date(d);
  start.setHours(0, 0, 0, 0);

  const end = new Date(d);
  end.setHours(23, 59, 59, 999);

  return await getEventsForRange(start, end);
}

// ----------------------------------------------------------
// GET EVENTS IN RANGE (merged across calendars)
// ----------------------------------------------------------
export async function getEventsForRange(start, end) {
  if (!CALENDARS.length) return [];

  const timeMin = (start instanceof Date ? start : new Date(start)).toISOString();
  const timeMax = (end instanceof Date ? end : new Date(end)).toISOString();

  let allEvents = [];

  for (const calId of CALENDARS) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
      });

      const items = res.data.items || [];
      const cleaned = items.map((e) => sanitizeEvent(e, calId));
      allEvents.push(...cleaned);
    } catch (err) {
      console.error(`Error fetching events from ${calId}:`, err.message);
    }
  }

  allEvents.sort(sortEventsByStart);
  return allEvents;
}

// ----------------------------------------------------------
// FIND FREE SLOTS BETWEEN 08:00–22:00
// ----------------------------------------------------------
export async function findOpenSlots(date, durationMin, limit = 100) {
  const d = date instanceof Date ? new Date(date) : new Date(date);

  const events = await getEventsForDate(d);
  const durationMs = durationMin * 60 * 1000;

  const dayStart = new Date(d);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(d);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  const free = [];
  let cursor = dayStart;

  for (const ev of events) {
    const evStart = new Date(ev.start.dateTime || ev.start.date);
    const evEnd = new Date(ev.end.dateTime || ev.end.date);

    // skip all-day events (no dateTime)
    if (!ev.start.dateTime && ev.start.date) continue;

    if (evStart - cursor >= durationMs) {
      free.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + durationMs),
      });
    }

    if (evEnd > cursor) cursor = evEnd;
  }

  // tail of day
  if (dayEnd - cursor >= durationMs) {
    free.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + durationMs),
    });
  }

  return free.slice(0, limit);
}

// ----------------------------------------------------------
// CREATE EVENT (always on primary calendar)
// ----------------------------------------------------------
export async function createEvent({ title, start, end }) {
  const primary = CALENDARS[0];
  if (!primary) throw new Error("No CALENDAR_1 configured.");

  const startDate = start instanceof Date ? start : new Date(start);
  const endDate = end instanceof Date ? end : new Date(end);

  const res = await calendar.events.insert({
    calendarId: primary,
    requestBody: {
      summary: title,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: TIMEZONE,
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: TIMEZONE,
      },
    },
  });

  return sanitizeEvent(res.data, primary);
}

// ----------------------------------------------------------
// CANCEL EVENT BY ID
// ----------------------------------------------------------
export async function cancelEventById(calendarId, eventId) {
  if (!calendarId || !eventId) throw new Error("calendarId and eventId required");
  await calendar.events.delete({
    calendarId,
    eventId,
  });
}

// ----------------------------------------------------------
// RESCHEDULE EVENT BY ID
// ----------------------------------------------------------
export async function rescheduleEventById(calendarId, eventId, newStart, newEnd) {
  if (!calendarId || !eventId) throw new Error("calendarId and eventId required");

  const startDate = newStart instanceof Date ? newStart : new Date(newStart);
  const endDate = newEnd instanceof Date ? newEnd : new Date(newEnd);

  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: {
        dateTime: startDate.toISOString(),
        timeZone: TIMEZONE,
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: TIMEZONE,
      },
    },
  });
}

// ----------------------------------------------------------
// SEARCH EVENTS BY TEXT (next 30 days across all calendars)
// ----------------------------------------------------------
export async function searchEventsByText(text) {
  if (!text) return [];
  if (!CALENDARS.length) return [];

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);

  const events = await getEventsForRange(now, end);
  const q = text.toLowerCase();

  return events.filter((ev) => {
    const s = (ev.summary || "").toLowerCase();
    const d = (ev.description || "").toLowerCase();
    return s.includes(q) || d.includes(q);
  });
}




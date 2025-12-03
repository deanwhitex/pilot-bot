// calendar.js
import { google } from "googleapis";

const TIMEZONE = "Africa/Johannesburg";   // unified timezone
const MIN_HOUR = 8;
const MAX_HOUR = 22;

const CALENDARS = [
  "dean@kingcontractor.com",
  "deanfwhite@gmail.com",
  "dean@deanxwhite.com",
];

// Google Auth – service account
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

/* ----------------------------------------------------------
   NORMALIZE GOOGLE EVENT OBJECT
   - Handles date vs dateTime
   - Strips links
---------------------------------------------------------- */
function normalizeEvent(ev) {
  // Strip links safely
  const clean = (txt) =>
    txt ? txt.replace(/https?:\/\/\S+/g, "") : "";

  // Convert all-day events to usable dateTime
  let start = ev.start.dateTime || ev.start.date;
  let end   = ev.end.dateTime || ev.end.date;

  // Convert date-only → add time component
  if (ev.start.date && !ev.start.dateTime) {
    start = `${ev.start.date}T00:00:00`;
  }
  if (ev.end.date && !ev.end.dateTime) {
    end = `${ev.end.date}T23:59:59`;
  }

  return {
    ...ev,
    summary: clean(ev.summary),
    description: clean(ev.description),
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

/* ----------------------------------------------------------
   GET EVENTS FOR A SPECIFIC DAY
---------------------------------------------------------- */
export async function getEventsForDate(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return await getEventsForRange(start, end);
}

/* ----------------------------------------------------------
   MERGED EVENTS FROM ALL CALENDARS
---------------------------------------------------------- */
export async function getEventsForRange(start, end) {
  let events = [];

  for (const id of CALENDARS) {
    try {
      const res = await calendar.events.list({
        calendarId: id,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      if (res.data.items) {
        events.push(...res.data.items.map(normalizeEvent));
      }
    } catch (err) {
      console.error(`Calendar fetch error for ${id}`, err);
    }
  }

  // Sort merged list
  events.sort(
    (a, b) =>
      new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );

  return events;
}

/* ----------------------------------------------------------
   FREE SLOT FINDER (08:00–22:00)
---------------------------------------------------------- */
export async function findOpenSlots(date, duration, limit = 100) {
  const events = await getEventsForDate(date);

  const dayStart = new Date(date);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  const results = [];
  let cursor = new Date(dayStart);

  for (const ev of events) {
    const evStart = new Date(ev.start.dateTime);
    const evEnd = new Date(ev.end.dateTime);

    if (evStart - cursor >= duration * 60000) {
      results.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + duration * 60000),
      });
    }

    if (evEnd > cursor) cursor = evEnd;
  }

  // After last event → end of day
  if (dayEnd - cursor >= duration * 60000) {
    results.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + duration * 60000),
    });
  }

  return results.slice(0, limit);
}

/* ----------------------------------------------------------
   CREATE EVENT (Always goes to main calendar)
---------------------------------------------------------- */
export async function createEvent({ title, start, end }) {
  try {
    const res = await calendar.events.insert({
      calendarId: CALENDARS[0],
      requestBody: {
        summary: title,
        start: {
          dateTime: start.toISOString(),
          timeZone: TIMEZONE,
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: TIMEZONE,
        },
      },
    });

    return res.data;
  } catch (err) {
    console.error("Create event error:", err);
    return null;
  }
}



// calendar.js
import { google } from "googleapis";

const TIMEZONE = "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;

// Your three calendar IDs
const CALENDARS = [
  "dean@kingcontractor.com",
  "deanfwhite@gmail.com",
  "dean@deanxwhite.com"
];

// Google auth via service account
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

/* ----------------------------------------------------------
   GET ALL EVENTS FOR A SINGLE DAY
---------------------------------------------------------- */
export async function getEventsForDate(date) {
  const start = new Date(date);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return await getEventsForRange(start, end);
}

/* ----------------------------------------------------------
   GET EVENTS ACROSS ALL CALENDARS (MERGED)
---------------------------------------------------------- */
export async function getEventsForRange(start, end) {
  let events = [];

  for (const calId of CALENDARS) {
    const res = await calendar.events.list({
      calendarId: calId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    if (res.data.items) {
      const cleaned = res.data.items.map((e) => sanitizeEvent(e));
      events.push(...cleaned);
    }
  }

  // Sort after merging across all calendars
  events.sort(
    (a, b) =>
      new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );

  return events;
}

/* ----------------------------------------------------------
   REMOVE LINKS / CLEANUP EVENT TEXT
---------------------------------------------------------- */
function sanitizeEvent(ev) {
  const cleanText = (text) =>
    text ? text.replace(/https?:\/\/\\S+/g, "") : "";

  return {
    ...ev,
    summary: cleanText(ev.summary),
    description: cleanText(ev.description),
  };
}

/* ----------------------------------------------------------
   FIND TOP FREE SLOTS BETWEEN 08:00 AND 22:00
---------------------------------------------------------- */
export async function findOpenSlots(date, duration, limit = 100) {
  const events = await getEventsForDate(date);

  const dayStart = new Date(date);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  const free = [];

  let cursor = dayStart;

  for (const ev of events) {
    const evStart = new Date(ev.start.dateTime);

    // If gap until event is big enough
    if (evStart - cursor >= duration * 60000) {
      free.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + duration * 60000),
      });
    }

    const evEnd = new Date(ev.end.dateTime);
    if (evEnd > cursor) cursor = evEnd;
  }

  // Check end of day gap
  if (dayEnd - cursor >= duration * 60000) {
    free.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + duration * 60000),
    });
  }

  return free.slice(0, limit);
}

/* ----------------------------------------------------------
   CREATE EVENT INTO PRIMARY CALENDAR
---------------------------------------------------------- */
export async function createEvent({ title, start, end }) {
  return await calendar.events.insert({
    calendarId: CALENDARS[0], // always add to main calendar
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
}


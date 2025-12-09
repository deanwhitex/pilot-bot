// calendar.js
import { google } from "googleapis";

const TIMEZONE = "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;

// Your three calendars
const CALENDARS = [
  "dean@kingcontractor.com",
  "deanfwhite@gmail.com",
  "dean@deanxwhite.com"
];

// Google Auth (Service Account)
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

/* ----------------------------------------------------------
   CLEAN EVENT TEXT
---------------------------------------------------------- */
function sanitizeEvent(ev) {
  const strip = (t) => (t ? t.replace(/https?:\/\/\\S+/g, "") : "");
  return {
    ...ev,
    summary: strip(ev.summary),
    description: strip(ev.description),
  };
}

/* ----------------------------------------------------------
   GET ALL EVENTS FOR A DATE
---------------------------------------------------------- */
export async function getEventsForDate(date) {
  const start = new Date(date);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return await getEventsForRange(start, end);
}

/* ----------------------------------------------------------
   GET MERGED EVENTS ACROSS ALL CALENDARS
---------------------------------------------------------- */
export async function getEventsForRange(start, end) {
  let merged = [];

  for (const calId of CALENDARS) {
    const res = await calendar.events.list({
      calendarId: calId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    if (res.data.items) {
      res.data.items.forEach((ev) => {
        merged.push({
          ...sanitizeEvent(ev),
          _calendarId: calId, // Track origin calendar
        });
      });
    }
  }

  // Sort chronologically
  merged.sort(
    (a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );

  return merged;
}

/* ----------------------------------------------------------
   EVENT SEARCH BY TEXT (for cancel/reschedule)
---------------------------------------------------------- */
export async function searchEventsByText(query) {
  const today = new Date();
  const future = new Date();
  future.setMonth(future.getMonth() + 3); // 90-day search window

  const all = await getEventsForRange(today, future);

  query = query.toLowerCase();

  return all.filter((ev) => {
    const summary = ev.summary?.toLowerCase() || "";
    const desc = ev.description?.toLowerCase() || "";
    return summary.includes(query) || desc.includes(query);
  });
}

/* ----------------------------------------------------------
   FIND FREE TIME BETWEEN 08:00–22:00
---------------------------------------------------------- */
export async function findOpenSlots(date, duration, limit = 100) {
  const events = await getEventsForDate(date);

  const dayStart = new Date(date);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  let free = [];
  let cursor = dayStart;

  for (const ev of events) {
    const evStart = new Date(ev.start.dateTime);
    const evEnd = new Date(ev.end.dateTime);

    // Check gap before event
    if (evStart - cursor >= duration * 60000) {
      free.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + duration * 60000),
      });
    }

    // Move cursor past this event
    if (evEnd > cursor) cursor = evEnd;
  }

  // Check gap at end of day
  if (dayEnd - cursor >= duration * 60000) {
    free.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + duration * 60000),
    });
  }

  return free.slice(0, limit);
}

/* ----------------------------------------------------------
   CREATE EVENT (with attendee notification)
---------------------------------------------------------- */
export async function createEvent({ title, start, end }) {
  return await calendar.events.insert({
    calendarId: CALENDARS[0], // always main calendar
    sendUpdates: "all",       // notify attendees
    requestBody: {
      summary: title,
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
    },
  });
}

/* ----------------------------------------------------------
   CANCEL EVENT COMPLETELY
---------------------------------------------------------- */
export async function cancelEventById(calendarId, eventId) {
  return await calendar.events.delete({
    calendarId,
    eventId,
    sendUpdates: "all", // notify attendees
  });
}

/* ----------------------------------------------------------
   RESCHEDULE EVENT (KEEP ATTENDEES)
---------------------------------------------------------- */
export async function rescheduleEventById(calendarId, eventId, newStart, newEnd) {
  return await calendar.events.patch({
    calendarId,
    eventId,
    sendUpdates: "all", // notify attendees
    requestBody: {
      start: { dateTime: newStart.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: newEnd.toISOString(), timeZone: TIMEZONE },
    },
  });
}



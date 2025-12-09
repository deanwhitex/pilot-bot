// -----------------------------------------------------------------------------
// calendar.js  —  Google Calendar engine for Pilot 
// -----------------------------------------------------------------------------

import { google } from "googleapis";



// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const TIMEZONE = "Africa/Johannesburg";

const MIN_HOUR = 8;
const MAX_HOUR = 22;



// -----------------------------------------------------------------------------
// CALENDAR IDS  (All events READ from all 3 calendars)
// New events ALWAYS created in FIRST calendar.
// -----------------------------------------------------------------------------

export const CALENDARS = [
  "dean@kingcontractor.com",     // primary (write)
  "deanfwhite@gmail.com",        // read-only
  "dean@deanxwhite.com"          // read-only
];



// -----------------------------------------------------------------------------
// GOOGLE AUTH  (Service Account)
// -----------------------------------------------------------------------------

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({
  version: "v3",
  auth
});



// -----------------------------------------------------------------------------
// CLEAN EVENT TEXT — Remove URLs to prevent Discord previews
// -----------------------------------------------------------------------------

function cleanText(text) {
  if (!text) return "";
  return text.replace(/https?:\/\/\S+/g, "").trim();
}



// -----------------------------------------------------------------------------
// NORMALIZE EVENT OBJECT
// Ensures every returned event has:
// - summary
// - description
// - start.dateTime
// - end.dateTime
// - calendarId
// -----------------------------------------------------------------------------

function normalizeEvent(ev, calendarId) {
  if (!ev.start) ev.start = {};
  if (!ev.end) ev.end = {};

  return {
    id: ev.id,
    calendarId,
    summary: cleanText(ev.summary || "Untitled Event"),
    description: cleanText(ev.description || ""),
    location: ev.location || "",
    start: {
      dateTime: ev.start.dateTime || ev.start.date || null
    },
    end: {
      dateTime: ev.end.dateTime || ev.end.date || null
    }
  };
}



// -----------------------------------------------------------------------------
// GET EVENTS FOR A SINGLE DAY
// -----------------------------------------------------------------------------

export async function getEventsForDate(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return await getEventsForRange(start, end);
}



// -----------------------------------------------------------------------------
// GET EVENTS ACROSS ALL CALENDARS (merged + sorted)
// -----------------------------------------------------------------------------

export async function getEventsForRange(start, end) {
  let events = [];

  for (const calId of CALENDARS) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime"
      });

      const items = res.data.items || [];

      items.forEach((ev) => {
        events.push(normalizeEvent(ev, calId));
      });

    } catch (err) {
      console.error(`Calendar fetch error for ${calId}:`, err.message);
    }
  }

  // Sort events by actual start time
  events.sort((a, b) =>
    new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );

  return events;
}



// -----------------------------------------------------------------------------
// TEXT SEARCH  (Used for cancel / reschedule)
// -----------------------------------------------------------------------------

export async function searchEventsByText(query) {
  const start = new Date();
  start.setMonth(start.getMonth() - 1);    // search 1 month backward

  const end = new Date();
  end.setMonth(end.getMonth() + 3);        // search 3 months forward

  const events = await getEventsForRange(start, end);

  const text = query.toLowerCase();

  return events.filter((ev) =>
    ev.summary.toLowerCase().includes(text) ||
    ev.description.toLowerCase().includes(text)
  );
}



// -----------------------------------------------------------------------------
// CREATE EVENT  (PRIMARY calendar ONLY)
// -----------------------------------------------------------------------------

export async function createEvent({ title, start, end }) {
  try {
    const res = await calendar.events.insert({
      calendarId: CALENDARS[0],   // always kingcontractor.com
      requestBody: {
        summary: title,
        start: {
          dateTime: start.toISOString(),
          timeZone: TIMEZONE
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: TIMEZONE
        }
      }
    });

    return res.data;

  } catch (err) {
    console.error("Create event error:", err);
    throw err;
  }
}



// -----------------------------------------------------------------------------
// CANCEL EVENT BY ID
// -----------------------------------------------------------------------------

export async function cancelEventById(calendarId, eventId) {
  try {
    await calendar.events.delete({
      calendarId,
      eventId
    });

    return true;
  } catch (err) {
    console.error("Cancel event error:", err);
    return false;
  }
}



// -----------------------------------------------------------------------------
// RESCHEDULE EVENT BY ID
// -----------------------------------------------------------------------------

export async function rescheduleEventById(calendarId, eventId, newStart, newEnd) {
  try {
    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        start: {
          dateTime: newStart.toISOString(),
          timeZone: TIMEZONE
        },
        end: {
          dateTime: newEnd.toISOString(),
          timeZone: TIMEZONE
        }
      }
    });

    return true;

  } catch (err) {
    console.error("Reschedule error:", err);
    return false;
  }
}



// -----------------------------------------------------------------------------
// FREE SLOT FINDER (human-logic hours)
// -----------------------------------------------------------------------------

export async function findOpenSlots(date, durationMin = 60, limit = 100) {
  const events = await getEventsForDate(date);

  const durationMs = durationMin * 60 * 1000;

  const dayStart = new Date(date);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  const free = [];

  let cursor = new Date(dayStart);



  // ---------------------------------------------
  // Walk through events chronologically
  // ---------------------------------------------
  for (const ev of events) {
    const evStart = new Date(ev.start.dateTime);
    const evEnd = new Date(ev.end.dateTime);

    // Gap before event?
    if (evStart - cursor >= durationMs) {
      free.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + durationMs)
      });
    }

    // Move cursor forward
    if (evEnd > cursor) {
      cursor = new Date(evEnd);
    }
  }



  // ---------------------------------------------
  // Gap after last event?
  // ---------------------------------------------
  if (dayEnd - cursor >= durationMs) {
    free.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + durationMs)
    });
  }



  return free.slice(0, limit);
}



// -----------------------------------------------------------------------------
// END — calendar.js
// -----------------------------------------------------------------------------



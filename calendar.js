// calendar.js
import { google } from "googleapis";

const TIMEZONE = "Africa/Johannesburg";

// Your 3 calendar IDs
export const CALENDARS = [
  "dean@kingcontractor.com",
  "deanfwhite@gmail.com",
  "dean@deanxwhite.com",
];

// Google Authentication (Service Account)
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

/* ----------------------------------------------------------
   CLEAN EVENT TEXT (remove URLs)
---------------------------------------------------------- */
function clean(text) {
  return text ? text.replace(/https?:\/\/\S+/g, "") : "";
}

/* ----------------------------------------------------------
   GET EVENTS FOR A SINGLE DAY
---------------------------------------------------------- */
export async function getEventsForDate(date) {
  const start = new Date(date);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return await getEventsForRange(start, end);
}

/* ----------------------------------------------------------
   GET EVENTS ACROSS ALL 3 CALENDARS (MERGED)
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

    if (!res.data.items) continue;

    const cleaned = res.data.items.map(ev => ({
      ...ev,
      calendarId: calId,
      summary: clean(ev.summary),
      description: clean(ev.description),
    }));

    merged.push(...cleaned);
  }

  merged.sort(
    (a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );

  return merged;
}

/* ----------------------------------------------------------
   SEARCH EVENTS BY TEXT (for cancel / reschedule)
---------------------------------------------------------- */
export async function searchEventsByText(query) {
  const today = new Date();
  const nextYear = new Date();
  nextYear.setFullYear(today.getFullYear() + 1);

  const events = await getEventsForRange(today, nextYear);

  return events.filter(ev =>
    ev.summary.toLowerCase().includes(query.toLowerCase())
  );
}

/* ----------------------------------------------------------
   CANCEL EVENT
---------------------------------------------------------- */
export async function cancelEventById(calendarId, eventId) {
  return await calendar.events.delete({
    calendarId,
    eventId,
  });
}

/* ----------------------------------------------------------
   RESCHEDULE EVENT
---------------------------------------------------------- */
export async function rescheduleEventById(calendarId, eventId, newStart, newEnd) {
  return await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: { dateTime: newStart.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: newEnd.toISOString(), timeZone: TIMEZONE },
    },
  });
}

/* ----------------------------------------------------------
   CREATE EVENT (always into primary calendar)
---------------------------------------------------------- */
export async function createEvent({ title, start, end }) {
  return await calendar.events.insert({
    calendarId: CALENDARS[0],
    requestBody: {
      summary: title,
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
    },
  });
}




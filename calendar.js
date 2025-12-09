// calendar.js
import { google } from "googleapis";

const TIMEZONE = "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;

// All of Dean's calendars
export const CALENDARS = [
  "dean@kingcontractor.com",
  "deanfwhite@gmail.com",
  "dean@deanxwhite.com"
];

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

/* CLEAN EVENT TEXT */
function clean(text) {
  if (!text) return "";
  return text.replace(/https?:\/\/\\S+/g, "").trim();
}

function sanitizeEvent(ev, calId) {
  return {
    ...ev,
    calendarId: calId,
    summary: clean(ev.summary),
    description: clean(ev.description)
  };
}

/* MERGED RANGE PULL */
export async function getEventsForRange(start, end) {
  let all = [];

  for (const calId of CALENDARS) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 150
      });

      if (res.data.items) {
        all.push(
          ...res.data.items.map((e) => sanitizeEvent(e, calId))
        );
      }
    } catch (err) {
      console.error("Calendar pull error:", calId, err.message);
    }
  }

  return all.sort(
    (a, b) =>
      new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );
}

/* SINGLE DAY */
export async function getEventsForDate(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return await getEventsForRange(start, end);
}

/* FIND OPEN SLOTS */
export async function findOpenSlots(date, duration = 60, limit = 50) {
  const events = await getEventsForDate(date);

  const dayStart = new Date(date);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  const free = [];
  let cursor = new Date(dayStart);

  for (const ev of events) {
    const start = new Date(ev.start.dateTime);

    if (start - cursor >= duration * 60000) {
      free.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + duration * 60000)
      });
    }

    const end = new Date(ev.end.dateTime);
    if (end > cursor) cursor = end;
  }

  if (dayEnd - cursor >= duration * 60000) {
    free.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + duration * 60000)
    });
  }

  return free.slice(0, limit);
}

/* INSERT EVENT */
export async function createEvent({ title, start, end }) {
  return await calendar.events.insert({
    calendarId: CALENDARS[0],
    requestBody: {
      summary: clean(title),
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE }
    }
  });
}

/* CANCEL EVENT */
export async function cancelEventById(calendarId, eventId) {
  await calendar.events.delete({
    calendarId,
    eventId
  });
}

/* RESCHEDULE EVENT */
export async function rescheduleEventById(calendarId, eventId, newStart, newEnd) {
  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: { dateTime: newStart.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: newEnd.toISOString(), timeZone: TIMEZONE }
    }
  });
}

/* SEARCH EVENTS BY TEXT */
export async function searchEventsByText(text) {
  const start = new Date();
  const end = new Date();
  end.setMonth(end.getMonth() + 2);

  const all = await getEventsForRange(start, end);
  const needle = text.toLowerCase();

  return all.filter((ev) =>
    ev.summary?.toLowerCase().includes(needle)
  );
}



// calendar.js
import { google } from "googleapis";

/* ----------------------------------------------------------
   AUTHENTICATION
---------------------------------------------------------- */
function createCalendarClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  return google.calendar({ version: "v3", auth });
}

/* ----------------------------------------------------------
   CALENDAR LIST — all of Dean’s calendars
---------------------------------------------------------- */
const CALENDARS = [
  process.env.CALENDAR_1, // dean@kingcontractor.com
  process.env.CALENDAR_2, // deanfwhite@gmail.com
  process.env.CALENDAR_3, // dean@deanxwhite.com
];

/* ----------------------------------------------------------
   GET EVENTS FOR A SPECIFIC DAY
---------------------------------------------------------- */
export async function getEventsForDate(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setHours(23, 59, 59, 999);

  return await getEventsForRange(start, end);
}

/* ----------------------------------------------------------
   GET EVENTS FOR ANY DATE RANGE
---------------------------------------------------------- */
export async function getEventsForRange(start, end) {
  const calendar = createCalendarClient();
  let events = [];

  for (const calId of CALENDARS) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      if (res.data.items) {
        events.push(...res.data.items);
      }
    } catch (err) {
      console.error(`Error fetching events from ${calId}:`, err.message);
    }
  }

  // Sort all events by actual datetime
  events.sort((a, b) => {
    return (
      new Date(a.start.dateTime || a.start.date) -
      new Date(b.start.dateTime || b.start.date)
    );
  });

  return events;
}

/* ----------------------------------------------------------
   FIND OPEN SLOTS (dur = minutes)
---------------------------------------------------------- */
export async function findOpenSlots(date, durationMinutes = 60) {
  const events = await getEventsForDate(new Date(date));
  const day = new Date(date);

  // Human scheduling window
  const dayStart = new Date(day.setHours(7, 0, 0, 0));  // 07:00
  const dayEnd = new Date(day.setHours(21, 0, 0, 0));   // 21:00

  const durationMs = durationMinutes * 60 * 1000;

  // Sort events chronologically
  const sorted = events.sort(
    (a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );

  let slots = [];
  let cursor = dayStart;

  for (const ev of sorted) {
    const start = new Date(ev.start.dateTime);
    const end = new Date(ev.end.dateTime);

    // If there's a gap big enough AND inside human hours
    if (start - cursor >= durationMs && cursor >= dayStart && cursor < dayEnd) {
      const potentialEnd = new Date(cursor.getTime() + durationMs);
      if (potentialEnd <= dayEnd) {
        slots.push({ start: new Date(cursor), end: potentialEnd });
      }
    }

    // Move cursor forward
    if (end > cursor) cursor = end;
  }

  // Check one last time at the end of the day
  if (dayEnd - cursor >= durationMs) {
    slots.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + durationMs),
    });
  }

  return slots;
}


/* ----------------------------------------------------------
   CREATE AN EVENT (always into kingcontractor.com primary)
---------------------------------------------------------- */
export async function createEvent({ title, start, end }) {
  const calendar = createCalendarClient();

  const event = {
    summary: title,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };

  const result = await calendar.events.insert({
    calendarId: process.env.CALENDAR_1, // main calendar
    resource: event,
  });

  return result.data;
}



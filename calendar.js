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
export async function findOpenSlots(date, duration) {
  const dayEvents = await getEventsForDate(date);

  const startOfDay = new Date(date);
  startOfDay.setHours(8, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(20, 0, 0, 0);

  const freeSlots = [];
  let cursor = startOfDay;

  for (const event of dayEvents) {
    const evStart = new Date(event.start.dateTime);
    const evEnd = new Date(event.end.dateTime);

    if (cursor < evStart) {
      const slotEnd = new Date(cursor.getTime() + duration * 60000);

      if (slotEnd <= evStart) {
        freeSlots.push({ start: new Date(cursor), end: slotEnd });
      }
    }

    // move cursor forward
    if (evEnd > cursor) cursor = evEnd;
  }

  // After last event
  const finalSlotEnd = new Date(cursor.getTime() + duration * 60000);
  if (finalSlotEnd <= endOfDay) {
    freeSlots.push({ start: new Date(cursor), end: finalSlotEnd });
  }

  return freeSlots;
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



import { google } from "googleapis";

// ----------------------------------------------------------
// Create Google Calendar API client
// ----------------------------------------------------------
export function createCalendarClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      type: process.env.GOOGLE_TYPE,
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
    },
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  });
}

// ----------------------------------------------------------
// List all calendars we should read
// ----------------------------------------------------------
export function getCalendarList() {
  return [
    process.env.CALENDAR_1, // dean@kingcontractor.com
    process.env.CALENDAR_2, // deanfwhite@gmail.com
    process.env.CALENDAR_3, // dean@deanxwhite.com
  ].filter(Boolean);
}

// ----------------------------------------------------------
// Get ALL events for a specific day (00:00 → 23:59)
// ----------------------------------------------------------
export async function getEventsForDate(date) {
  const auth = createCalendarClient();
  const calendar = google.calendar({ version: "v3", auth });

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const timeMin = start.toISOString();
  const timeMax = end.toISOString();

  let allEvents = [];

  for (const cal of getCalendarList()) {
    try {
      const res = await calendar.events.list({
        calendarId: cal,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
      });

      if (res.data.items) {
        allEvents.push(
          ...res.data.items.map((ev) => ({ ...ev, calendarId: cal }))
        );
      }
    } catch (err) {
      console.error(`Error fetching from calendar ${cal}`, err);
    }
  }

  return allEvents.sort(
    (a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );
}

// ----------------------------------------------------------
// Get ALL events in a date range (for weekly/monthly view)
// ----------------------------------------------------------
export async function getEventsForRange(startDate, endDate) {
  const auth = createCalendarClient();
  const calendar = google.calendar({ version: "v3", auth });

  const timeMin = new Date(startDate).toISOString();
  const timeMax = new Date(endDate).toISOString();

  let allEvents = [];

  for (const cal of getCalendarList()) {
    try {
      const res = await calendar.events.list({
        calendarId: cal,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
      });

      if (res.data.items) {
        allEvents.push(
          ...res.data.items.map((ev) => ({ ...ev, calendarId: cal }))
        );
      }
    } catch (err) {
      console.error(`Error fetching calendar ${cal}`, err);
    }
  }

  return allEvents.sort(
    (a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime)
  );
}

// ----------------------------------------------------------
// Find open time slots in a given day
// ----------------------------------------------------------
export async function findOpenSlots(date, durationMinutes = 60) {
  const events = await getEventsForDate(date);

  const dayStart = new Date(date);
  dayStart.setHours(6, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(22, 0, 0, 0);

  const free = [];
  let pointer = new Date(dayStart);

  for (const ev of events) {
    const evStart = new Date(ev.start.dateTime);
    const evEnd = new Date(ev.end.dateTime);

    if (evStart - pointer >= durationMinutes * 60000) {
      free.push({ start: new Date(pointer), end: new Date(evStart) });
    }
    if (evEnd > pointer) pointer = new Date(evEnd);
  }

  if (dayEnd - pointer >= durationMinutes * 60000) {
    free.push({ start: pointer, end: dayEnd });
  }

  return free;
}

// ----------------------------------------------------------
// CREATE an event on dean@kingcontractor.com
// ----------------------------------------------------------
export async function createEvent({ title, start, end, description = "" }) {
  const calendarId = process.env.CALENDAR_1; // ALWAYS add to main calendar

  const auth = createCalendarClient();
  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary: title,
    description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };

  try {
    const res = await calendar.events.insert({
      calendarId,
      resource: event,
    });
    return res.data;
  } catch (err) {
    console.error("Error creating event:", err);
    throw err;
  }
}



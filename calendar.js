import { google } from "googleapis";

export function createCalendarClient() {
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar.readonly"]
  );
}

export async function getEventsForDate(date) {
  const auth = createCalendarClient();
  const calendar = google.calendar({ version: "v3", auth });

  const timeMin = date.toISOString();
  const timeMax = new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const calendarList = [
    process.env.CALENDAR_1,
    process.env.CALENDAR_2,
    process.env.CALENDAR_3
  ];

  let allEvents = [];

  for (const cal of calendarList) {
    const res = await calendar.events.list({
      calendarId: cal,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime"
    });

    if (res.data.items) {
      allEvents.push(...res.data.items);
    }
  }

  return allEvents;
}

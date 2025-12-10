// calendar.js
import { google } from "googleapis";

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const MIN_HOUR = 8;   // earliest “human” time
const MAX_HOUR = 22;  // latest “human” time

// Support BOTH CALENDAR_1/2/3 and GOOGLE_CALENDAR_1/2/3
const CALENDAR_IDS = [
  process.env.CALENDAR_1 || process.env.GOOGLE_CALENDAR_1,
  process.env.CALENDAR_2 || process.env.GOOGLE_CALENDAR_2,
  process.env.CALENDAR_3 || process.env.GOOGLE_CALENDAR_3,
].filter(Boolean);

if (CALENDAR_IDS.length === 0) {
  console.warn(
    "⚠️ No calendar IDs configured. Set CALENDAR_1/2/3 or GOOGLE_CALENDAR_1/2/3 in env."
  );
} else {
  console.log(
    `📅 Using ${CALENDAR_IDS.length} calendars from env (IDs not logged for safety).`
  );
}

// -----------------------------------------------------------------------------
// GOOGLE AUTH (service account)
// -----------------------------------------------------------------------------
const privateKey = process.env.GOOGLE_PRIVATE_KEY
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
  : undefined;

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  undefined,
  privateKey,
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function toISO(d) {
  return new Date(d).toISOString();
}

function sortByStart(a, b) {
  return (
    new Date(a.start.dateTime || a.start.date) -
    new Date(b.start.dateTime || b.start.date)
  );
}

// Strip ALL http/https URLs from text so Zoom links never hit Discord
function stripUrls(text) {
  return text ? text.replace(/https?:\/\/\S+/g, "").trim() : "";
}

// -----------------------------------------------------------------------------
// GET EVENTS FOR A SINGLE DAY (all 3 calendars merged)
// -----------------------------------------------------------------------------
export async function getEventsForDate(dateInput) {
  const day = new Date(dateInput);
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);

  const end = new Date(day);
  end.setHours(23, 59, 59, 999);

  return getEventsForRange(start, end);
}

// -----------------------------------------------------------------------------
// GET EVENTS FOR RANGE (all calendars merged)
// -----------------------------------------------------------------------------
export async function getEventsForRange(startInput, endInput) {
  if (CALENDAR_IDS.length === 0) return [];

  const timeMin = toISO(startInput);
  const timeMax = toISO(endInput);

  let allEvents = [];

  for (const calId of CALENDAR_IDS) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
      });

      if (res.data.items && res.data.items.length) {
        // tag with calendarId so we can cancel/reschedule later
        const tagged = res.data.items.map((e) => ({
          ...e,
          calendarId: calId,
        }));
        allEvents.push(...tagged);
      }
    } catch (err) {
      console.error(`Calendar list error for ${calId}:`, err.message || err);
    }
  }

  // 🔧 NEW: sanitize summaries / descriptions to remove URLs (Zoom etc.)
  allEvents = allEvents.map((e) => ({
    ...e,
    summary: stripUrls(e.summary),
    description: stripUrls(e.description),
  }));

  allEvents.sort(sortByStart);
  return allEvents;
}

// -----------------------------------------------------------------------------
// FIND OPEN SLOTS BETWEEN MIN_HOUR AND MAX_HOUR
// -----------------------------------------------------------------------------
export async function findOpenSlots(dateInput, durationMinutes, limit = 100) {
  const durationMs = durationMinutes * 60 * 1000;

  const day = new Date(dateInput);
  const dayStart = new Date(day);
  dayStart.setHours(MIN_HOUR, 0, 0, 0);

  const dayEnd = new Date(day);
  dayEnd.setHours(MAX_HOUR, 0, 0, 0);

  const events = await getEventsForDate(day);
  const busy = events
    .map((e) => ({
      start: new Date(e.start.dateTime || e.start.date),
      end: new Date(e.end.dateTime || e.end.date),
    }))
    .sort((a, b) => a.start - b.start);

  const free = [];
  let cursor = dayStart;

  for (const { start, end } of busy) {
    if (end <= cursor) continue;

    if (start - cursor >= durationMs) {
      free.push({
        start: new Date(cursor),
        end: new Date(cursor.getTime() + durationMs),
      });
      if (free.length >= limit) return free;
    }

    if (end > cursor) cursor = end;
  }

  if (dayEnd - cursor >= durationMs && free.length < limit) {
    free.push({
      start: new Date(cursor),
      end: new Date(cursor.getTime() + durationMs),
    });
  }

  return free.slice(0, limit);
}

// -----------------------------------------------------------------------------
// CREATE EVENT (always primary / first calendar)
// -----------------------------------------------------------------------------
export async function createEvent({ title, start, end, description, location }) {
  if (CALENDAR_IDS.length === 0) {
    throw new Error("No calendars configured for createEvent");
  }

  const primaryId = CALENDAR_IDS[0];

  const res = await calendar.events.insert({
    calendarId: primaryId,
    requestBody: {
      summary: title,
      description: description || "",
      location: location || undefined,
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

  const ev = res.data;
  return { ...ev, calendarId: primaryId };
}

// -----------------------------------------------------------------------------
// CANCEL EVENT BY ID
// (calendarId is required – we store it on each event object)
// -----------------------------------------------------------------------------
export async function cancelEventById(calendarId, eventId) {
  if (!calendarId || !eventId) {
    throw new Error("cancelEventById requires calendarId and eventId");
  }

  await calendar.events.delete({
    calendarId,
    eventId,
  });
}

// -----------------------------------------------------------------------------
// RESCHEDULE EVENT BY ID
// -----------------------------------------------------------------------------
export async function rescheduleEventById(
  calendarId,
  eventId,
  newStart,
  newEnd
) {
  if (!calendarId || !eventId) {
    throw new Error("rescheduleEventById requires calendarId and eventId");
  }

  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: {
        dateTime: newStart.toISOString(),
        timeZone: TIMEZONE,
      },
      end: {
        dateTime: newEnd.toISOString(),
        timeZone: TIMEZONE,
      },
    },
  });
}

// -----------------------------------------------------------------------------
// SEARCH EVENTS BY TEXT (for cancel / reschedule flows) – now fuzzy
// -----------------------------------------------------------------------------
export async function searchEventsByText(
  searchText,
  daysBack = 7,
  daysForward = 30
) {
  if (CALENDAR_IDS.length === 0) return [];

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - daysBack);

  const end = new Date(now);
  end.setDate(end.getDate() + daysForward);

  const events = await getEventsForRange(start, end);

  const lower = (searchText || "").toLowerCase().trim();
  if (!lower) return [];

  // Words that don't help matching
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "to",
    "for",
    "with",
    "my",
    "me",
    "please",
    "call",
    "meeting",
    "appointment",
    "slot",
    "event",
    "cancel",
    "move",
    "reschedule",
    "book",
    "schedule",
  ]);

  return events.filter((e) => {
    const text = `${e.summary || ""} ${e.description || ""}`.toLowerCase();

    // 1) direct substring
    if (text.includes(lower)) return true;

    // 2) token-based fuzzy match:
    //    "cancel the youtube video" → ["youtube","video"]
    const tokens = lower
      .split(/\s+/)
      .filter((t) => t && !stopwords.has(t));

    if (tokens.length === 0) return false;

    // require all tokens to appear somewhere in the event text
    return tokens.every((tok) => text.includes(tok));
  });
}






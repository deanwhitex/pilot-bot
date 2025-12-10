// pilot.js
import OpenAI from "openai";
import {
  getEventsForDate,
  getEventsForRange,
  findOpenSlots,
  createEvent,
  cancelEventById,
  rescheduleEventById,
  searchEventsByText,
} from "./calendar.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// “Human” hours for new events
const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;
const DEFAULT_DURATION_MIN = 60;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

// Turn “today”, “tomorrow”, or a date string into a real Date
function resolveDate(input) {
  if (!input) return null;
  const text = String(input).trim().toLowerCase();
  const now = new Date();

  if (text === "today") return now;

  if (text === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  // Let JS try to parse e.g. 2025-12-11 or 11/12/2025 etc.
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

// Time "10:00" → {hours: 10, minutes: 0}
function parseTimeHM(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2}):?(\d{2})?/);
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  if (isNaN(hours) || isNaN(minutes)) return null;
  return { hours, minutes };
}

// Format helpers (used in replies)
function formatDate(date) {
  return new Date(date).toLocaleDateString("en-ZA", { timeZone: TIMEZONE });
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });
}

// Nice list for “what’s my schedule”
function renderEventList(events, label) {
  if (!events.length) {
    return `Your schedule is *wide open* on **${label}** 😎`;
  }

  let out = `📅 **Your schedule for ${label}:**\n\n`;

  events.forEach((ev, i) => {
    const start = formatTime(ev.start.dateTime || ev.start.date);
    const end = formatTime(ev.end.dateTime || ev.end.date);
    const location = ev.location ? ` 📍${ev.location}` : "";
    out += `${i + 1}. **${(ev.summary || "").trim()}**${location} — ${start} to ${end}\n`;
  });

  out += `\nLet me know if you'd like changes, cancellations, or help planning the day! 😊`;
  return out;
}

// Clean event-name search text (“gym?” → “gym”)
function cleanSearchText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/*  Intent detection (used by index.js only for routing if needed)    */
/* ------------------------------------------------------------------ */

export function isSchedulingMessage(message) {
  const t = message.toLowerCase();
  const keywords = [
    "schedule",
    "calendar",
    "appointment",
    "meeting",
    "book",
    "cancel",
    "reschedule",
    "move",
    "slot",
    "free time",
    "open time",
    "what's my day",
    "what's my schedule",
  ];
  return keywords.some((k) => t.includes(k));
}

/* ------------------------------------------------------------------ */
/*  LLM intent parser                                                 */
/* ------------------------------------------------------------------ */

async function interpretMessage(message) {
  const prompt = `
You are Dean’s scheduling assistant.
Convert his message into STRICT JSON (no extra text):

{
  "intent": "",
  "title": "",
  "date": "",
  "start_time": "",
  "duration": "",
  "range_start": "",
  "range_end": "",
  "target_event": ""
}

INTENT OPTIONS:
- "day_summary"        (what's on my schedule / my day)
- "range_summary"      (week, month, between X and Y)
- "find_free_time"     (find free/open time, slots)
- "create_event"       (add/book/put something on calendar)
- "cancel_event"       (cancel/delete/remove something)
- "reschedule_event"   (move/change time)
- "assistant_chat"     (small talk, hello, etc.)
- "unknown"

RULES:
- If the message is mostly about the calendar → choose a scheduling intent.
- For "cancel" messages, set "target_event" to ONLY the event name
  (e.g. "gym", "Record Youtube Video") – strip words like "cancel",
  "please", and punctuation.
- For "create_event":
  - "title": short name, e.g. "Gym" or "Client Call"
  - "date": either an ISO date (YYYY-MM-DD) OR "today" / "tomorrow"
  - "start_time": HH:MM in 24h format if a time is given (e.g. "10:00")
  - If no time is given, leave "start_time" as "".
- For "day_summary": use "date" as ISO or "today"/"tomorrow".
- For "range_summary": fill "range_start" and "range_end" (ISO or natural).
- If you are not sure, set "intent" to "assistant_chat".

USER MESSAGE:
"${message}"
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error("Failed to parse intent JSON:", err);
    return { intent: "unknown" };
  }
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                */
/* ------------------------------------------------------------------ */

export async function handleUserMessage(message) {
  const intent = await interpretMessage(message);

  try {
    switch (intent.intent) {
      case "day_summary":
        return await handleDaySummary(intent.date);

      case "range_summary":
        return await handleRangeSummary(intent.range_start, intent.range_end);

      case "find_free_time":
        return await handleFindFree(intent);

      case "create_event":
        return await handleCreateEvent(intent);

      case "cancel_event":
        return await handleCancel(intent);

      case "reschedule_event":
        return await handleReschedule(intent);

      case "assistant_chat":
        return friendlyChatReply(message);

      default:
        return "I'm not entirely sure what you mean, but I'm here to help! 😊";
    }
  } catch (err) {
    console.error("handleUserMessage error:", err);
    return "Sorry Dean, something went wrong while I was checking your schedule. 😕";
  }
}

/* ------------------------------------------------------------------ */
/*  Chatty fallback                                                   */
/* ------------------------------------------------------------------ */

function friendlyChatReply(message) {
  return `Sure Dean — what can I help you with? 😊`;
}

/* ------------------------------------------------------------------ */
/*  Day & range summaries                                             */
/* ------------------------------------------------------------------ */

async function handleDaySummary(dateText) {
  const date = resolveDate(dateText || "today");
  if (!date) {
    return "Which day should I check? You can say something like **today**, **tomorrow**, or **2025-12-11** 😊";
  }

  const events = await getEventsForDate(date);
  return renderEventList(events, formatDate(date));
}

async function handleRangeSummary(startText, endText) {
  const start = resolveDate(startText);
  const end = resolveDate(endText);

  if (!start || !end) {
    return "Which date range should I check? For example: **this week**, or **2025-12-10 to 2025-12-17**.";
  }

  const events = await getEventsForRange(start, end);

  if (!events.length) {
    return `No events between **${formatDate(start)}** and **${formatDate(end)}**. 🎉`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(end)}:**\n\n`;
  events.forEach((ev) => {
    const day = formatDate(ev.start.dateTime || ev.start.date);
    const time = formatTime(ev.start.dateTime || ev.start.date);
    out += `• **${(ev.summary || "").trim()}** — ${day} at ${time}\n`;
  });

  return out;
}

/* ------------------------------------------------------------------ */
/*  Free time                                                         */
/* ------------------------------------------------------------------ */

async function handleFindFree({ date, duration }) {
  const baseDate = resolveDate(date || "today");
  if (!baseDate) {
    return "Which day should I look for free time on? 😊";
  }

  const dur = duration ? parseInt(duration, 10) : DEFAULT_DURATION_MIN;
  const slots = await findOpenSlots(baseDate, dur);

  if (!slots.length) {
    return `No free **${dur}-minute** slots on **${formatDate(baseDate)}** 😕`;
  }

  let out = `🕒 **Available ${dur}-minute slots on ${formatDate(baseDate)}:**\n\n`;
  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

/* ------------------------------------------------------------------ */
/*  Create event (fixed)                                              */
/* ------------------------------------------------------------------ */

async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) {
    return "What should I call this event? (e.g. **Gym**, **Client Call**) 😊";
  }

  const baseDate = resolveDate(date || "today");
  if (!baseDate) {
    return "Which day should I schedule that on? You can say **today**, **tomorrow**, or a specific date.";
  }

  const durMin = duration ? parseInt(duration, 10) : DEFAULT_DURATION_MIN;

  // If no explicit time given → propose a few options
  if (!start_time) {
    const suggestions = await findOpenSlots(baseDate, durMin, 3);

    if (!suggestions.length) {
      return `I couldn't find any good ${durMin}-minute slots on **${formatDate(
        baseDate
      )}**. Want me to check another day?`;
    }

    let out = `Here are some good options for **${title}** on **${formatDate(
      baseDate
    )}**:\n\n`;
    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    out += `\nReply with **1**, **2**, or **3** and I’ll book it.`;
    return out;
  }

  // We DO have a time, so create immediately
  const hm = parseTimeHM(start_time);
  if (!hm) {
    return "I couldn't quite understand that time. Could you say it as **HH:MM**, like **10:00**?";
  }

  const start = new Date(baseDate);
  start.setHours(hm.hours, hm.minutes, 0, 0);

  const end = new Date(start.getTime() + durMin * 60 * 1000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return `That’s outside your usual hours (${MIN_HOUR}:00–${MAX_HOUR}:00). Want to try a different time?`;
  }

  try {
    const ev = await createEvent({ title, start, end });
    return `🎉 All set! I added **${title}** on **${formatDate(
      start
    )}**, from **${formatTime(start)}** to **${formatTime(end)}**.`;
  } catch (err) {
    console.error("createEvent error:", err);
    return "I tried to add that to your calendar, but something went wrong talking to Google. 😕";
  }
}

/* ------------------------------------------------------------------ */
/*  Cancel event (smarter)                                            */
/* ------------------------------------------------------------------ */

async function handleCancel({ target_event }) {
  if (!target_event) {
    return "Which event would you like me to cancel? (e.g. **gym**, **Record Youtube Video**) 😊";
  }

  const search = cleanSearchText(target_event);
  if (!search) {
    return "I couldn't quite tell which event you meant. Could you give me the event name, like **gym** or **NB CALL – Sergio**?";
  }

  const matches = await searchEventsByText(search);

  if (!matches.length) {
    return `I couldn't find any events matching **"${search}"** in the next few weeks.`;
  }

  // Exactly one match → cancel directly
  if (matches.length === 1) {
    const ev = matches[0];
    try {
      await cancelEventById(ev.calendarId, ev.id);
      return `🗑️ Done — I cancelled **${(ev.summary || "").trim()}** on **${formatDate(
        ev.start.dateTime || ev.start.date
      )}** at **${formatTime(ev.start.dateTime || ev.start.date)}**.`;
    } catch (err) {
      console.error("cancelEvent error:", err);
      return "I found the event but couldn't cancel it due to an error talking to Google. 😕";
    }
  }

  // Multiple candidates → list them
  let out = "I found several events that might match. Which one should I cancel?\n\n";
  matches.slice(0, 10).forEach((ev, i) => {
    out += `${i + 1}. **${(ev.summary || "").trim()}** — ${formatDate(
      ev.start.dateTime || ev.start.date
    )} at ${formatTime(ev.start.dateTime || ev.start.date)}\n`;
  });
  out += `\nReply with the **number** of the one you want me to cancel.`;

  return out;
}

/* ------------------------------------------------------------------ */
/*  Reschedule (simple version – keeps behaviour but safe)            */
/* ------------------------------------------------------------------ */

async function handleReschedule({ target_event, date, start_time }) {
  if (!target_event) {
    return "Which event should I move? (e.g. **NB CALL – Sergio**) 😊";
  }

  const search = cleanSearchText(target_event);
  const matches = await searchEventsByText(search);

  if (!matches.length) {
    return `I couldn't find any events matching **"${search}"** in the next few weeks.`;
  }

  // For now, if multiple matches, ask the user to be more specific
  if (matches.length > 1) {
    let out = "I found several events. Which one should I move?\n\n";
    matches.slice(0, 10).forEach((ev, i) => {
      out += `${i + 1}. **${(ev.summary || "").trim()}** — ${formatDate(
        ev.start.dateTime || ev.start.date
      )} at ${formatTime(ev.start.dateTime || ev.start.date)}\n`;
    });
    out += `\nReply with the **number** or rephrase with the exact title and date.`;
    return out;
  }

  const ev = matches[0];

  const baseDate = resolveDate(date || ev.start.dateTime || ev.start.date);
  if (!baseDate) {
    return "When would you like to move it to? (e.g. **tomorrow at 16:00**)";
  }

  if (!start_time) {
    return "What time should I move it to? (e.g. **15:30**)";
  }

  const hm = parseTimeHM(start_time);
  if (!hm) {
    return "I couldn't understand that new time. Please say it like **14:00**.";
  }

  const newStart = new Date(baseDate);
  newStart.setHours(hm.hours, hm.minutes, 0, 0);
  const newEnd = new Date(newStart.getTime() + DEFAULT_DURATION_MIN * 60 * 1000);

  try {
    await rescheduleEventById(ev.calendarId, ev.id, newStart, newEnd);
    return `🔄 Done — I’ve moved **${(ev.summary || "").trim()}** to **${formatDate(
      newStart
    )}** at **${formatTime(newStart)}**.`;
  } catch (err) {
    console.error("rescheduleEvent error:", err);
    return "I found the event but couldn't move it due to an error talking to Google. 😕";
  }
}




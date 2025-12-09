// pilot.js — FULL RESET (Stable, clean scheduling)
import OpenAI from "openai";
import {
  getEventsForDate,
  getEventsForRange,
  findOpenSlots,
  createEvent,
  cancelEventById,
  rescheduleEventById,
  searchEventsByText
} from "./calendar.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TIMEZONE = "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;
const DEFAULT_DURATION = 60;

// ----------------------------------------------------------
// INTERPRET USER MESSAGE INTO STRICT JSON
// ----------------------------------------------------------
async function interpret(message) {
  const prompt = `
Convert Dean's message into STRICT JSON:

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
- "day_summary"
- "range_summary"
- "find_free_time"
- "create_event"
- "cancel_event"
- "reschedule_event"
- "chat"
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt + "\nUSER: " + message }],
    temperature: 0
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { intent: "chat" };
  }
}

// ----------------------------------------------------------
// MAIN ROUTER
// ----------------------------------------------------------
export async function handleUserMessage(message) {
  const intent = await interpret(message);

  switch (intent.intent) {
    case "day_summary":
      return handleDaySummary(intent.date);

    case "range_summary":
      return handleRangeSummary(intent.range_start, intent.range_end);

    case "find_free_time":
      return handleFindFree(intent);

    case "create_event":
      return handleCreate(intent);

    case "cancel_event":
      return handleCancel(intent);

    case "reschedule_event":
      return handleReschedule(intent);

    default:
      return "Sure Dean — what can I help you with? 😊";
  }
}

// ----------------------------------------------------------
// IMPLEMENTATIONS
// ----------------------------------------------------------
async function handleDaySummary(date) {
  if (!date) return "Which date?";

  const events = await getEventsForDate(date);
  if (events.length === 0)
    return `You're free on **${formatDate(date)}** 😎`;

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;
  events.forEach((ev, i) => {
    out += `${i + 1}. **${ev.summary.trim()}** — ${formatTime(
      ev.start.dateTime
    )} to ${formatTime(ev.end.dateTime)}\n`;
  });
  return out;
}

async function handleRangeSummary(start, end) {
  if (!start || !end) return "Which date range?";

  const events = await getEventsForRange(start, end);
  if (events.length === 0)
    return `You have no events between ${formatDate(start)} and ${formatDate(
      end
    )}.`;

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(
    end
  )}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary.trim()}** — ${formatDate(
      ev.start.dateTime
    )} ${formatTime(ev.start.dateTime)}\n`;
  });

  return out;
}

async function handleFindFree({ date, duration }) {
  if (!date) return "Which day should I look at?";
  const dur = duration || DEFAULT_DURATION;

  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0)
    return `No free ${dur}-minute slots on ${formatDate(date)} 😕`;

  let out = `🕒 Available slots on ${formatDate(date)}:\n\n`;
  slots.forEach((s, i) => {
    out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

async function handleCreate({ title, date, start_time, duration }) {
  if (!title) return "What should I call this event?";
  if (!date) return "Which date?";

  const dur = duration || DEFAULT_DURATION;

  if (!start_time) {
    const options = await findOpenSlots(date, dur, 3);
    if (options.length === 0) return "No available times that day.";

    let out = `Here are good times for **${title}**:\n\n`;
    options.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    return out;
  }

  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR)
    return "That time is outside your usual hours (08:00–22:00).";

  await createEvent({ title, start, end });

  return `🎉 Added **${title}** from ${formatTime(start)} to ${formatTime(
    end
  )}.`;
}

async function handleCancel({ target_event }) {
  if (!target_event) return "What should I cancel?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) return "I can't find that event.";

  if (matches.length === 1) {
    await cancelEventById(matches[0].calendarId, matches[0].id);
    return `🗑️ Cancelled **${matches[0].summary.trim()}**.`;
  }

  let out = "I found multiple matches:\n\n";
  matches.forEach((m, i) => {
    out += `${i + 1}. **${m.summary.trim()}** — ${formatTime(
      m.start.dateTime
    )}\n`;
  });

  return out;
}

async function handleReschedule({ target_event, date, start_time }) {
  if (!target_event) return "Which event should I move?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) return "I couldn't find that event.";

  if (matches.length > 1)
    return "I found multiple events — tell me which one.";

  const ev = matches[0];

  if (!start_time)
    return "What time should I move it to?";

  const newStart = new Date(`${date}T${start_time}`);
  const newEnd = new Date(newStart.getTime() + 60 * 60000);

  await rescheduleEventById(ev.calendarId, ev.id, newStart, newEnd);

  return `🔄 Rescheduled **${ev.summary.trim()}** to ${formatTime(newStart)}.`;
}

// ----------------------------------------------------------
function formatDate(date) {
  return new Date(date).toLocaleDateString("en-ZA", {
    timeZone: TIMEZONE
  });
}
function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE
  });
}

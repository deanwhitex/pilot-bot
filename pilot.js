// pilot.js
import OpenAI from "openai";
import {
  getEventsForDate,
  getEventsForRange,
  searchEventsByText,
  cancelEventById,
  rescheduleEventById,
  createEvent,
} from "./calendar.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TIMEZONE = "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;

/* ----------------------------------------------------------
   INTENT PARSER
---------------------------------------------------------- */
async function parse(message) {
  const prompt = `
Extract intent ONLY. Return JSON ONLY:

{
  "intent": "",
  "date": "",
  "title": "",
  "target": "",
  "start_time": "",
  "duration": ""
}

INTENTS:
- "day_summary"
- "create_event"
- "cancel_event"
- "reschedule_event"
- "assistant_chat"

RULES:
- If user asks "what's on my schedule", "appointments", etc → day_summary
- If user says "cancel", "remove" → cancel_event
- If user says "move", "reschedule" → reschedule_event
- If user says "add", "book", "schedule" → create_event
- If nothing matches → assistant_chat

MESSAGE:
"${message}"
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { intent: "assistant_chat" };
  }
}

/* ----------------------------------------------------------
   MAIN ROUTER
---------------------------------------------------------- */
export async function handleUserMessage(message) {
  const intent = await parse(message);

  switch (intent.intent) {
    case "day_summary":
      return handleDaySummary(intent.date);

    case "create_event":
      return handleCreate(intent);

    case "cancel_event":
      return handleCancel(intent);

    case "reschedule_event":
      return handleReschedule(intent);

    case "assistant_chat":
    default:
      return `Sure Dean — what can I help you with? 😊`;
  }
}

/* ----------------------------------------------------------
   DAY SUMMARY
---------------------------------------------------------- */
async function handleDaySummary(dateStr) {
  let date = dateStr ? new Date(dateStr) : new Date();
  if (dateStr?.toLowerCase() === "tomorrow") {
    date = new Date();
    date.setDate(date.getDate() + 1);
  }

  const events = await getEventsForDate(date);

  if (!events.length) return `You're free on **${formatDate(date)}** 😎`;

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;

  events.forEach((ev, i) => {
    out += `${i + 1}. **${ev.summary}** — ${formatTime(ev.start.dateTime)}\n`;
  });

  return out;
}

/* ----------------------------------------------------------
   CANCEL EVENT
---------------------------------------------------------- */
async function handleCancel(intent) {
  if (!intent.target) return "Which event should I cancel?";

  const results = await searchEventsByText(intent.target);

  if (results.length === 0)
    return `I couldn't find anything for "${intent.target}".`;

  if (results.length === 1) {
    await cancelEventById(results[0].calendarId, results[0].id);
    return `🗑️ Cancelled **${results[0].summary}**.`;
  }

  let out = `I found multiple matches:\n\n`;
  results.forEach((ev, i) => {
    out += `${i + 1}. **${ev.summary}** — ${formatTime(ev.start.dateTime)}\n`;
  });
  return out;
}

/* ----------------------------------------------------------
   RESCHEDULE EVENT
---------------------------------------------------------- */
async function handleReschedule(intent) {
  if (!intent.target) return "Which event should I move?";

  const matches = await searchEventsByText(intent.target);
  if (!matches.length) return "I couldn't find that.";

  if (!intent.start_time) return "What time should I move it to?";

  const ev = matches[0];

  const newStart = new Date(ev.start.dateTime);
  const [h, m] = intent.start_time.split(":");
  newStart.setHours(h, m ?? 0, 0, 0);

  const newEnd = new Date(newStart.getTime() + 60 * 60000);

  await rescheduleEventById(ev.calendarId, ev.id, newStart, newEnd);

  return `🔄 Rescheduled **${ev.summary}** to ${formatTime(newStart)}.`;
}

/* ----------------------------------------------------------
   CREATE EVENT
---------------------------------------------------------- */
async function handleCreate(intent) {
  if (!intent.title) return "What should I call this event?";
  if (!intent.date) return "When should I schedule it?";

  const start = new Date(`${intent.date}T${intent.start_time || "09:00"}`);
  const end = new Date(start.getTime() + 60 * 60000);

  await createEvent({ title: intent.title, start, end });

  return `🎉 Event added: **${intent.title}** at ${formatTime(start)}.`;
}

/* ----------------------------------------------------------
   HELPERS
---------------------------------------------------------- */
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


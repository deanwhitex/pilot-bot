// pilot.js
import OpenAI from "openai";
import {
  getEventsForDate,
  getEventsForRange,
  findOpenSlots,
  createEvent,
} from "./calendar.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// HUMAN SCHEDULING RULES
const MIN_HOUR = 8;
const MAX_HOUR = 22;
const DEFAULT_DURATION_MIN = 60;
const TIMEZONE = "Africa/Windhoek";   // RESTORED — correct timezone

/* ----------------------------------------------------------
   INTENT ENGINE — Converts human text to structured JSON
---------------------------------------------------------- */
async function interpretMessage(message) {
  const prompt = `
You are Dean’s expert AI scheduling assistant.

Return STRICT JSON ONLY:

{
  "intent": "",
  "date": "",
  "title": "",
  "range_start": "",
  "range_end": "",
  "duration": "",
  "start_time": "",
  "end_time": ""
}

Rules:
- “add/book/schedule/put/make” → create_event
- “what's on / what do I have / schedule” → day_summary
- week/month/between → range_summary
- free time/open slot → find_free_time
- default duration = 60
- convert "tomorrow", "next friday" to ISO if possible
- if unsure, leave fields blank (I will handle them)
- NEVER output anything except the JSON object
USER MESSAGE:
"${message}"
`;

  const reply = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  try {
    const parsed = JSON.parse(reply.choices[0].message.content);

    // Fix: Interpret "tomorrow"
    if (!parsed.date && message.toLowerCase().includes("tomorrow")) {
      parsed.date = getTomorrowISO();
    }

    return parsed;

  } catch {
    return { intent: "unknown" };
  }
}

/* Tomorrow helper */
function getTomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

/* ----------------------------------------------------------
   MAIN ROUTER
---------------------------------------------------------- */
export async function handleUserMessage(message) {
  const intent = await interpretMessage(message);

  switch (intent.intent) {
    case "day_summary":
      return await handleDaySummary(intent.date);

    case "range_summary":
      return await handleRangeSummary(intent.range_start, intent.range_end);

    case "find_free_time":
      return await handleFindFree(intent);

    case "create_event":
      return await handleCreateEvent(intent);

    default:
      return "I'm not entirely sure what you mean, but I'm here to help! 😊";
  }
}

/* ----------------------------------------------------------
   DAY SUMMARY
---------------------------------------------------------- */
async function handleDaySummary(date) {
  if (!date) return "Which date should I check? 😊";

  // FIX: Force correct local interpretation
  const day = new Date(`${date}T00:00:00`);

  const events = await getEventsForDate(day);

  if (events.length === 0) {
    return `Your schedule is *wide open* on **${formatDate(date)}** 😎`;
  }

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;

  for (const ev of events) {
    out += `• **${ev.summary}** — ${formatTime(ev.start.dateTime)} to ${formatTime(ev.end.dateTime)}\n`;
  }

  return out;
}

/* ----------------------------------------------------------
   RANGE SUMMARY
---------------------------------------------------------- */
async function handleRangeSummary(start, end) {
  if (!start || !end)
    return "Which date range should I check?";

  const events = await getEventsForRange(
    new Date(`${start}T00:00:00`),
    new Date(`${end}T23:59:00`)
  );

  if (events.length === 0) {
    return `You have *no events* between **${formatDate(start)}** and **${formatDate(end)}** 🎉`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(end)}:**\n\n`;

  for (const ev of events) {
    out += `• **${ev.summary}** — ${formatDate(ev.start.dateTime)} (${formatTime(ev.start.dateTime)}–${formatTime(ev.end.dateTime)})\n`;
  }

  return out;
}

/* ----------------------------------------------------------
   FIND FREE TIME
---------------------------------------------------------- */
async function handleFindFree({ date, duration }) {
  if (!date) return "Which date should I check? 😊";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  const slots = await findOpenSlots(date, dur);

  if (!slots || slots.length === 0) {
    return `No available **${dur}-minute** slot on **${formatDate(date)}** 😕`;
  }

  let out = `🕒 **Available ${dur}-minute slots for ${formatDate(date)}:**\n\n`;

  for (const s of slots) {
    out += `• ${formatTime(s.start)}–${formatTime(s.end)}\n`;
  }

  return out;
}

/* ----------------------------------------------------------
   CREATE EVENT
---------------------------------------------------------- */
async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call the event? 😊";
  if (!date) return "Which date should I schedule it on?";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  // SUGGESTIONS MODE
  if (!start_time) {
    const suggestions = await findOpenSlots(date, dur);

    if (!suggestions || suggestions.length === 0) {
      return `I couldn't find any suitable times on **${formatDate(date)}** ❌  
Would you like me to check the next day?`;
    }

    let out = `I found some great **${dur}-minute** options on **${formatDate(date)}**:\n\n`;
    suggestions.slice(0, 3).forEach((slot, i) => {
      out += `${i + 1}. **${formatTime(slot.start)} – ${formatTime(slot.end)}**\n`;
    });
    out += `\n👉 Reply with **1**, **2**, or **3** to book it.`;

    return out;
  }

  // DIRECT BOOKING
  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return `😅 That time is outside your preferred hours (08:00–22:00). Want another time?`;
  }

  const created = await createEvent({ title, start, end });

  return `🎉 **Event added!**

📌 ${title}  
📅 ${formatDate(start)}  
🕒 ${formatTime(start)} – ${formatTime(end)}
`;
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





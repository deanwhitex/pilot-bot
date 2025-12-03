// pilot.js
import OpenAI from "openai";
import {
  getEventsForDate,
  getEventsForRange,
  findOpenSlots,
  createEvent,
} from "./calendar.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Human rules
const MIN_HOUR = 8;    // Dean wakes up at 8AM
const MAX_HOUR = 22;   // Dean prefers to stop working at 10PM
const DEFAULT_DURATION_MIN = 60;
const TIMEZONE = "Africa/Johannesburg";

/* ----------------------------------------------------------
   INTENT ENGINE — ZERO hallucinations
---------------------------------------------------------- */
async function interpretMessage(message) {
  const TODAY = new Date().toISOString().split("T")[0];

  const prompt = `
You are Dean’s intent classification system.
❗ You DO NOT generate events.
❗ You DO NOT guess schedule.
❗ You DO NOT describe appointments.
❗ You ONLY return JSON describing what the user wants.

TODAY = ${TODAY}

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

INTENT RULES:
- “What's on”, “What do I have”, “Schedule for” → "day_summary"
- “Week”, “Month”, “Between”, “Next week” → "range_summary"
- “Find free time”, “Open slots”, “When can I” → "find_free_time"
- “Book”, “Add”, “Create event”, “Schedule” → "create_event"

DATE RULES:
- If the user says “tomorrow”, calculate it using TODAY.
- If they say a weekday (“Friday”), find the *next upcoming* one.
- Never invent years — use the CURRENT year unless specifically stated.

If the user does NOT give a time for event creation:
- Leave "start_time" blank.
- The assistant will suggest times.

NO commentary. NO extra text. JSON ONLY.

USER INPUT:
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
    console.error("Intent parse error:", err);
    return { intent: "unknown" };
  }
}

/* ----------------------------------------------------------
   MAIN CONTROLLER
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
   DAY SUMMARY (REAL Google Calendar events ONLY)
---------------------------------------------------------- */
async function handleDaySummary(date) {
  if (!date) return "Which date would you like me to check? 😊";

  const events = await getEventsForDate(date);

  if (events.length === 0) {
    return `✨ Your schedule is *wide open* on **${formatDate(date)}**!`;
  }

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;

  events.forEach((ev, i) => {
    out += `${i + 1}. **${ev.summary}** — ${formatTime(ev.start.dateTime)} to ${formatTime(ev.end.dateTime)}\n`;
  });

  return out + `\nLet me know if you'd like changes, cancellations, or help planning the day! 😊`;
}

/* ----------------------------------------------------------
   RANGE SUMMARY (week/month)
---------------------------------------------------------- */
async function handleRangeSummary(start, end) {
  if (!start || !end) return "Which date range should I check?";

  const events = await getEventsForRange(start, end);

  if (events.length === 0) {
    return `📆 You have *no events* between **${formatDate(start)}** and **${formatDate(end)}** 🎉`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(end)}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary}** — ${formatDate(ev.start.dateTime)} (${formatTime(ev.start.dateTime)}–${formatTime(ev.end.dateTime)})\n`;
  });

  return out;
}

/* ----------------------------------------------------------
   FIND FREE TIME
---------------------------------------------------------- */
async function handleFindFree({ date, duration }) {
  if (!date) return "Which date should I look for free time? 😊";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;
  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return `No free ${dur}-minute slots available on **${formatDate(date)}** 😕`;
  }

  let out = `🕒 **Available ${dur}-minute slots for ${formatDate(date)}:**\n\n`;

  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

/* ----------------------------------------------------------
   CREATE EVENT (with smart human logic)
---------------------------------------------------------- */
async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call the event? 😊";
  if (!date) return "Which date should I schedule it on?";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  // If no start time → suggest 3 best options
  if (!start_time) {
    const options = await findOpenSlots(date, dur, 3);

    if (options.length === 0) {
      return `I couldn't find any good times on **${formatDate(date)}** 😕  
Would you like me to check the next day?`;
    }

    let out = `⏱ **I found a few good options for ${title} on ${formatDate(date)}:**\n\n`;

    options.forEach((slot, i) => {
      out += `${i + 1}. **${formatTime(slot.start)} – ${formatTime(slot.end)}**\n`;
    });

    out += `\n👉 Reply with **1**, **2**, or **3** and I’ll book it.`;

    return out;
  }

  // Time *was* provided → create event
  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  // Human rules: Do not schedule before 8am or after 10pm
  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return `😅 That time falls outside your preferred hours (08:00–22:00). Would you like another time?`;
  }

  const ev = await createEvent({ title, start, end });

  return `🎉 **Event added!**

📌 ${title}  
📅 ${formatDate(start)}  
🕒 ${formatTime(start)} – ${formatTime(end)}  

Let me know if you'd like reminders or help planning your day! 😊`;
}

/* ----------------------------------------------------------
   FORMATTERS
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






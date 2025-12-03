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

const TIMEZONE = "Africa/Windhoek";

/* ----------------------------------------------------------
   REAL DATE INJECTION (CRITICAL FIX)
   ---------------------------------------------------------- */
function getTodayISO() {
  const now = new Date();
  return now.toISOString().split("T")[0]; // yyyy-mm-dd
}

/* ----------------------------------------------------------
   INTERPRET USER MESSAGE → JSON intent
   ---------------------------------------------------------- */
async function interpretMessage(message) {
  const todayISO = getTodayISO();

  const prompt = `
You are Dean's friendly scheduling assistant.

Today's REAL date is **${todayISO}**.  
All natural language dates (e.g., "tomorrow", "next Friday", "on the 4th") MUST be interpreted relative to this date.

Your ONLY output must be JSON in this format:

{
  "intent": "",
  "date": "",
  "duration": "",
  "title": "",
  "range_start": "",
  "range_end": ""
}

INTENT RULES:
- If user asks "what's on X", "schedule for X", "my day on X" → intent = "day_summary"
- If user says "week", "month", "range" → intent = "range_summary"
- If user says "open slot", "free time", "availability", “space” → intent = "find_free_time"
- If user says "add", "book", "schedule", "create event" → intent = "create_event"
- Otherwise → "unknown"

DATE RULES:
- Convert relative dates: “tomorrow”, “today”, “next Friday”, etc.
- If the day number has passed this month (e.g., "the 4th"), move it to *next month*.
- NEVER output past dates.
- Always output ISO format: yyyy-mm-dd

EVENT DURATION:
- Default: 60 minutes unless user specifies.

Be friendly but FOLLOW THE JSON FORMAT STRICTLY.

User message: "${message}"
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  let text = completion.choices[0].message.content.trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("Failed to parse JSON from AI:", text);
    return { intent: "unknown" };
  }
}

/* ----------------------------------------------------------
   MAIN MESSAGE ROUTER
   ---------------------------------------------------------- */
export async function handleUserMessage(message) {
  const intent = await interpretMessage(message);

  switch (intent.intent) {
    case "day_summary":
      return await handleDaySummary(intent);

    case "range_summary":
      return await handleRangeSummary(intent);

    case "find_free_time":
      return await handleFindFree(intent);

    case "create_event":
      return await handleCreateEvent(intent);

    default:
      return "I’m not entirely sure what you mean, but I’m here to help! 😊";
  }
}

/* ----------------------------------------------------------
   DAY SUMMARY
   ---------------------------------------------------------- */
async function handleDaySummary({ date }) {
  if (!date) return "Which date should I check for you? 😊";

  const events = await getEventsForDate(new Date(date));

  if (events.length === 0) {
    return `Looks like your schedule is *wide open* on **${formatDate(
      date
    )}** 😎`;
  }

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;

  events.forEach((ev, i) => {
    out += `${i + 1}. **${ev.summary}**\n`;
    out += `   🕒 *${formatTime(ev.start.dateTime)} – ${formatTime(
      ev.end.dateTime
    )}*\n`;

    if (ev.location) {
      out += `   📍 ${ev.location}\n`;
    }

    out += `\n`;
  });

  out += `Let me know if you'd like changes, cancellations, or help planning the day! 😊`;

  return out;
}

/* ----------------------------------------------------------
   RANGE SUMMARY
   ---------------------------------------------------------- */
async function handleRangeSummary({ range_start, range_end }) {
  if (!range_start || !range_end) {
    return "Which date range should I check for you? 😊";
  }

  const events = await getEventsForRange(new Date(range_start), new Date(range_end));

  if (events.length === 0) {
    return `You're free between **${formatDate(range_start)}** and **${formatDate(range_end)}** 🎉`;
  }

  let out = `Here’s everything from **${formatDate(range_start)}** to **${formatDate(range_end)}**:\n\n`;

  events.forEach(ev => {
    out += `• **${ev.summary}** — ${formatDate(ev.start.dateTime)} (${formatTime(ev.start.dateTime)}–${formatTime(ev.end.dateTime)})\n`;
  });

  return out;
}

/* ----------------------------------------------------------
   FIND OPEN SLOTS
   ---------------------------------------------------------- */
async function handleFindFree({ date, duration }) {
  if (!date) return "What date should I check for free time? 😊";

  const dur = duration ? parseInt(duration) : 60;

  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return `No open ${dur}-minute slots on **${formatDate(date)}** 😕`;
  }

  let out = `Here are your available ${dur}-minute slots on **${formatDate(date)}**:\n\n`;

  slots.forEach(s => {
    out += `• ${formatTime(s.start)} to ${formatTime(s.end)}\n`;
  });

  return out;
}

/* ----------------------------------------------------------
   CREATE AN EVENT
   ---------------------------------------------------------- */
async function handleCreateEvent({ title, date, duration }) {
  if (!title) return "What should I call this event? 😊";
  if (!date) return "Which date should I schedule this on?";

  const dur = duration ? parseInt(duration) : 60;

  // Find a human-friendly slot
  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return (
      "I checked your day, Dean — there are *no reasonable free slots* (07:00–21:00). " +
      "Would you like me to move something or try another day?"
    );
  }

  const slot = slots[0];
  const start = new Date(slot.start);
  const end = new Date(slot.end);

  const event = await createEvent({ title, start, end });

  return (
    `🎉 **All done, Dean!**\n` +
    `I’ve added **${title}** on **${formatDate(start)}**,\n` +
    `from **${formatTime(start)} to ${formatTime(end)}**.\n`
  );
}

/* ----------------------------------------------------------
   FORMATTING HELPERS
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



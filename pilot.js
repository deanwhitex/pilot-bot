// pilot.js
import OpenAI from "openai";
import {
  getEventsForDate,
  getEventsForRange,
  findOpenSlots,
  createEvent,
} from "./calendar.js";

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Human scheduling window
const MIN_HOUR = 8;   // 08:00
const MAX_HOUR = 22;  // 22:00
const DEFAULT_DURATION_MIN = 60;
const TIMEZONE = "Africa/Johannesburg";

/* ----------------------------------------------------------
   INTENT ENGINE — Converts human text to structured JSON
---------------------------------------------------------- */
async function interpretMessage(message) {
  const prompt = `
You are Dean’s expert AI scheduling assistant.

Convert his natural language request into STRICT JSON:

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

RULES:
- “Add”, “Book”, “Schedule”, “Put”, “Make” → intent = "create_event"
- “What's on”, “What do I have”, “My schedule” → intent = "day_summary"
- “Week”, “Month”, “Next week”, “Between” → intent = "range_summary"
- “Find free time”, “Open slot”, “When can I” → intent = "find_free_time"
- Default duration = 60 minutes
- Convert human dates (“tomorrow”, “next Friday”) to ISO only if possible
- If the user does NOT specify a time for event creation:
    → leave start_time blank
    → your assistant logic will suggest three human-friendly options
- Humans do NOT want events before 08:00 or after 22:00
- Ensure JSON is valid, no trailing commas, no commentary.
- NEVER return text outside the JSON.

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
  } catch {
    return { intent: "unknown" };
  }
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
      return await handleRangeSummary(
        intent.range_start,
        intent.range_end
      );

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
  if (!date) return "Which date would you like me to check? 😊";

  const events = await getEventsForDate(new Date(date));

  if (events.length === 0) {
    return `Your schedule is *wide open* on **${formatDate(date)}** 😎`;
  }

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;

  for (const ev of events) {
    out += `• **${ev.summary}** — ${formatTime(ev.start.dateTime)} to ${formatTime(
      ev.end.dateTime
    )}\n`;
  }

  return out;
}

/* ----------------------------------------------------------
   WEEK / MONTH RANGE SUMMARY
---------------------------------------------------------- */
async function handleRangeSummary(start, end) {
  if (!start || !end)
    return "Which date range would you like me to check?";

  const events = await getEventsForRange(
    new Date(start),
    new Date(end)
  );

  if (events.length === 0) {
    return `You have *no events* between **${formatDate(start)}** and **${formatDate(end)}** 🎉`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(end)}:**\n\n`;

  for (const ev of events) {
    out += `• **${ev.summary}** — ${formatDate(ev.start.dateTime)} (${formatTime(
      ev.start.dateTime
    )}–${formatTime(ev.end.dateTime)})\n`;
  }

  return out;
}

/* ----------------------------------------------------------
   FIND OPEN SLOT
---------------------------------------------------------- */
async function handleFindFree({ date, duration }) {
  if (!date) return "Which date should I check for free time? 😊";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;
  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return `No available **${dur}-minute** slot on **${formatDate(date)}** 😕`;
  }

  let out = `🕒 **Available ${dur}-minute slots for ${formatDate(date)}:**\n\n`;

  for (const s of slots) {
    out += `• ${formatTime(s.start)}–${formatTime(s.end)}\n`;
  }

  return out;
}

/* ----------------------------------------------------------
   EVENT CREATION
---------------------------------------------------------- */
async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call the event? 😊";
  if (!date) return "Which date should I schedule it on?";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  // If NO time given, we need to suggest 3 options
  if (!start_time) {
    const suggestions = await findOpenSlots(date, dur, 3); // get top 3

    if (suggestions.length === 0) {
      return `I couldn't find any suitable times on **${formatDate(date)}** ❌  
Would you like me to check the next day?`;
    }

    let out = `I found a few good **${dur}-minute** time options on **${formatDate(
      date
    )}**:\n\n`;

    suggestions.forEach((slot, i) => {
      out += `${i + 1}. **${formatTime(slot.start)} – ${formatTime(
        slot.end
      )}**\n`;
    });

    out += `\n👉 Reply with **1**, **2**, or **3** and I will book it.`;

    return out;
  }

  // Time was provided → proceed with creating event
  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  // Human logic: Prevent scheduling before 08:00 or after 22:00
  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return `😅 That time falls outside your normal scheduling hours (08:00–22:00).  
Try another time?`;
  }

  const event = await createEvent({ title, start, end });

  return `🎉 **Event added!**

📌 ${title}  
📅 ${formatDate(start)}  
🕒 ${formatTime(start)} – ${formatTime(end)}
`;
}

/* ----------------------------------------------------------
   FORMATTING HELPERS
---------------------------------------------------------- */
function formatDate(date) {
  return new Date(date).toLocaleDateString("en-ZA", {
    timeZone: TIMEZONE,
  });
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });
}




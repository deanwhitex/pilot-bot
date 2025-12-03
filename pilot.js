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

// ----------------------------------------------------------
// Helper: Convert user text into structured intent
// ----------------------------------------------------------
async function interpretMessage(message) {
  const prompt = `
You are Dean's friendly scheduling assistant.

You MUST respond in JSON ONLY:

{
  "intent": "",
  "date": "",
  "duration": "",
  "title": "",
  "range_start": "",
  "range_end": ""
}

Possible intents:
- "day_summary" → What's on my schedule for X day
- "find_free_time" → Find open slots
- "create_event" → Add an event automatically
- "range_summary" → What's my week/month look like
- "unknown" → Cannot detect

Rules:
- If the user asks to "add", "schedule", or "book" → intent = "create_event"
- Default event duration = 60 minutes
- If user mentions "open slot", "free time" → intent = "find_free_time"
- If user asks "what's on" with a specific day/date → intent = "day_summary"
- If user mentions a week/month → intent = "range_summary"
- Dates should be converted to ISO format if possible
- Always be friendly in your interpretation

User message: "${message}"
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

// ----------------------------------------------------------
// Main scheduling logic
// ----------------------------------------------------------
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

// ----------------------------------------------------------
// DAY SUMMARY
// ----------------------------------------------------------
async function handleDaySummary({ date }) {
  if (!date) return "Which date should I check for you? 😊";

  const events = await getEventsForDate(new Date(date));

  if (events.length === 0) {
    return `Looks like your schedule is *wide open* on **${formatDate(
      date
    )}** 😎`;
  }

  let out = `Here's what you have on **${formatDate(date)}**:\n\n`;

  for (const ev of events) {
    out += `• **${ev.summary}** — ${formatTime(ev.start.dateTime)} to ${formatTime(
      ev.end.dateTime
    )}\n`;
  }

  return out;
}

// ----------------------------------------------------------
// RANGE SUMMARY (week/month)
// ----------------------------------------------------------
async function handleRangeSummary({ range_start, range_end }) {
  if (!range_start || !range_end)
    return "Which dates should I check for you?";

  const events = await getEventsForRange(
    new Date(range_start),
    new Date(range_end)
  );

  if (events.length === 0) {
    return `Looks like you're free between ${formatDate(
      range_start
    )} and ${formatDate(range_end)}! 🎉`;
  }

  let out = `Here’s everything between **${formatDate(
    range_start
  )}** and **${formatDate(range_end)}**:\n\n`;

  for (const ev of events) {
    out += `• **${ev.summary}** — ${formatDate(ev.start.dateTime)} (${formatTime(
      ev.start.dateTime
    )}–${formatTime(ev.end.dateTime)})\n`;
  }

  return out;
}

// ----------------------------------------------------------
// OPEN SLOT FINDER
// ----------------------------------------------------------
async function handleFindFree({ date, duration }) {
  if (!date) return "What date should I help you find free time on? 😊";
  const dur = duration ? parseInt(duration) : 60;

  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return `No open ${dur}-minute slots on **${formatDate(date)}** 😕`;
  }

  let out = `Here are your available ${dur}-minute slots on **${formatDate(
    date
  )}**:\n\n`;

  for (const s of slots) {
    out += `• ${formatTime(s.start)} to ${formatTime(s.end)}\n`;
  }

  return out;
}

// ----------------------------------------------------------
// EVENT CREATION
// ----------------------------------------------------------
async function handleCreateEvent({ title, date }) {
  if (!title) return "What should I call this event? 😊";
  if (!date) return "Which date should I schedule this on?";

  // Default = 60 minutes
  const start = new Date(date);
  const end = new Date(start.getTime() + 60 * 60000);

  const event = await createEvent({ title, start, end });

  return `All set! 🎉  
I added **${title}** on **${formatDate(
    start
  )}**, from ${formatTime(start)} to ${formatTime(end)}.`;
}

// ----------------------------------------------------------
// Formatting Helpers
// ----------------------------------------------------------
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


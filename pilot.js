// -----------------------------------------------------------------------------
// pilot.js — Full Chief-of-Staff Brain for Pilot
// -----------------------------------------------------------------------------

import OpenAI from "openai";
import fs from "fs";

import {
  getEventsForDate,
  getEventsForRange,
  findOpenSlots,
  createEvent,
  cancelEventById,
  rescheduleEventById,
  searchEventsByText
} from "./calendar.js";



// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const TIMEZONE = "Africa/Johannesburg";

const MIN_HOUR = 8;
const MAX_HOUR = 22;

const DEFAULT_DURATION_MIN = 60;

const MEMORY_FILE = "./memory.json";



// -----------------------------------------------------------------------------
// MEMORY ENGINE — Patterns, Preferences, Mood
// -----------------------------------------------------------------------------

let memory = {
  preferences: {
    avoid_early_mornings: true,
    preferred_gym_time: "afternoon",
    meeting_buffer_min: 10
  },

  patterns: {
    gym_time: { morning: 0.1, afternoon: 0.8, evening: 0.1 },
    focus_productivity: { morning: 0.6, afternoon: 0.4 }
  },

  energy_profile: {
    morning: "medium",
    afternoon: "high",
    evening: "low"
  }
};

try {
  if (fs.existsSync(MEMORY_FILE)) {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    console.log("Memory loaded.");
  }
} catch (err) {
  console.error("Memory load error:", err);
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}



// -----------------------------------------------------------------------------
// OPENAI CLIENT
// -----------------------------------------------------------------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});



// -----------------------------------------------------------------------------
// INTENT DETECTION (used by index.js to filter non-scheduling chatter)
// -----------------------------------------------------------------------------

export async function detectIntentType(message) {
  const schedulingWords = [
    "schedule",
    "book",
    "add",
    "what's on",
    "cancel",
    "move",
    "reschedule",
    "free time",
    "slot",
    "appointment",
    "meeting",
    "plan my week",
    "plan my day",
    "help me plan"
  ];

  return schedulingWords.some((w) =>
    message.toLowerCase().includes(w)
  );
}



// -----------------------------------------------------------------------------
// FULL INTENT PARSER
// Zero hallucination guarantees for scheduling
// -----------------------------------------------------------------------------

async function interpretMessage(message) {
  const prompt = `
You are Pilot, Dean’s AI Chief-of-Staff.

Convert his message into STRICT JSON:

{
  "intent": "",
  "title": "",
  "date": "",
  "start_time": "",
  "end_time": "",
  "duration": "",
  "range_start": "",
  "range_end": "",
  "target_event": ""
}

Valid intents:
- "day_summary"
- "range_summary"
- "find_free_time"
- "create_event"
- "cancel_event"
- "reschedule_event"
- "plan_day"
- "plan_week"
- "life_advice"
- "assistant_chat"
- "unknown"

Rules:
- “Plan my week” → intent = plan_week
- “Cancel …” → intent = cancel_event
- “Move / reschedule …” → intent = reschedule_event
- “Add / book / schedule …” → intent = create_event
- If no scheduling words → assistant_chat
- NEVER guess events. NEVER invent schedules. NEVER hallucinate.
- If you cannot extract a field → use empty string.
- Output ONLY valid JSON.

USER MESSAGE:
"${message}"
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "user", content: prompt }
    ]
  });

  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return { intent: "unknown" };
  }
}



// -----------------------------------------------------------------------------
// MAIN ROUTER
// -----------------------------------------------------------------------------

export async function handleUserMessage(message) {
  const intent = await interpretMessage(message);

  // Update mood / preferences based on conversation
  detectMood(message);

  switch (intent.intent) {

    case "assistant_chat":
      return conversationalReply(message);

    case "plan_week":
      return startWeeklyPlanning();

    case "cancel_event":
      return await handleCancel(intent);

    case "reschedule_event":
      return await handleReschedule(intent);

    case "create_event":
      return await handleCreateEvent(intent);

    case "find_free_time":
      return await handleFindFree(intent);

    case "day_summary":
      return await handleDaySummary(intent.date);

    case "range_summary":
      return await handleRangeSummary(intent.range_start, intent.range_end);

    case "plan_day":
      return planMyDay(intent.date);

    case "life_advice":
      return await lifeAdvice(message);

    default:
      return "I'm not entirely sure what you mean, but I'm here to help. 😊";
  }
}



// -----------------------------------------------------------------------------
// GENERAL CHAT MODE
// -----------------------------------------------------------------------------

function conversationalReply(message) {
  return `Of course, Dean — ${message}`;
}



// -----------------------------------------------------------------------------
// MOOD + BEHAVIOR TRACKING
// -----------------------------------------------------------------------------

function detectMood(message) {
  const m = message.toLowerCase();

  if (m.includes("tired") || m.includes("exhausted")) {
    memory.energy_profile.afternoon = "lower";
    saveMemory();
  }

  if (m.includes("stress") || m.includes("overwhelmed")) {
    memory.preferences.avoid_early_mornings = true;
    saveMemory();
  }
}



// -----------------------------------------------------------------------------
// CANCEL EVENT
// -----------------------------------------------------------------------------

async function handleCancel({ target_event }) {
  if (!target_event) return "Which event should I cancel?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) {
    return `I couldn't find anything matching "${target_event}".`;
  }

  if (matches.length === 1) {
    await cancelEventById(matches[0].calendarId, matches[0].id);
    return `🗑️ Done — I cancelled **${matches[0].summary}** at ${formatTime(matches[0].start.dateTime)}.`;
  }

  let out = "I found multiple matching events:\n\n";

  matches.forEach((m, i) => {
    out += `${i + 1}. **${m.summary}** — ${formatDate(m.start.dateTime)}, ${formatTime(m.start.dateTime)}\n`;
  });

  out += "\nReply with the number to cancel.";

  return out;
}



// -----------------------------------------------------------------------------
// RESCHEDULE EVENT
// -----------------------------------------------------------------------------

async function handleReschedule({ target_event, date, start_time }) {
  if (!target_event) return "Which event should I reschedule?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) {
    return "I couldn't find that event.";
  }

  if (matches.length > 1) {
    let out = "I found several events. Which one should I move?\n\n";

    matches.forEach((m, i) => {
      out += `${i + 1}. **${m.summary}** — ${formatDate(m.start.dateTime)} at ${formatTime(m.start.dateTime)}\n`;
    });

    return out;
  }

  const event = matches[0];

  // Suggest three new times if no time was given
  if (!start_time) {
    const baseDate = date || event.start.dateTime;

    const suggestions = await findOpenSlots(baseDate, 60, 3);

    if (suggestions.length === 0) {
      return "I couldn't find any good alternative times that day.";
    }

    let out = `Here are good options for **${event.summary}**:\n\n`;

    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });

    out += "\nReply with the number you prefer.";

    return out;
  }

  // Reschedule to a specific time
  const newStart = new Date(`${date}T${start_time}`);
  const newEnd = new Date(newStart.getTime() + 60 * 60000);

  await rescheduleEventById(event.calendarId, event.id, newStart, newEnd);

  return `🔄 Done — I’ve moved **${event.summary}** to ${formatTime(newStart)}.`;
}



// -----------------------------------------------------------------------------
// CREATE EVENT
// -----------------------------------------------------------------------------

async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call the event?";
  if (!date) return "Which date should I schedule it on?";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  // Suggest times if none specified
  if (!start_time) {
    const suggestions = await findOpenSlots(date, dur, 3);

    if (suggestions.length === 0) {
      return "I couldn’t find any available times that day.";
    }

    let out = `Here are available times for **${title}**:\n\n`;

    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });

    out += "\nReply with 1, 2, or 3 to book.";

    return out;
  }

  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return "That time is outside your preferred scheduling hours (08:00–22:00).";
  }

  await createEvent({ title, start, end });

  return `🎉 Done — I added **${title}** for ${formatDate(start)} at ${formatTime(start)}.`;
}



// -----------------------------------------------------------------------------
// FIND FREE TIME
// -----------------------------------------------------------------------------

async function handleFindFree({ date, duration }) {
  const dur = duration || DEFAULT_DURATION_MIN;

  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return "No free time that day.";
  }

  let out = `Here are your available ${dur}-minute slots:\n\n`;

  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}



// -----------------------------------------------------------------------------
// DAY SUMMARY
// -----------------------------------------------------------------------------

async function handleDaySummary(date) {
  if (!date) return "Which date should I check?";

  const events = await getEventsForDate(date);

  if (events.length === 0) {
    return `You’re free on **${formatDate(date)}**. 😎`;
  }

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary}** — ${formatTime(ev.start.dateTime)}\n`;
  });

  return out;
}



// -----------------------------------------------------------------------------
// RANGE SUMMARY
// -----------------------------------------------------------------------------

async function handleRangeSummary(start, end) {
  const events = await getEventsForRange(start, end);

  if (events.length === 0) {
    return `No events between ${formatDate(start)} and ${formatDate(end)}.`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(end)}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary}** — ${formatDate(ev.start.dateTime)} (${formatTime(ev.start.dateTime)})\n`;
  });

  return out;
}



// -----------------------------------------------------------------------------
// WEEKLY PLAN MODE
// -----------------------------------------------------------------------------

function startWeeklyPlanning() {
  return `
🧠 **Weekly Planning Activated**

Great, Dean. Let’s get ahead of your week.

I will consider:
• workload  
• gym patterns  
• energy profile  
• personal boundaries  
• deep work needs  
• meetings  
• rest periods  

Tell me:
- **"Plan my week with priorities"**  
- **"Plan my week around energy"**  
- **"Build a balanced week"**  
`;
}



// -----------------------------------------------------------------------------
// PLAN MY DAY (High-level guidance)
// -----------------------------------------------------------------------------

function planMyDay(date) {
  return `
🗓️ **Daily Planning**

Alright Dean, let’s plan ${date} intelligently.

Tell me:
- "Focus morning"  
- "Stack meetings"  
- "Light workload"  
- "Balance the day"  
`;
}



// -----------------------------------------------------------------------------
// LIFE ADVICE MODE
// -----------------------------------------------------------------------------

async function lifeAdvice(message) {
  const prompt = `
You are Dean’s AI Chief-of-Staff.

He said: "${message}"

Respond with:
- elite strategic insight  
- friendly tone  
- actionable advice  
- short & sharp guidance  
  `;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "user", content: prompt }
    ]
  });

  return response.choices[0].message.content;
}



// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

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



// -----------------------------------------------------------------------------
// END — pilot.js
// -----------------------------------------------------------------------------







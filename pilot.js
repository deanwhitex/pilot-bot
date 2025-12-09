// pilot.js
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

const TIMEZONE = "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;
const DEFAULT_DURATION_MIN = 60;

// ---------------------------------------------------------
// MEMORY SYSTEM (local memory.json)
// ---------------------------------------------------------
const MEMORY_FILE = "./memory.json";

let memory = {
  preferences: {
    avoid_early_mornings: true,
    preferred_gym_time: "afternoon",
    meeting_buffer_min: 10
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
    console.log("🧠 Memory loaded.");
  }
} catch (err) {
  console.error("Memory load error:", err);
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ---------------------------------------------------------
// OPENAI
// ---------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------
// INTENT DETECTOR FOR index.js (route filter)
// ---------------------------------------------------------
export function detectIntentType(message) {
  const schedulingTriggers = [
    "schedule",
    "add",
    "book",
    "cancel",
    "move",
    "reschedule",
    "appointment",
    "event",
    "what's on",
    "free time",
    "open slot",
    "plan my week",
    "plan my day"
  ];

  return schedulingTriggers.some((x) =>
    message.toLowerCase().includes(x)
  );
}

// ---------------------------------------------------------
// FULL AI PARSER
// ---------------------------------------------------------
async function interpretMessage(message) {
  const prompt = `
You are Dean’s AI Chief-of-Staff.
Interpret his message and output STRICT JSON:

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

INTENTS:
- "assistant_chat"
- "day_summary"
- "range_summary"
- "find_free_time"
- "create_event"
- "cancel_event"
- "reschedule_event"
- "plan_week"
- "plan_day"
- "life_advice"
- "unknown"

RULES:
- If he says “cancel”, → cancel_event
- “move/reschedule” → reschedule_event
- “week/month/between” → range_summary
- “free time/open slot” → find_free_time
- “add/book/schedule” → create_event
- If no scheduling meaning → assistant_chat
- Keep JSON valid.
- No text outside JSON.
  
User message:
"${message}"
  `;

  const out = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0
  });

  try {
    return JSON.parse(out.choices[0].message.content);
  } catch {
    return { intent: "unknown" };
  }
}

// ---------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------
export async function handleUserMessage(message) {
  detectMood(message); // update memory if needed
  const intent = await interpretMessage(message);

  switch (intent.intent) {
    case "assistant_chat":
      return conversationalReply(message);

    case "life_advice":
      return lifeAdvice(message);

    case "plan_week":
      return weeklyPlanningMessage();

    case "plan_day":
      return planMyDay(intent.date);

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

    default:
      return "I’m not entirely sure what you mean, but I’m here to help. 😊";
  }
}

// ---------------------------------------------------------
// GREETING / CONVERSATIONAL MODE
// ---------------------------------------------------------
function conversationalReply(message) {
  return `Sure Dean — ${message}`;
}

// ---------------------------------------------------------
// MOOD & PATTERN DETECTION
// ---------------------------------------------------------
function detectMood(message) {
  const m = message.toLowerCase();

  if (m.includes("tired") || m.includes("exhausted")) {
    memory.energy_profile.morning = "low";
    saveMemory();
  }

  if (m.includes("stressed") || m.includes("overwhelmed")) {
    memory.preferences.avoid_early_mornings = true;
    saveMemory();
  }
}

// ---------------------------------------------------------
// CANCEL EVENT
// ---------------------------------------------------------
async function handleCancel({ target_event }) {
  if (!target_event) return "Which event should I cancel?";

  const matches = await searchEventsByText(target_event);
  if (matches.length === 0) return "I couldn’t find that event.";

  if (matches.length === 1) {
    await cancelEventById(matches[0].calendarId, matches[0].id);
    return `🗑️ Cancelled **${matches[0].summary}** at ${formatTime(
      matches[0].start.dateTime
    )}.`;
  }

  let out = "I found multiple events:\n\n";
  matches.forEach((m, i) => {
    out += `${i + 1}. **${m.summary}** — ${formatTime(
      m.start.dateTime
    )}\n`;
  });

  return out + "\nReply 1, 2, or 3 to pick.";
}

// ---------------------------------------------------------
// RESCHEDULE EVENT
// ---------------------------------------------------------
async function handleReschedule({ target_event, date, start_time }) {
  if (!target_event) return "Which event should I move?";

  const matches = await searchEventsByText(target_event);
  if (matches.length === 0) return "I couldn’t find that event.";

  if (matches.length > 1) {
    let out = "I found several matching events:\n\n";
    matches.forEach((m, i) => {
      out += `${i + 1}. **${m.summary}** (${formatDate(
        m.start.dateTime
      )} at ${formatTime(m.start.dateTime)})\n`;
    });
    return out + "\nWhich one should I reschedule?";
  }

  const ev = matches[0];

  if (!start_time) {
    const suggestions = await findOpenSlots(date, 60, 3);

    if (suggestions.length === 0)
      return "No good times found that day. Try another date?";

    let out = `Here are good options for **${ev.summary}**:\n\n`;
    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(
        s.end
      )}\n`;
    });

    return out + "\nChoose 1–3.";
  }

  const newStart = new Date(`${date}T${start_time}`);
  const newEnd = new Date(newStart.getTime() + 60 * 60000);

  await rescheduleEventById(ev.calendarId, ev.id, newStart, newEnd);

  return `🔄 Rescheduled **${ev.summary}** to ${formatTime(newStart)}.`;
}

// ---------------------------------------------------------
// CREATE EVENT
// ---------------------------------------------------------
async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call this event?";
  if (!date) return "Which date?";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  // No time → suggest options
  if (!start_time) {
    const slots = await findOpenSlots(date, dur, 3);

    if (slots.length === 0)
      return "No available slots that day — check another?";

    let out = `Here are available times for **${title}**:\n\n`;
    slots.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });

    return out + "\nChoose 1–3.";
  }

  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return "That time is outside your usual working hours (08:00–22:00).";
  }

  await createEvent({ title, start, end });

  return `🎉 Added **${title}** on ${formatDate(start)} at ${formatTime(
    start
  )}.`;
}

// ---------------------------------------------------------
// FREE TIME FINDER
// ---------------------------------------------------------
async function handleFindFree({ date, duration }) {
  const dur = duration || DEFAULT_DURATION_MIN;

  const slots = await findOpenSlots(date, dur);
  if (slots.length === 0)
    return "No free time on that day 😕";

  let out = `Here are your open ${dur}-minute slots:\n\n`;
  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

// ---------------------------------------------------------
// DAY SUMMARY
// ---------------------------------------------------------
async function handleDaySummary(date) {
  if (!date) return "Which date?";

  const events = await getEventsForDate(date);

  if (events.length === 0)
    return `You're completely free on **${formatDate(date)}** 😎`;

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary}** — ${formatTime(ev.start.dateTime)}\n`;
  });

  return out;
}

// ---------------------------------------------------------
// RANGE SUMMARY
// ---------------------------------------------------------
async function handleRangeSummary(start, end) {
  const events = await getEventsForRange(start, end);

  if (events.length === 0)
    return `No events between ${formatDate(start)} and ${formatDate(end)}.`;

  let out = `📆 **${formatDate(start)} to ${formatDate(end)}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary}** (${formatDate(ev.start.dateTime)} — ${formatTime(
      ev.start.dateTime
    )})\n`;
  });

  return out;
}

// ---------------------------------------------------------
// WEEKLY PLANNING ENTRY POINT
// ---------------------------------------------------------
function weeklyPlanningMessage() {
  return `
🧭 **Weekly Planning Mode**

Great Dean — let's build your week.

Tell me one of these:

• **Plan my week with priorities**  
• **Plan my week around energy**  
• **Build a balanced week**

I’ll integrate:
- Workload  
- Energy profile  
- Gym habits  
- Meetings  
- Rest time  
- Boundaries  
- Productivity windows  
`;
}

// ---------------------------------------------------------
// LIFE ADVICE (Chief-of-Staff mode)
// ---------------------------------------------------------
async function lifeAdvice(message) {
  const prompt = `
You are Dean’s Chief-of-Staff and personal strategist.

He said:
"${message}"

Reply with:
- Confidence  
- Strategic clarity  
- Emotional intelligence  
- Practical action steps  
- No fluff  
  `;

  const out = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return out.choices[0].message.content;
}

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------
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






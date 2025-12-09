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
  searchEventsByText,
} from "./calendar.js";

// -----------------------------------------------
// CONSTANTS
// -----------------------------------------------
const TIMEZONE = "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;
const DEFAULT_DURATION_MIN = 60;
const MEMORY_FILE = "./memory.json";

// -----------------------------------------------
// LOAD LOCAL MEMORY
// -----------------------------------------------
let memory = {
  preferences: {
    avoid_early_mornings: true,
    preferred_gym_time: "afternoon",
    meeting_buffer_min: 10,
  },
  patterns: {
    gym_time: { morning: 0.1, afternoon: 0.8, evening: 0.1 },
    focus_productivity: { morning: 0.6, afternoon: 0.4 },
  },
  energy_profile: {
    morning: "medium",
    afternoon: "high",
    evening: "low",
  },
};

// Load memory.json if exists
try {
  if (fs.existsSync(MEMORY_FILE)) {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    console.log("Memory loaded.");
  }
} catch (err) {
  console.error("Memory load error:", err);
}

// Save memory.json
function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// -----------------------------------------------
// OPENAI CLIENT
// -----------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -----------------------------------------------
// INTENT DETECTION (for index.js to filter messages)
// -----------------------------------------------
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
    "help me plan",
  ];

  return schedulingWords.some((w) => message.toLowerCase().includes(w));
}

// -----------------------------------------------
// FULL INTENT PARSER
// -----------------------------------------------
async function interpretMessage(message) {
  const prompt = `
You are Dean’s AI Chief-of-Staff. Convert his message to strict JSON:

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

INTENT OPTIONS:
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

RULES:
- If Dean says "plan my week" → intent = plan_week
- If he says "cancel" → intent = cancel_event
- If he says "move"/"reschedule" → intent = reschedule_event
- If no clear scheduling intent → intent = assistant_chat

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
  } catch {
    return { intent: "unknown" };
  }
}

// -----------------------------------------------
// MAIN ROUTER
// -----------------------------------------------
export async function handleUserMessage(message) {
  const intent = await interpretMessage(message);

  // Mood & pattern updates
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
      return lifeAdvice(message);

    default:
      return "I'm not entirely sure what you mean, but I’m here to help. 😊";
  }
}

// -----------------------------------------------
// GREETING / CHAT MODE
// -----------------------------------------------
function conversationalReply(message) {
  return `Of course, Dean — ${message}`;
}

// -----------------------------------------------
// MOOD DETECTION
// -----------------------------------------------
function detectMood(message) {
  const text = message.toLowerCase();

  if (text.includes("tired") || text.includes("exhausted")) {
    memory.energy_profile.afternoon = "lower";
    saveMemory();
  }

  if (text.includes("stressed") || text.includes("overwhelmed")) {
    memory.preferences.avoid_early_mornings = true;
    saveMemory();
  }
}

// -----------------------------------------------
// CANCELLATION ENGINE
// -----------------------------------------------
async function handleCancel({ target_event }) {
  if (!target_event) return "Which event should I cancel?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) {
    return `I couldn't find anything matching "${target_event}".`;
  }

  if (matches.length === 1) {
    await cancelEventById(matches[0].calendarId, matches[0].id);
    return `🗑️ Done — I cancelled **${matches[0].summary}** at ${formatTime(
      matches[0].start.dateTime
    )}.`;
  }

  let out = "I found multiple matches:\n\n";
  matches.forEach((m, i) => {
    out += `${i + 1}. **${m.summary}** — ${formatTime(
      m.start.dateTime
    )}\n`;
  });
  out += "\nReply with the number you want me to cancel.";

  return out;
}

// -----------------------------------------------
// RESCHEDULING ENGINE (Hybrid Mode)
// -----------------------------------------------
async function handleReschedule({ target_event, date, start_time }) {
  if (!target_event) return "Which event should I reschedule?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) return "I couldn’t find that event.";

  if (matches.length > 1) {
    let out = "I found several events. Which one should I move?\n\n";
    matches.forEach((m, i) => {
      out += `${i + 1}. **${m.summary}** — ${formatDate(
        m.start.dateTime
      )}, ${formatTime(m.start.dateTime)}\n`;
    });
    return out;
  }

  const event = matches[0];

  // No time given — suggest 3 options
  if (!start_time) {
    const suggestions = await findOpenSlots(date || event.start.dateTime, 60, 3);

    if (suggestions.length === 0) {
      return "No good times found that day. Want me to check another day?";
    }

    let out = `Here are good options for moving **${event.summary}**:\n\n`;
    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    out += "\nReply with the number you prefer.";

    return out;
  }

  // Move to exact new time
  const newStart = new Date(`${date}T${start_time}`);
  const newEnd = new Date(newStart.getTime() + 60 * 60000);

  await rescheduleEventById(event.calendarId, event.id, newStart, newEnd);

  return `🔄 All set — I’ve rescheduled **${event.summary}** to ${formatTime(
    newStart
  )}.`;
}

// -----------------------------------------------
// CREATE EVENT
// -----------------------------------------------
async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call this event?";
  if (!date) return "Which date should I schedule it on?";

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  if (!start_time) {
    const suggestions = await findOpenSlots(date, dur, 3);

    if (suggestions.length === 0) {
      return "No available slots that day — want me to check another day?";
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
    return "That time is outside your preferred hours (08:00–22:00).";
  }

  await createEvent({ title, start, end });

  return `🎉 Done — I’ve added **${title}** from ${formatTime(
    start
  )} to ${formatTime(end)}.`;
}

// -----------------------------------------------
// FREE TIME FINDER
// -----------------------------------------------
async function handleFindFree({ date, duration }) {
  const dur = duration || DEFAULT_DURATION_MIN;
  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return "No free time that day 😕";
  }

  let out = `Here are your open ${dur}-minute slots:\n\n`;
  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

// -----------------------------------------------
// DAY SUMMARY
// -----------------------------------------------
async function handleDaySummary(date) {
  const events = await getEventsForDate(date);

  if (events.length === 0)
    return `You’re free on **${formatDate(date)}** 😎`;

  let out = `📅 **Your schedule for ${formatDate(date)}:**\n\n`;
  events.forEach((ev) => {
    out += `• **${ev.summary}** — ${formatTime(
      ev.start.dateTime
    )}\n`;
  });

  return out;
}

// -----------------------------------------------
// RANGE SUMMARY
// -----------------------------------------------
async function handleRangeSummary(start, end) {
  const events = await getEventsForRange(start, end);

  if (events.length === 0)
    return `No events between ${formatDate(start)} and ${formatDate(end)}.`;

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(
    end
  )}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary}** (${formatDate(ev.start.dateTime)} — ${formatTime(
      ev.start.dateTime
    )})\n`;
  });

  return out;
}

// -----------------------------------------------
// WEEKLY PLANNING
// -----------------------------------------------
function startWeeklyPlanning() {
  return `
🧠 **Weekly Planning**

Great, Dean. Let's plan your week strategically.

I’ll look at:
• Workload  
• Energy profile  
• Gym patterns  
• Personal time  
• Focus sessions  
• Meetings  
• Boundaries  

Tell me:
**“Plan my week with priorities”**
or  
**“Plan my week around energy”**
or  
**“Build a balanced week”**
`;
}

// -----------------------------------------------
// LIFE ADVICE + PERSONAL ASSISTANT MODE
// -----------------------------------------------
async function lifeAdvice(message) {
  const prompt = `
You are Dean’s AI Chief-of-Staff.  
He said: "${message}"

Reply with:
- Friendly tone
- Efficient advice
- Strategic insight
- Encouraging but confident
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return completion.choices[0].message.content;
}

// -----------------------------------------------
// HELPERS
// -----------------------------------------------
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






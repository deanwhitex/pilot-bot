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
// CONFIG & CONSTANTS
// -----------------------------------------------
const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const MIN_HOUR = 8; // earliest “human” time
const MAX_HOUR = 22; // latest “human” time
const DEFAULT_DURATION_MIN = 60;
const MEMORY_FILE = "./memory.json";

// -----------------------------------------------
// SIMPLE MEMORY (LOCAL FILE)
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

try {
  if (fs.existsSync(MEMORY_FILE)) {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    console.log("🧠 Memory loaded.");
  }
} catch (err) {
  console.error("Memory load error:", err);
}

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error("Memory save error:", err);
  }
}

// -----------------------------------------------
// OPENAI CLIENT
// -----------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -----------------------------------------------
// TINY CONVERSATION STATE FOR NUMBERED CHOICES
// -----------------------------------------------
/**
 * Shape:
 * {
 *   type: "create_event_slots" | "cancel_event_choices",
 *   ...extra
 * }
 */
let pendingChoice = null;

// -----------------------------------------------
// LIGHTWEIGHT INTENT DETECTION (for index.js filters)
// -----------------------------------------------
export async function detectIntentType(message) {
  const schedulingWords = [
    "schedule",
    "book",
    "add",
    "what's on",
    "whats on",
    "cancel",
    "delete",
    "move",
    "reschedule",
    "free time",
    "slot",
    "appointment",
    "meeting",
    "plan my week",
    "plan my day",
    "help me plan",
    "calendar",
  ];

  const lower = message.toLowerCase();
  return schedulingWords.some((w) => lower.includes(w));
}

// -----------------------------------------------
// FULL INTENT PARSER (LLM → structured JSON)
// -----------------------------------------------
async function interpretMessage(message) {
  const prompt = `
You are Dean’s AI Chief-of-Staff and calendar assistant.

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

INTENT OPTIONS:
- "day_summary"        // what's on my schedule for X day
- "range_summary"      // week/month overview
- "find_free_time"     // find open slots
- "create_event"       // add / book / schedule something
- "cancel_event"       // cancel / delete a meeting
- "reschedule_event"   // move / reschedule a meeting
- "plan_day"           // help plan my day
- "plan_week"          // help plan my week
- "life_advice"        // general life / mindset / productivity question
- "assistant_chat"     // small talk or general chat
- "unknown"

RULES:
- “what's on”, “what is on”, “my schedule”, “my calendar” → "day_summary" (if a specific day is mentioned, map it to "date")
- “this week”, “next week”, “this month”, “next month” → "range_summary" with range_start / range_end
- “add”, “book”, “schedule”, “put”, “create”, “block time” → "create_event"
- “cancel”, “delete”, “remove” → "cancel_event" with target_event text
- “move”, “reschedule”, “shift” → "reschedule_event" with target_event
- “free time”, “open slot”, “when can I”, “when am I free” → "find_free_time"
- “plan my day”, “plan today” → "plan_day"
- “plan my week”, “weekly plan” → "plan_week"
- If it's more about motivation, productivity, feelings, life advice → "life_advice"
- Otherwise, use "assistant_chat"

DATES:
- Convert natural phrases like “today”, “tomorrow”, “Thursday”, “next week” into ISO dates or date ranges **when possible**.
- date, range_start, and range_end should be "YYYY-MM-DD" when you can infer them.
- duration should be minutes if provided (stringified number like "60").
- If unsure about any field, leave it as an empty string.

Return ONLY the JSON object, no explanation or extra text.

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
  const trimmed = message.trim();

  // 1–9 numeric reply while we have a pending choice
  if (/^[1-9]\d*$/.test(trimmed) && pendingChoice) {
    const choice = parseInt(trimmed, 10);
    return await handleNumericReply(choice);
  }

  const intent = await interpretMessage(message);

  // Mood & preference tweaks
  detectMood(message);

  switch (intent.intent) {
    case "assistant_chat":
      return conversationalReply(message);

    case "plan_week":
      return startWeeklyPlanning();

    case "plan_day":
      return await planMyDay(intent.date);

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

    case "life_advice":
      return await lifeAdvice(message);

    default:
      return "I'm not entirely sure what you mean, but I’m here to help. 😊";
  }
}

// -----------------------------------------------
// HANDLE NUMERIC REPLIES (1 / 2 / 3 etc.)
// -----------------------------------------------
async function handleNumericReply(choice) {
  const ctx = pendingChoice;
  // Clear immediately so we don't reuse accidentally
  pendingChoice = null;

  if (!ctx) {
    return "I wasn’t expecting a numbered choice right now, Dean. Tell me what you’d like to change or plan. 😊";
  }

  switch (ctx.type) {
    case "create_event_slots": {
      const slot = ctx.slots[choice - 1];
      if (!slot) {
        return "That number doesn’t match any of the options I gave you. Please reply with one of the listed numbers.";
      }

      await createEvent({
        title: ctx.title,
        start: slot.start,
        end: slot.end,
      });

      return `🎉 Done — I’ve added **${ctx.title}** on **${formatDate(
        slot.start
      )}**, from ${formatTime(slot.start)} to ${formatTime(slot.end)}.`;
    }

    case "cancel_event_choices": {
      const ev = ctx.matches[choice - 1];
      if (!ev) {
        return "That number doesn’t match any of the options I gave you. Please reply with one of the listed numbers.";
      }

      await cancelEventById(ev.calendarId, ev.id);

      const startRaw = ev.start.dateTime || ev.start.date;
      return `🗑️ Done — I cancelled **${ev.summary}** on **${formatDate(
        startRaw
      )}** at ${formatTime(startRaw)}.`;
    }

    default:
      return "I wasn’t expecting a numbered choice there, but I’m here to help! Tell me what you’d like to change or plan. 😊";
  }
}

// -----------------------------------------------
// GREETING / CHAT MODE
// -----------------------------------------------
function conversationalReply(message) {
  return `Sure Dean — what can I help you with? 😊`;
}

// -----------------------------------------------
// MOOD / PREFERENCE TWEAKS (very light)
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
    return `I couldn't find anything matching "${target_event}" in the next few weeks.`;
  }

  if (matches.length === 1) {
    const ev = matches[0];
    await cancelEventById(ev.calendarId, ev.id);
    const startRaw = ev.start.dateTime || ev.start.date;

    return `🗑️ Done — I cancelled **${ev.summary}** on **${formatDate(
      startRaw
    )}** at ${formatTime(startRaw)}.`;
  }

  // Multiple possible matches → store them and ask for number
  pendingChoice = {
    type: "cancel_event_choices",
    matches,
  };

  let out = "I found several events that might match:\n\n";
  matches.forEach((m, i) => {
    const startRaw = m.start.dateTime || m.start.date;
    out += `${i + 1}. **${m.summary}** — ${formatDate(
      startRaw
    )}, ${formatTime(startRaw)}\n`;
  });
  out += "\nReply with the **number** of the one you want me to cancel.";

  return out;
}

// -----------------------------------------------
// RESCHEDULING ENGINE (simple version)
// -----------------------------------------------
async function handleReschedule({ target_event, date, start_time }) {
  if (!target_event) return "Which event should I reschedule?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) return "I couldn’t find that event in your upcoming schedule.";

  if (matches.length > 1) {
    let out = "I found several events. Which one should I move?\n\n";
    matches.forEach((m, i) => {
      const startRaw = m.start.dateTime || m.start.date;
      out += `${i + 1}. **${m.summary}** — ${formatDate(
        startRaw
      )}, ${formatTime(startRaw)}\n`;
    });
    out += "\nReply with the number and then tell me the new time (this part is still simple).";
    return out;
  }

  const event = matches[0];

  if (!date || !start_time) {
    const startRaw = event.start.dateTime || event.start.date;
    return `You want to move **${event.summary}** on **${formatDate(
      startRaw
    )}**. What date and time should I move it to?`;
  }

  const newStart = new Date(`${date}T${start_time}`);
  const newEnd = new Date(newStart.getTime() + 60 * 60000);

  await rescheduleEventById(event.calendarId, event.id, newStart, newEnd);

  return `🔄 All set — I’ve rescheduled **${event.summary}** to **${formatDate(
    newStart
  )}** at ${formatTime(newStart)}.`;
}

// -----------------------------------------------
// CREATE EVENT (smart slots + human hours)
// -----------------------------------------------
async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call this event? 😊";
  if (!date) return "Which date should I schedule it on?";

  const dur = duration ? parseInt(duration, 10) : DEFAULT_DURATION_MIN;

  // If NO explicit time → suggest top 3 slots and wait for 1/2/3
  if (!start_time) {
    const suggestions = await findOpenSlots(date, dur, 3);

    if (suggestions.length === 0) {
      return `I couldn't find any good ${dur}-minute slots on **${formatDate(
        date
      )}**. Want me to check another day?`;
    }

    pendingChoice = {
      type: "create_event_slots",
      title,
      date,
      duration: dur,
      slots: suggestions,
    };

    let out = `Here are some good options for **${title}** on **${formatDate(
      date
    )}**:\n\n`;
    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    out += "\nReply with **1, 2, or 3** and I’ll book it.";

    return out;
  }

  // If time was given → just create it
  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return "That time is outside your usual hours (08:00–22:00). Pick another time and I’ll book it. 😊";
  }

  await createEvent({ title, start, end });

  return `🎉 Done — I’ve added **${title}** on **${formatDate(
    start
  )}**, from ${formatTime(start)} to ${formatTime(end)}.`;
}

// -----------------------------------------------
// FREE TIME FINDER
// -----------------------------------------------
async function handleFindFree({ date, duration }) {
  if (!date) return "Which date should I check for free time? 😊";

  const dur = duration ? parseInt(duration, 10) : DEFAULT_DURATION_MIN;
  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return `No free **${dur}-minute** slots on **${formatDate(
      date
    )}** 😕 Want me to check another day?`;
  }

  let out = `Here are your open **${dur}-minute** slots on **${formatDate(
    date
  )}**:\n\n`;
  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

// -----------------------------------------------
// DAY SUMMARY
// -----------------------------------------------
async function handleDaySummary(date) {
  if (!date) return "Which date would you like me to check? 😊";

  const events = await getEventsForDate(date);
  return renderEventList(events, formatDate(date));
}

// -----------------------------------------------
// RANGE SUMMARY
// -----------------------------------------------
async function handleRangeSummary(start, end) {
  if (!start || !end)
    return "Which date range would you like me to check, Dean?";

  const events = await getEventsForRange(start, end);

  if (events.length === 0) {
    return `You have *no events* between **${formatDate(start)}** and **${formatDate(
      end
    )}** 🎉`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(
    end
  )}:**\n\n`;

  events.forEach((ev) => {
    const startRaw = ev.start.dateTime || ev.start.date;
    const endRaw = ev.end.dateTime || ev.end.date;
    out += `• **${ev.summary}** — ${formatDate(startRaw)} (${formatTime(
      startRaw
    )}–${formatTime(endRaw)})\n`;
  });

  return out;
}

// -----------------------------------------------
// PLAN MY DAY (simple version using events)
// -----------------------------------------------
async function planMyDay(date) {
  const target = date || new Date().toISOString().slice(0, 10);
  const events = await getEventsForDate(target);

  if (events.length === 0) {
    return `You don't have anything booked on **${formatDate(
      target
    )}**. Want me to help you block focus time, gym, or rest?`;
  }

  const summaries = events
    .map((e) => {
      const startRaw = e.start.dateTime || e.start.date;
      const endRaw = e.end.dateTime || e.end.date;
      return `${e.summary} (${formatTime(startRaw)}–${formatTime(endRaw)})`;
    })
    .join("\n");

  const prompt = `
You are Dean's Chief-of-Staff.

Here are his events for the day:
${summaries}

Create a short, practical plan for the day:
- 3–5 key priorities
- Where to put focus work
- When to rest or reset
- Anything to watch out for

Be concise, clear and encouraging.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return `🧠 **Plan for ${formatDate(target)}**\n\n${completion.choices[0].message.content}`;
}

// -----------------------------------------------
// WEEKLY PLANNING (intro message)
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

You can say things like:
- "Plan my week with priorities"
- "Plan my week around energy"
- "Build a balanced week"
`;
}

// -----------------------------------------------
// LIFE ADVICE / PERSONAL ASSISTANT MODE
// -----------------------------------------------
async function lifeAdvice(message) {
  const prompt = `
You are Dean’s AI Chief-of-Staff and trusted advisor.
He said: "${message}"

Reply with:
- Friendly tone
- Efficient, concrete advice
- Strategic insight
- Encouraging but confident
- Keep it fairly short (3–6 bullet points or short paragraphs)
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return completion.choices[0].message.content;
}

// -----------------------------------------------
// FORMATTING HELPERS
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

function renderEventList(events, dateLabel = "") {
  if (!events || events.length === 0) {
    return `Your schedule is *wide open* on **${dateLabel}** 😎`;
  }

  let out = `📅 **Your schedule for ${dateLabel}:**\n\n`;

  events.forEach((ev, index) => {
    const startRaw = ev.start.dateTime || ev.start.date;
    const endRaw = ev.end.dateTime || ev.end.date;

    out += `${index + 1}. **${(ev.summary || "").trim()}** ${
      ev.location ? `📍${ev.location}` : ""
    } — ${formatTime(startRaw)} to ${formatTime(endRaw)}\n\n`;
  });

  out += `Let me know if you'd like changes, cancellations, or help planning the day! 😊`;

  return out;
}

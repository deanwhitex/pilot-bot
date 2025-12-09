// pilot.js – intents, calendar logic, memory, human interaction

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

const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const MIN_HOUR = 8;
const MAX_HOUR = 22;
const DEFAULT_DURATION_MIN = 60;
const MEMORY_FILE = "./memory.json";

// ----------------------------------------------------------
// MEMORY
// ----------------------------------------------------------
let memory = {
  preferences: {
    avoid_early_mornings: true,
    preferred_gym_time: "afternoon",
    meeting_buffer_min: 10,
  },
  energy_profile: {
    morning: "medium",
    afternoon: "high",
    evening: "low",
  },
};

try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    memory = JSON.parse(raw);
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

// ----------------------------------------------------------
// OPENAI CLIENT
// ----------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------------------------------
// INTENT PARSER
// ----------------------------------------------------------
async function interpretMessage(message) {
  const prompt = `
You are Dean's AI scheduling assistant.

Convert his message into STRICT JSON ONLY, no extra text.

JSON SHAPE:
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
- "day_summary"       // what's on my schedule / calendar / appointments for X
- "range_summary"     // week / month / between dates
- "find_free_time"    // open slot, free time
- "create_event"      // add/book/schedule/put/make an event
- "cancel_event"      // cancel/remove/delete meeting
- "reschedule_event"  // move/reschedule event
- "plan_day"          // plan my day
- "plan_week"         // plan my week
- "life_advice"       // general life / productivity advice
- "assistant_chat"    // hello / small talk / anything else
- "unknown"

RULES:
- If the message mentions "schedule", "calendar", "appointments", or "what's on"
  and a day (today, tomorrow, Monday, a date) -> intent = "day_summary"
- If it mentions "this week", "next week", "this month", "next month" -> "range_summary"
- "add / book / schedule / put / make" -> "create_event"
- "free time / open slot / when can I" -> "find_free_time"
- "cancel / remove / delete" + event words -> "cancel_event"
- "move / reschedule / push / shift" + event words -> "reschedule_event"
- If it's mostly greeting or chit-chat -> "assistant_chat"

- "date" and "range_*" can be natural language ("tomorrow", "next Monday") – do NOT invent exact ISO dates.
- If unsure, choose "assistant_chat" not "unknown".
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You output ONLY JSON, never prose." },
      { role: "user", content: prompt + "\n\nUSER MESSAGE:\n" + message },
    ],
    temperature: 0,
  });

  try {
    const txt = completion.choices[0].message.content.trim();
    return JSON.parse(txt);
  } catch (err) {
    console.error("Intent JSON parse error:", err);
    return { intent: "assistant_chat" };
  }
}

// ----------------------------------------------------------
// PUBLIC ENTRYPOINT
// ----------------------------------------------------------
export async function handleUserMessage(message) {
  const intent = await interpretMessage(message);

  updateMemoryFromMessage(message);

  switch (intent.intent) {
    case "day_summary":
      return await handleDaySummary(intent.date || "today");

    case "range_summary":
      return await handleRangeSummary(
        intent.range_start || "this week",
        intent.range_end || ""
      );

    case "find_free_time":
      return await handleFindFree(intent);

    case "create_event":
      return await handleCreateEvent(intent);

    case "cancel_event":
      return await handleCancel(intent);

    case "reschedule_event":
      return await handleReschedule(intent);

    case "plan_day":
      return await handlePlanDay(intent.date || "today");

    case "plan_week":
      return await handlePlanWeek();

    case "life_advice":
      return await handleLifeAdvice(message);

    case "assistant_chat":
    default:
      return await smallTalkReply(message);
  }
}

// ----------------------------------------------------------
// SMALL TALK
// ----------------------------------------------------------
async function smallTalkReply(message) {
  const prompt = `
You are Dean's friendly but efficient AI assistant.
He said: "${message}"

Reply in 1–2 short sentences.
Be warm, practical, and helpful. If he sounds like he's asking about schedule
but wasn't clear, gently ask which day or what he's trying to plan.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.6,
  });

  return completion.choices[0].message.content.trim();
}

// ----------------------------------------------------------
// MEMORY TWEAKS
// ----------------------------------------------------------
function updateMemoryFromMessage(message) {
  const text = message.toLowerCase();
  let changed = false;

  if (text.includes("tired") || text.includes("exhausted")) {
    memory.energy_profile.morning = "low";
    changed = true;
  }

  if (text.includes("stressed") || text.includes("overwhelmed")) {
    memory.preferences.avoid_early_mornings = true;
    changed = true;
  }

  if (changed) saveMemory();
}

// ----------------------------------------------------------
// DAY SUMMARY
// ----------------------------------------------------------
async function handleDaySummary(dateText) {
  // Quick mapping for "today" / "tomorrow"
  const now = new Date();
  let target = new Date(now);

  if (dateText.toLowerCase().includes("tomorrow")) {
    target.setDate(target.getDate() + 1);
  } else if (dateText.toLowerCase().includes("yesterday")) {
    target.setDate(target.getDate() - 1);
  }
  // If user says "today" or leaves it vague -> we just use 'target' as now.

  const events = await getEventsForDate(target);

  const dateLabel = target.toLocaleDateString("en-ZA", {
    timeZone: TIMEZONE,
  });

  return renderEventList(events, dateLabel);
}

// ----------------------------------------------------------
// RANGE SUMMARY (week / month)
// ----------------------------------------------------------
async function handleRangeSummary(rangeStartText, rangeEndText) {
  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);

  const lower = (rangeStartText + " " + rangeEndText).toLowerCase();

  if (lower.includes("next week")) {
    // next Monday to Sunday
    const day = now.getDay(); // 0=Sun,1=Mon
    const daysToNextMon = ((8 - day) % 7) || 7;
    start.setDate(now.getDate() + daysToNextMon);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 7);
  } else if (lower.includes("this week")) {
    const day = now.getDay() || 7; // make Sunday=7
    start.setDate(now.getDate() - (day - 1)); // Monday
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 7);
  } else {
    // fallback: today + 7 days
    start.setHours(0, 0, 0, 0);
    end.setDate(start.getDate() + 7);
  }

  const events = await getEventsForRange(start, end);

  if (!events || events.length === 0) {
    return `You have no events between **${formatDate(
      start
    )}** and **${formatDate(end)}**. 🎉`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(
    end
  )}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${(ev.summary || "").trim()}** — ${formatDate(
      ev.start.dateTime
    )} (${formatTime(ev.start.dateTime)}–${formatTime(
      ev.end.dateTime
    )})\n`;
  });

  return out;
}

// ----------------------------------------------------------
// FIND FREE TIME
// ----------------------------------------------------------
async function handleFindFree({ date, duration }) {
  const now = new Date();
  let target = new Date(now);

  if (date && date.toLowerCase().includes("tomorrow")) {
    target.setDate(target.getDate() + 1);
  }

  const dur = duration ? parseInt(duration, 10) : DEFAULT_DURATION_MIN;
  const slots = await findOpenSlots(target, dur);

  const dateLabel = formatDate(target);

  if (!slots || slots.length === 0) {
    return `No open ${dur}-minute slots on **${dateLabel}** 😕`;
  }

  let out = `🕒 **Available ${dur}-minute slots on ${dateLabel}:**\n\n`;
  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

// ----------------------------------------------------------
// CREATE EVENT
// ----------------------------------------------------------
async function handleCreateEvent({ title, date, start_time, duration }) {
  if (!title) return "What should I call this event? 😊";
  if (!date) return "Which day should I schedule it on?";

  const now = new Date();
  let day = new Date(now);
  const lower = date.toLowerCase();
  if (lower.includes("tomorrow")) {
    day.setDate(day.getDate() + 1);
  }

  const dur = duration ? parseInt(duration, 10) : DEFAULT_DURATION_MIN;

  if (!start_time) {
    const options = await findOpenSlots(day, dur, 3);
    if (!options || options.length === 0) {
      return `I couldn't find free time on **${formatDate(
        day
      )}**. Want me to check another day?`;
    }

    let out = `Here are some good options for **${title}** on **${formatDate(
      day
    )}**:\n\n`;
    options.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    out += `\nReply with **1**, **2**, or **3** and I’ll book it.`;
    return out;
  }

  const start = new Date(
    `${day.toISOString().slice(0, 10)}T${start_time}:00`
  );
  const end = new Date(start.getTime() + dur * 60000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return `That time is outside your normal hours (08:00–22:00).`;
  }

  await createEvent({ title, start, end });

  return `🎉 Done — I’ve added **${title}** on **${formatDate(
    start
  )}** from ${formatTime(start)} to ${formatTime(end)}.`;
}

// ----------------------------------------------------------
// CANCEL EVENT
// ----------------------------------------------------------
async function handleCancel({ target_event }) {
  if (!target_event) return "Which event should I cancel?";

  const matches = await searchEventsByText(target_event);

  if (!matches || matches.length === 0) {
    return `I couldn't find anything matching "${target_event}".`;
  }

  if (matches.length === 1) {
    const ev = matches[0];
    await cancelEventById(ev.calendarId, ev.id);
    return `🗑️ Done — I cancelled **${ev.summary}** at ${formatTime(
      ev.start.dateTime
    )}.`;
  }

  let out = "I found multiple matches:\n\n";
  matches.forEach((m, i) => {
    out += `${i + 1}. **${m.summary}** — ${formatDate(
      m.start.dateTime
    )} at ${formatTime(m.start.dateTime)}\n`;
  });
  out += "\nReply with the number you want me to cancel.";
  return out;
}

// ----------------------------------------------------------
// RESCHEDULE
// ----------------------------------------------------------
async function handleReschedule({ target_event, date, start_time }) {
  if (!target_event) return "Which event should I move?";

  const matches = await searchEventsByText(target_event);
  if (!matches || matches.length === 0) {
    return "I couldn’t find that event.";
  }

  if (matches.length > 1) {
    let out = "I found several events. Which one should I move?\n\n";
    matches.forEach((m, i) => {
      out += `${i + 1}. **${m.summary}** — ${formatDate(
        m.start.dateTime
      )}, ${formatTime(m.start.dateTime)}\n`;
    });
    return out;
  }

  const ev = matches[0];

  const baseDate = date && date.toLowerCase().includes("tomorrow")
    ? (() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date(ev.start.dateTime);

  if (!start_time) {
    const suggestions = await findOpenSlots(baseDate, 60, 3);
    if (!suggestions || suggestions.length === 0) {
      return "No good times found that day. Want me to check another day?";
    }

    let out = `Here are good options for moving **${ev.summary}**:\n\n`;
    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    out += "\nReply with the number you prefer.";
    return out;
  }

  const newStart = new Date(
    `${baseDate.toISOString().slice(0, 10)}T${start_time}:00`
  );
  const newEnd = new Date(newStart.getTime() + 60 * 60000);

  await rescheduleEventById(ev.calendarId, ev.id, newStart, newEnd);

  return `🔄 All set — I’ve moved **${ev.summary}** to ${formatDate(
    newStart
  )} at ${formatTime(newStart)}.`;
}

// ----------------------------------------------------------
// PLAN DAY / WEEK (lightweight for now)
// ----------------------------------------------------------
async function handlePlanDay(dateText) {
  const baseText = `Help Dean plan his day (${dateText}). Keep it short: 4–6 bullet points mixing meetings, focus time, rest, and gym.`;
  return await handleLifeAdvice(baseText);
}

async function handlePlanWeek() {
  const prompt = `
Plan Dean's upcoming week at a high level.
He has roofing/marketing work, client calls, gym, and needs rest.
Give 5–7 bullets, one per line, very concise.
`;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });
  return completion.choices[0].message.content.trim();
}

// ----------------------------------------------------------
// LIFE ADVICE
// ----------------------------------------------------------
async function handleLifeAdvice(message) {
  const prompt = `
You are Dean's Chief-of-Staff.
He said: "${message}"

Give grounded, practical advice in 3–5 bullet points.
Avoid generic fluff. Be specific and kind.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  return completion.choices[0].message.content.trim();
}

// ----------------------------------------------------------
// RENDERING HELPERS
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

function renderEventList(events, dateLabel = "") {
  if (!events || events.length === 0) {
    return `Your schedule is *wide open* on **${dateLabel}** 😎`;
  }

  let out = `📅 **Your schedule for ${dateLabel}:**\n\n`;

  events.forEach((ev, index) => {
    out += `${index + 1}. **${(ev.summary || "").trim()}** ${
      ev.location ? `📍${ev.location}` : ""
    } — ${formatTime(ev.start.dateTime)} to ${formatTime(
      ev.end.dateTime
    )}\n`;
  });

  out += `\nLet me know if you'd like changes, cancellations, or help planning the day! 😊`;
  return out;
}



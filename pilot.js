// pilot.js
import OpenAI from "openai";
import fs from "fs";
import {
  getEventsForDate,
  getEventsForRange,
  findOpenSlots,
  createEvent,
  cancelEventById,
  searchEventsByText,
} from "./calendar.js";

const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const DEFAULT_DURATION_MIN = 60;
const MEMORY_FILE = "./memory.json";

// ----------------------------------------------------------
// LIGHTWEIGHT "MEMORY" (preferences)
// ----------------------------------------------------------
let memory = {
  preferences: {
    avoid_early_mornings: true,
    meeting_buffer_min: 10,
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

// ----------------------------------------------------------
// OPENAI CLIENT
// ----------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------------------------------
// Simple per-user state for follow-ups
// ----------------------------------------------------------
// modes: "cancel_select", "create_select_slot"
const sessions = new Map(); // userId -> { mode, ... }

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------
function stripLinks(text = "") {
  return text.replace(/https?:\/\/\S+/gi, "").trim();
}

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-ZA", {
    timeZone: TIMEZONE,
  });
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-ZA", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Render schedule lists (also used by index.js)
export function renderEventList(events, dateInput = null, opts = {}) {
  const { includeHeader = true } = opts;
  const label = dateInput ? formatDate(dateInput) : "this period";

  if (!events || events.length === 0) {
    return `Your schedule is *wide open* on **${label}** 😎`;
  }

  let out = "";
  if (includeHeader) {
    out += `📅 **Your schedule for ${label}:**\n\n`;
  }

  events.forEach((ev, i) => {
    const title = stripLinks(ev.summary || "Untitled");
    const start = formatTime(ev.start.dateTime || ev.start.date);
    const end = formatTime(ev.end.dateTime || ev.end.date);
    out += `${i + 1}. **${title}** — ${start} to ${end}\n`;
  });

  if (includeHeader) {
    out +=
      `\nLet me know if you'd like changes, cancellations, or help planning the day! 😊`;
  }

  return out;
}

// ----------------------------------------------------------
// VERY LIGHT RULE-BASED HANDLING BEFORE LLM
// ----------------------------------------------------------
function isGreeting(text) {
  const lower = text.toLowerCase();
  return /^(hey|hi|hello|yo|morning|evening)\b/.test(lower);
}

function parseBasicDayRequest(text) {
  const lower = text.toLowerCase();

  // "schedule" or "calendar" must appear
  if (!/(schedule|calendar|appointments?|day)/.test(lower)) return null;

  const now = new Date();

  if (/\btoday\b/.test(lower)) {
    return { type: "day", date: now };
  }

  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return { type: "day", date: d };
  }

  // yyyy/mm/dd style
  const m = lower.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
  if (m) {
    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) {
      return { type: "day", date: d };
    }
  }

  return null;
}

// ----------------------------------------------------------
// LLM intent parser (used only when rules don't handle it)
// ----------------------------------------------------------
async function interpretMessageLLM(text) {
  const prompt = `
You are Dean's scheduling assistant. Convert his message to *strict JSON*:

{
  "intent": "",
  "title": "",
  "date": "",
  "start_time": "",
  "duration": "",
  "target_event": ""
}

INTENT OPTIONS:
- "create_event" (add/book/schedule something)
- "cancel_event" (cancel, remove, delete something)
- "find_free_time"
- "assistant_chat"
- "unknown"

Rules:
- If he talks about adding/booking/scheduling -> "create_event"
- If he says cancel/delete/remove -> "cancel_event"
- If he says "free time", "open slot" -> "find_free_time"
- If it's just chat or unclear -> "assistant_chat"
- date: ISO (YYYY-MM-DD) when possible; otherwise "".
- start_time: 24h HH:MM when specified, otherwise "".
- duration: minutes as number string, default "60" for events.
- NEVER add commentary, just the JSON.
Message: "${text}"
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error("interpretMessageLLM JSON error:", err);
    return { intent: "unknown" };
  }
}

// ----------------------------------------------------------
// PUBLIC ENTRYPOINT
// ----------------------------------------------------------
export async function handleUserMessage(message) {
  const userId = message.author.id;
  const text = message.content.trim();

  // 1) If user is mid-flow (choosing a number for cancel/create), handle that
  const pending = sessions.get(userId);
  if (pending) {
    return await handlePendingFlow(userId, pending, text);
  }

  // 2) Greetings – no LLM
  if (isGreeting(text)) {
    return "Sure Dean — what can I help you with? 😊";
  }

  // 3) Obvious schedule questions for today/tomorrow – no LLM
  const basicDay = parseBasicDayRequest(text);
  if (basicDay && basicDay.type === "day") {
    const events = await getEventsForDate(basicDay.date);
    return renderEventList(events, basicDay.date);
  }

  // 4) Everything else -> LLM intent
  const intent = await interpretMessageLLM(text);

  switch (intent.intent) {
    case "create_event":
      return await handleCreateEvent(intent, userId);

    case "cancel_event":
      return await handleCancelEvent(intent, userId);

    case "find_free_time":
      return await handleFindFreeTime(intent);

    case "assistant_chat":
      return "Sure Dean — what can I help you with? 😊";

    default:
      return "I'm not entirely sure what you mean, but I'm here to help. 😊";
  }
}

// ----------------------------------------------------------
// FLOW HANDLERS (for follow-up numbers etc.)
// ----------------------------------------------------------
async function handlePendingFlow(userId, session, text) {
  const choice = parseInt(text.trim(), 10);

  if (Number.isNaN(choice)) {
    return "Please reply with the **number** of the option you'd like, e.g. `1`, `2`, or `3`.";
  }

  if (session.mode === "cancel_select") {
    const idx = choice - 1;
    if (idx < 0 || idx >= session.events.length) {
      return `That doesn't match any option. Please choose a number between 1 and ${session.events.length}.`;
    }

    const ev = session.events[idx];
    sessions.delete(userId);

    await cancelEventById(ev.calendarId, ev.id);
    return `🗑️ Done — I cancelled **${stripLinks(
      ev.summary
    )}** on **${formatDate(ev.start.dateTime || ev.start.date)}** at **${formatTime(
      ev.start.dateTime || ev.start.date
    )}**.`;
  }

  if (session.mode === "create_select_slot") {
    const idx = choice - 1;
    if (idx < 0 || idx >= session.slots.length) {
      return `That doesn't match any option. Please choose a number between 1 and ${session.slots.length}.`;
    }

    const slot = session.slots[idx];
    sessions.delete(userId);

    const event = await createEvent({
      title: session.title,
      start: slot.start,
      end: slot.end,
    });

    return `🎉 All set! I added **${stripLinks(
      event.summary
    )}** on **${formatDate(
      slot.start
    )}** from **${formatTime(slot.start)}** to **${formatTime(slot.end)}**.`;
  }

  // unknown mode – clear it
  sessions.delete(userId);
  return "Let's start fresh — what would you like me to help with?";
}

// ----------------------------------------------------------
// CREATE EVENT
// ----------------------------------------------------------
async function handleCreateEvent(intent, userId) {
  const title = intent.title?.trim() || "New event";
  const duration =
    intent.duration && !isNaN(parseInt(intent.duration, 10))
      ? parseInt(intent.duration, 10)
      : DEFAULT_DURATION_MIN;

  // If no date, ask explicitly
  if (!intent.date) {
    return "Which date should I schedule that on? (e.g. `2025/12/11` or `tomorrow`)";
  }

  const date = new Date(intent.date);
  if (isNaN(date.getTime())) {
    return "I couldn't understand that date. Could you give it as `YYYY/MM/DD`?";
  }

  // If no time, suggest slots using findOpenSlots
  if (!intent.start_time) {
    const slots = await findOpenSlots(date, duration, 3);
    if (slots.length === 0) {
      return `I couldn't find any good ${duration}-minute slots on **${formatDate(
        date
      )}**. Want me to check another day?`;
    }

    sessions.set(userId, {
      mode: "create_select_slot",
      title,
      slots,
    });

    let out = `Here are some good options for **${title}** on **${formatDate(
      date
    )}**:\n\n`;
    slots.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    out += `\nReply with **1**, **2**, or **3** and I’ll book it.`;
    return out;
  }

  // Time provided → create directly
  const start = new Date(`${intent.date}T${intent.start_time}`);
  if (isNaN(start.getTime())) {
    return "I couldn't parse that time. Try something like `10:00` or `14:30`.";
  }
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const event = await createEvent({ title, start, end });

  return `🎉 All set! I added **${stripLinks(
    event.summary
  )}** on **${formatDate(
    start
  )}** from **${formatTime(start)}** to **${formatTime(end)}**.`;
}

// ----------------------------------------------------------
// CANCEL EVENT
// ----------------------------------------------------------
async function handleCancelEvent(intent, userId) {
  const target = intent.target_event?.trim();
  if (!target) {
    return "Which event should I cancel? You can say something like `cancel gym tomorrow`.";
  }

  const matches = await searchEventsByText(target);

  if (matches.length === 0) {
    return `I couldn't find any events matching **"${target}"** in the next few weeks.`;
  }

  if (matches.length === 1) {
    const ev = matches[0];
    await cancelEventById(ev.calendarId, ev.id);
    return `🗑️ Done — I cancelled **${stripLinks(
      ev.summary
    )}** on **${formatDate(ev.start.dateTime || ev.start.date)}** at **${formatTime(
      ev.start.dateTime || ev.start.date
    )}**.`;
  }

  // Multiple → ask for number and remember
  sessions.set(userId, {
    mode: "cancel_select",
    events: matches,
  });

  let out = `I found several events that might match. Which one should I cancel?\n\n`;
  matches.forEach((ev, i) => {
    out += `${i + 1}. **${stripLinks(
      ev.summary
    )}** — ${formatDate(ev.start.dateTime || ev.start.date)} at ${formatTime(
      ev.start.dateTime || ev.start.date
    )}\n`;
  });
  out += `\nReply with the **number** of the one you want me to cancel.`;
  return out;
}

// ----------------------------------------------------------
// FIND FREE TIME
// ----------------------------------------------------------
async function handleFindFreeTime(intent) {
  if (!intent.date) {
    return "What date should I look for free time on?";
  }
  const date = new Date(intent.date);
  if (isNaN(date.getTime())) {
    return "I couldn't understand that date. Please use `YYYY/MM/DD` or `tomorrow`.";
  }

  const duration =
    intent.duration && !isNaN(parseInt(intent.duration, 10))
      ? parseInt(intent.duration, 10)
      : DEFAULT_DURATION_MIN;

  const slots = await findOpenSlots(date, duration);
  if (slots.length === 0) {
    return `I couldn't find any free ${duration}-minute slots on **${formatDate(
      date
    )}**.`;
  }

  let out = `Here are your free **${duration}-minute** slots on **${formatDate(
    date
  )}**:\n\n`;
  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });
  return out;
}

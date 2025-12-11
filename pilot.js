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

/* ----------------------------------------------------------
   LIGHTWEIGHT MEMORY (preferences)
---------------------------------------------------------- */
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

/* ----------------------------------------------------------
   OPENAI CLIENT
---------------------------------------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------------------------------------
   SMALL SESSION STATE (for follow-ups)
---------------------------------------------------------- */
// modes: "cancel_select", "create_select_slot"
const sessions = new Map(); // userId -> { mode, ... }

/* ----------------------------------------------------------
   HELPERS
---------------------------------------------------------- */
function stripLinks(text = "") {
  return text.replace(/https?:\/\/\S+/gi, "").trim();
}

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-ZA", { timeZone: TIMEZONE });
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-ZA", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

/* ----------------------------------------------------------
   RULE-BASED INTENT (NO LLM) FOR EASY THINGS
---------------------------------------------------------- */
function isGreeting(text) {
  const lower = text.toLowerCase();
  return /^(hey|hi|hello|yo|morning|evening)\b/.test(lower);
}

// Extract a Date object from phrases like today/tomorrow/2025-12-11
function extractDateFromText(text) {
  const lower = text.toLowerCase();
  const now = new Date();

  if (/\btoday\b/.test(lower)) {
    return now;
  }

  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const m = lower.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      12,
      0,
      0,
      0
    );
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

// Detect “what’s my schedule/calendar/appointments …”
function parseBasicDayRequest(text) {
  const lower = text.toLowerCase();

  if (!/(schedule|calendar|appointments?|day)/.test(lower)) return null;

  const date = extractDateFromText(text);
  if (!date) return null;

  return { type: "day", date };
}

/* ----------------------------------------------------------
   LLM INTENT (ONLY FOR HARDER CASES)
---------------------------------------------------------- */
async function interpretMessageLLM(text) {
  const prompt = `
You are Dean's scheduling assistant. Convert his message to strict JSON:

{
  "intent": "",
  "title": "",
  "date": "",
  "start_time": "",
  "duration": "",
  "target_event": ""
}

INTENT OPTIONS:
- "create_event"   (add/book/schedule something)
- "cancel_event"   (cancel/remove/delete something)
- "find_free_time" (ask for free time / open slots)
- "assistant_chat" (general chat)
- "unknown"

Rules:
- If he talks about adding/booking/scheduling -> "create_event"
- If he says cancel/delete/remove -> "cancel_event"
- If he says "free time", "open slot", "when can I" -> "find_free_time"
- If it's just chat or unclear -> "assistant_chat"
- "date": if he says today/tomorrow, set "today" or "tomorrow" (DO NOT invent a year).
- "start_time": 24h HH:MM if he clearly gives a time, else "".
- "duration": minutes as string, default "60" for events.

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

/* ----------------------------------------------------------
   PUBLIC ENTRYPOINT
---------------------------------------------------------- */
export async function handleUserMessage(message) {
  const userId = message.author.id;
  const text = message.content.trim();

  // 1) Check if user is mid-flow (choosing a number)
  const pending = sessions.get(userId);
  if (pending) {
    return await handlePendingFlow(userId, pending, text);
  }

  // 2) Greetings: handled here, no LLM. (Single reply, no doubles.)
  if (isGreeting(text)) {
    return "Sure Dean — what can I help you with? 😊";
  }

  // 3) Direct “what’s my schedule for today/tomorrow/2025/12/11”
  const basicDay = parseBasicDayRequest(text);
  if (basicDay && basicDay.type === "day") {
    const events = await getEventsForDate(basicDay.date);
    return renderEventList(events, basicDay.date);
  }

  // 4) Everything else → LLM for intent
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

/* ----------------------------------------------------------
   FOLLOW-UP MODES (numbers for cancel / create)
---------------------------------------------------------- */
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

  sessions.delete(userId);
  return "Let's start fresh — what would you like me to help with?";
}

/* ----------------------------------------------------------
   CREATE EVENT
---------------------------------------------------------- */
async function handleCreateEvent(intent, userId) {
  const title = intent.title?.trim() || "New event";
  const duration =
    intent.duration && !isNaN(parseInt(intent.duration, 10))
      ? parseInt(intent.duration, 10)
      : DEFAULT_DURATION_MIN;

  // Interpret "today" / "tomorrow" here to avoid wrong years
  let date;
  if (intent.date === "today") {
    date = new Date();
  } else if (intent.date === "tomorrow") {
    date = new Date();
    date.setDate(date.getDate() + 1);
  } else if (intent.date) {
    date = extractDateFromText(intent.date);
  }

  if (!date) {
    return "Which date should I schedule that on? (e.g. `today`, `tomorrow`, or `2025/12/11`)";
  }

  // If no time, suggest slots
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

  const start = new Date(date);
  const [h, m] = intent.start_time.split(":").map((x) => parseInt(x, 10));
  start.setHours(h, m || 0, 0, 0);
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

/* ----------------------------------------------------------
   CANCEL EVENT
---------------------------------------------------------- */
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

/* ----------------------------------------------------------
   FIND FREE TIME
---------------------------------------------------------- */
async function handleFindFreeTime(intent) {
  let date;
  if (intent.date === "today") {
    date = new Date();
  } else if (intent.date === "tomorrow") {
    date = new Date();
    date.setDate(date.getDate() + 1);
  } else if (intent.date) {
    date = extractDateFromText(intent.date);
  }

  if (!date) {
    return "What date should I look for free time on?";
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


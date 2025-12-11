// pilot.js
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
   SESSION STATE
   - sessions: temporary flows (pick-a-number)
   - lastSchedules: last schedule per user for cancel/add
---------------------------------------------------------- */
const sessions = new Map();      // userId -> { mode, ... }
const lastSchedules = new Map(); // userId -> { date: Date, events: [] }

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

function extractDateFromText(text) {
  const lower = text.toLowerCase();
  const now = new Date();

  if (/\btoday\b/.test(lower)) return now;

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

function parseTimeFromText(text) {
  // 10am, 10:30am, 14:00, 4 pm, etc.
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return "";

  let hour = parseInt(m[1], 10);
  let minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;

  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23) return "";
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
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

function isGreeting(text) {
  const lower = text.toLowerCase();
  return /^(hey|hi|hello|yo|morning|evening)\b/.test(lower);
}

/* ----------------------------------------------------------
   PARSERS (no AI, just rules)
---------------------------------------------------------- */

// “what’s my schedule/calendar/appointments/day …”
function parseBasicDayRequest(text) {
  const lower = text.toLowerCase();

  if (!/\b(schedule|calendar|appointments?|day)\b/.test(lower)) return null;

  const date = extractDateFromText(text);
  if (!date) return null;

  return { type: "day", date };
}

// “cancel muay”, “can you cancel 2”, “cancel muay for today”
function parseCancelCommand(text) {
  const lower = text.toLowerCase();
  const cancelIdx = lower.indexOf("cancel");

  if (cancelIdx === -1) return null;

  // If they say "cancel 2" etc, we let the handler use the number
  const numAfter = lower.match(/\bcancel\s+(\d+)\b/);
  let targetEvent = null;

  if (!numAfter) {
    let rest = text.slice(cancelIdx + "cancel".length);

    // Strip common filler words / date / time phrases
    rest = rest.replace(/\b(today|tomorrow|please|for|the|event|appointment|my|on|at)\b/gi, " ");
    rest = rest.replace(/\d{4}[/-]\d{2}[/-]\d{2}/g, " ");
    rest = rest.replace(/\d{1,2}(:\d{2})?\s*(am|pm)?/gi, " ");

    targetEvent = rest.trim();
    if (!targetEvent) targetEvent = null;
  }

  return { target_event: targetEvent };
}

// “book gym”, “add gym for 10am tomorrow”, “schedule Zoom with John”
function parseCreateCommand(text) {
  const lower = text.toLowerCase();
  const m = lower.match(/\b(add|book|schedule|put|block)\b/);
  if (!m) return null;

  let rest = text.slice(m.index + m[0].length).trim();

  let dateStr = null;
  const rl = rest.toLowerCase();
  if (/\btoday\b/.test(rl)) dateStr = "today";
  else if (/\btomorrow\b/.test(rl)) dateStr = "tomorrow";
  else {
    const dm = rl.match(/(\d{4}[/-]\d{2}[/-]\d{2})/);
    if (dm) dateStr = dm[1];
  }

  const start_time = parseTimeFromText(rest);

  // Clean to get the title
  rest = rest.replace(/\b(today|tomorrow|on|at|for|please|my)\b/gi, " ");
  rest = rest.replace(/\d{4}[/-]\d{2}[/-]\d{2}/g, " ");
  rest = rest.replace(/\d{1,2}(:\d{2})?\s*(am|pm)?/gi, " ");

  const title = rest.trim() || "New event";

  return { title, date: dateStr, start_time };
}

// “when am I free”, “free time tomorrow”, “open slot on Friday”
function parseFreeCommand(text) {
  const lower = text.toLowerCase();
  if (
    !(
      /free time/.test(lower) ||
      /free slot/.test(lower) ||
      /open slot/.test(lower) ||
      /when am i free/.test(lower) ||
      /when can i/.test(lower)
    )
  ) {
    return null;
  }

  const date = extractDateFromText(text);
  let duration = DEFAULT_DURATION_MIN;

  const dm = lower.match(/(\d+)\s*(min|mins|minutes)/);
  if (dm) {
    duration = parseInt(dm[1], 10);
  }

  return { date, duration };
}

/* ----------------------------------------------------------
   PUBLIC ENTRYPOINT
---------------------------------------------------------- */
export async function handleUserMessage(message) {
  const userId = message.author.id;
  const text = message.content.trim();

  // 1) If we're in a “choose number” flow
  const pending = sessions.get(userId);
  if (pending) {
    return await handlePendingFlow(userId, pending, text);
  }

  // 2) Greetings
  if (isGreeting(text)) {
    return "Sure Dean — what can I help you with? 😊";
  }

  // 3) Direct schedule request
  const basicDay = parseBasicDayRequest(text);
  if (basicDay && basicDay.type === "day") {
    const events = await getEventsForDate(basicDay.date);
    lastSchedules.set(userId, { date: basicDay.date, events });
    return renderEventList(events, basicDay.date);
  }

  // 4) Cancel command
  const cancelParsed = parseCancelCommand(text);
  if (cancelParsed) {
    return await handleCancelCommand(cancelParsed, userId, text);
  }

  // 5) Create command
  const createParsed = parseCreateCommand(text);
  if (createParsed) {
    return await handleCreateCommand(createParsed, userId);
  }

  // 6) Free time command
  const freeParsed = parseFreeCommand(text);
  if (freeParsed) {
    return await handleFreeCommand(freeParsed, userId);
  }

  // 7) Default
  return "I'm not entirely sure what you mean, but I'm here to help. 😊";
}

/* ----------------------------------------------------------
   FOLLOW-UP FLOWS (number selections)
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
   CREATE EVENT (from parsed command)
---------------------------------------------------------- */
async function handleCreateCommand(parsed, userId) {
  const { title, date: dateStr, start_time } = parsed;
  let date = null;

  if (dateStr === "today") {
    date = new Date();
  } else if (dateStr === "tomorrow") {
    date = new Date();
    date.setDate(date.getDate() + 1);
  } else if (dateStr) {
    date = extractDateFromText(dateStr);
  }

  // no date given → fall back to last schedule Dean asked for
  if (!date) {
    const last = lastSchedules.get(userId);
    if (last && last.date) {
      date = new Date(last.date);
    }
  }

  if (!date) {
    return "Which date should I schedule that on? (e.g. `today`, `tomorrow`, or `2025/12/11`)";
  }

  const duration = DEFAULT_DURATION_MIN;

  // If no start time → suggest slots
  if (!start_time) {
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
  const [h, m] = start_time.split(":").map((x) => parseInt(x, 10));
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
   CANCEL EVENT (from parsed command + last schedule)
---------------------------------------------------------- */
async function handleCancelCommand(parsed, userId, rawText) {
  const target = parsed.target_event ? parsed.target_event.trim() : null;
  const last = lastSchedules.get(userId);

  // 1) If we have a last schedule and they say "cancel 2"
  if (last && last.events && last.events.length > 0) {
    const numMatch = rawText.toLowerCase().match(/\bcancel\s+(\d+)\b/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < last.events.length) {
        const ev = last.events[idx];
        await cancelEventById(ev.calendarId, ev.id);
        return `🗑️ Done — I cancelled **${stripLinks(
          ev.summary
        )}** on **${formatDate(
          ev.start.dateTime || ev.start.date
        )}** at **${formatTime(ev.start.dateTime || ev.start.date)}**.`;
      }
    }
  }

  // 2) Use last schedule to find by name (“cancel muay”)
  if (last && last.events && last.events.length > 0 && target) {
    const lower = target.toLowerCase();
    const matches = last.events.filter((e) =>
      `${e.summary || ""} ${e.description || ""}`
        .toLowerCase()
        .includes(lower)
    );

    if (matches.length === 1) {
      const ev = matches[0];
      await cancelEventById(ev.calendarId, ev.id);
      return `🗑️ Done — I cancelled **${stripLinks(
        ev.summary
      )}** on **${formatDate(
        ev.start.dateTime || ev.start.date
      )}** at **${formatTime(ev.start.dateTime || ev.start.date)}**.`;
    }

    if (matches.length > 1) {
      sessions.set(userId, {
        mode: "cancel_select",
        events: matches,
      });

      let out = `I found several events that might match **"${target}"**. Which one should I cancel?\n\n`;
      matches.forEach((ev, i) => {
        out += `${i + 1}. **${stripLinks(
          ev.summary
        )}** — ${formatDate(
          ev.start.dateTime || ev.start.date
        )} at ${formatTime(ev.start.dateTime || ev.start.date)}\n`;
      });
      out += `\nReply with the **number** of the one you want me to cancel.`;
      return out;
    }
  }

  // 3) Fallback: global search
  if (!target) {
    return "Which event should I cancel? You can say something like `cancel Muay Thai today` or `cancel 2`.";
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
    )}** — ${formatDate(
      ev.start.dateTime || ev.start.date
    )} at ${formatTime(ev.start.dateTime || ev.start.date)}\n`;
  });
  out += `\nReply with the **number** of the one you want me to cancel.`;
  return out;
}

/* ----------------------------------------------------------
   FREE TIME
---------------------------------------------------------- */
async function handleFreeCommand(parsed, userId) {
  let { date, duration } = parsed;

  if (!date) {
    const last = lastSchedules.get(userId);
    if (last && last.date) {
      date = new Date(last.date);
    }
  }

  if (!date) {
    return "What date should I look for free time on?";
  }

  duration = duration || DEFAULT_DURATION_MIN;

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

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
// CONSTANTS / MEMORY
// -----------------------------------------------
const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const DEFAULT_DURATION_MIN = 60;
const MEMORY_FILE = "./memory.json";

// very simple “personality” memory – you can expand later
let memory = {
  preferences: {
    avoid_early_mornings: true,
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
// LIGHTWEIGHT STATE (for "number 3" after a list)
// -----------------------------------------------
let pendingCancelOptions = null; // array of events from last cancel search

// -----------------------------------------------
// INTENT PARSER (LLM + hard rules)
// -----------------------------------------------
async function interpretMessage(message) {
  const lower = message.toLowerCase().trim();

  // ---------- HARD RULES FIRST (no LLM) ----------

  // 1) Pure greeting
  if (/^(hi|hey|hello|yo|morning|evening)\b/.test(lower)) {
    return {
      intent: "assistant_chat",
      title: "",
      date: "",
      start_time: "",
      end_time: "",
      duration: "",
      range_start: "",
      range_end: "",
      target_event: "",
    };
  }

  // 2) Hard rule: cancel something
  if (lower.includes("cancel")) {
    // grab everything after the word "cancel"
    const after = message.replace(/.*cancel/i, "").trim();
    return {
      intent: "cancel_event",
      title: "",
      date: "",
      start_time: "",
      end_time: "",
      duration: "",
      range_start: "",
      range_end: "",
      target_event: after, // e.g. "sergio for tomorrow"
    };
  }

  // 3) Hard rule: schedule / appointments / calendar → let LLM figure date
  // (but bias towards day_summary)
  // everything else falls through to LLM below

  // ---------- LLM STRUCTURED INTENT ----------
  const prompt = `
You are Dean’s AI scheduling assistant.

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
- "day_summary"        → what's on my schedule / day / calendar
- "range_summary"      → week / month / between two dates
- "find_free_time"     → free time, open slots, when can I
- "create_event"       → add / book / schedule something
- "reschedule_event"   → move / reschedule something
- "cancel_event"       → cancel / remove an event
- "assistant_chat"     → general chat / life talk
- "unknown"            → if really unsure

Rules:
- Use ISO dates when possible (YYYY-MM-DD).
- If user says things like "tomorrow", "Thursday", "next week",
  convert to concrete dates if you can.
- If unclear, prefer:
    schedule → "day_summary"
    planning-type talk → "assistant_chat"
- NEVER include commentary, only valid JSON.
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

// -----------------------------------------------
// MAIN ROUTER
// -----------------------------------------------
export async function handleUserMessage(message) {
  const text = message.trim();

  // 0) If user says "number 3" etc and we recently listed cancel options
  const lower = text.toLowerCase();
  const numberMatch =
    lower.match(/^number\s+(\d+)/) || lower.match(/^option\s+(\d+)/) || lower.match(/^(\d+)$/);

  if (pendingCancelOptions && numberMatch) {
    const idx = parseInt(numberMatch[1], 10) - 1;
    if (idx < 0 || idx >= pendingCancelOptions.length) {
      return "That number doesn’t match any option I gave you. Try again with a valid number. 🙂";
    }

    const ev = pendingCancelOptions[idx];
    pendingCancelOptions = null; // clear state

    try {
      await cancelEventById(ev.calendarId, ev.id);
      return `🗑️ Done — I’ve cancelled **${ev.summary}** on **${formatDate(
        ev.start.dateTime || ev.start.date
      )}** at **${formatTime(ev.start.dateTime || ev.start.date)}**.`;
    } catch (err) {
      console.error("Cancel by number error:", err);
      return "I tried to cancel that event but something went wrong. 😕";
    }
  }

  // 1) Normal intent flow
  const intent = await interpretMessage(text);

  // quick mood tweaks for memory
  detectMood(text);

  switch (intent.intent) {
    case "assistant_chat":
      return conversationalReply(text);

    case "day_summary":
      return await handleDaySummary(intent.date, text);

    case "range_summary":
      return await handleRangeSummary(intent.range_start, intent.range_end);

    case "find_free_time":
      return await handleFindFree(intent);

    case "create_event":
  return await handleCreateEvent(intent, message);

    case "cancel_event":
  return await handleCancel(intent, message);

    case "reschedule_event":
      return await handleReschedule(intent, text);

    default:
      // fallback: short, actionable hint rather than dumb waffle
      return (
        "I'm not totally sure what you mean, but I can help with things like:\n" +
        "• *“What’s my day tomorrow?”*\n" +
        "• *“Find a free hour on Friday”*\n" +
        "• *“Add gym tomorrow at 9am”*\n" +
        "• *“Cancel Sergio tomorrow”*"
      );
  }
}

// -----------------------------------------------
// GREETING / CHAT MODE
// -----------------------------------------------
function conversationalReply(message) {
  const lower = message.toLowerCase();
  if (/^(hi|hey|hello|yo)/.test(lower)) {
    return "Hey Dean! 😊 What do you want to do with your day — check your schedule, cancel something, or plan ahead?";
  }

  return "Sure Dean — what's on your mind? I can help with your schedule, cancelling / moving meetings, or planning your week. 😊";
}

// -----------------------------------------------
// MOOD / MEMORY TWEAKS
// -----------------------------------------------
function detectMood(message) {
  const text = message.toLowerCase();

  if (text.includes("tired") || text.includes("exhausted")) {
    memory.energy_profile.evening = "low";
    saveMemory();
  }

  if (text.includes("stressed") || text.includes("overwhelmed")) {
    memory.preferences.avoid_early_mornings = true;
    saveMemory();
  }
}

// -----------------------------------------------
// CANCELLATION ENGINE (smarter)
// -----------------------------------------------
async function handleCancel(intent, originalText) {
  let { target_event, date } = intent;
  const lower = originalText.toLowerCase();

  // Helper to normalise dates (today / tomorrow)
  const now = new Date();
  const isoToday = now.toISOString().split("T")[0];

  const tmr = new Date(now);
  tmr.setDate(tmr.getDate() + 1);
  const isoTomorrow = tmr.toISOString().split("T")[0];

  if (!date) {
    if (lower.includes("today")) date = isoToday;
    else if (lower.includes("tomorrow")) date = isoTomorrow;
  }

  // --------------------------------------------------
  // Case 1: "cancel 3", "cancel number 3" etc.
  // --------------------------------------------------
  const numberMatch = lower.match(/cancel\s*(?:event\s*)?(?:number\s*)?(\d+)/);
  if (numberMatch) {
    const index = parseInt(numberMatch[1], 10) - 1;

    const dayIso = date || isoToday;
    const dayEvents = await getEventsForDate(dayIso);

    if (index < 0 || index >= dayEvents.length) {
      return `I couldn't find event number ${index + 1} for ${formatDate(
        dayIso
      )}.`;
    }

    const ev = dayEvents[index];
    await cancelEventById(ev.calendarId, ev.id);

    return `🗑️ Done — I cancelled **${ev.summary.trim()}** on ${formatDate(
      ev.start.dateTime
    )} at ${formatTime(ev.start.dateTime)}.`;
  }

  // --------------------------------------------------
  // Case 2: "cancel Sergio", "cancel the Youtube Video"
  // --------------------------------------------------
  if (!target_event) {
    // strip the word "cancel" and trim whatever is left
    target_event = originalText.replace(/cancel/i, "").trim();
  }

  if (!target_event) return "Which event should I cancel?";

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) {
    return `I couldn't find any events matching "${target_event}" in the next few weeks.`;
  }

  if (matches.length === 1) {
    const m = matches[0];
    await cancelEventById(m.calendarId, m.id);
    return `🗑️ Done — I cancelled **${m.summary.trim()}** on ${formatDate(
      m.start.dateTime
    )} at ${formatTime(m.start.dateTime)}.`;
  }

  // Multiple matches – show a short list and tell Dean how to pick
  let out = "I found several events that could match:\n\n";
  matches.slice(0, 5).forEach((m, i) => {
    out += `${i + 1}. **${m.summary.trim()}** — ${formatDate(
      m.start.dateTime
    )} ${formatTime(m.start.dateTime)}\n`;
  });
  out += "\nReply with `cancel 1`, `cancel 2`, etc. to pick one.";

  return out;
}

// -----------------------------------------------
// RESCHEDULE (kept simple – exact time phrases work best)
// -----------------------------------------------
async function handleReschedule({ target_event, date, start_time }, originalMessage) {
  if (!target_event) {
    return "Which event should I move? For example: *“move Sergio to tomorrow 5pm”*.";
  }

  const matches = await searchEventsByText(target_event);

  if (matches.length === 0) {
    return `I couldn’t find any events that look like **"${target_event}"**.`;
  }

  if (!date || !start_time) {
    return "Right now I can reschedule only when you give me the new date *and* time, e.g. *“move Sergio to 2025-12-11 at 15:00”*.";
  }

  const ev = matches[0]; // simplest: take the best match
  const newStart = new Date(`${date}T${start_time}`);
  const newEnd = new Date(newStart.getTime() + DEFAULT_DURATION_MIN * 60000);

  try {
    await rescheduleEventById(ev.calendarId, ev.id, newStart, newEnd);
    return `🔄 All set — I’ve moved **${ev.summary}** to **${formatDate(
      newStart
    )}**, **${formatTime(newStart)}–${formatTime(newEnd)}**.`;
  } catch (err) {
    console.error("Reschedule error:", err);
    return "I tried to move that event but something went wrong. 😕";
  }
}

// -----------------------------------------------
// CREATE EVENT (uses human hours + error reporting)
// -----------------------------------------------
async function handleCreateEvent({ title, date, start_time, duration }, originalText) {
  if (!title) return "What should I call this event?";

  const now = new Date();
  const isoToday = now.toISOString().split("T")[0];
  const tmr = new Date(now);
  tmr.setDate(tmr.getDate() + 1);
  const isoTomorrow = tmr.toISOString().split("T")[0];

  const lower = originalText.toLowerCase();

  if (!date) {
    if (lower.includes("today")) date = isoToday;
    else if (lower.includes("tomorrow")) date = isoTomorrow;
    else date = isoToday; // default to today if not specified
  }

  const dur = duration ? parseInt(duration) : DEFAULT_DURATION_MIN;

  // If no explicit time: suggest slots instead of guessing
  if (!start_time) {
    const suggestions = await findOpenSlots(date, dur, 3);

    if (suggestions.length === 0) {
      return `I couldn't find any free ${dur}-minute slots on ${formatDate(
        date
      )}. Want me to check another day?`;
    }

    let out = `Here are good times for **${title}** on **${formatDate(
      date
    )}**:\n\n`;
    suggestions.forEach((s, i) => {
      out += `${i + 1}. ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
    });
    out += "\nReply with `1`, `2`, or `3` and I'll book it.";
    return out;
  }

  const start = new Date(`${date}T${start_time}`);
  const end = new Date(start.getTime() + dur * 60000);

  if (start.getHours() < MIN_HOUR || start.getHours() > MAX_HOUR) {
    return "That time is outside your preferred hours (08:00–22:00).";
  }

  try {
    const ev = await createEvent({ title, start, end });
    return `🎉 Done — I’ve added **${title}** on **${formatDate(
      start
    )}** from ${formatTime(start)} to ${formatTime(end)}.`;
  } catch (err) {
    return `I tried to add that event but Google Calendar returned an error. Please double-check that the service account has *Make changes to events* on your main calendar. You can see the exact error in the Render logs.`;
  }
}


// -----------------------------------------------
// FREE TIME
// -----------------------------------------------
async function handleFindFree({ date, duration }) {
  if (!date) return "Which date should I look at for free time?";

  const dur = duration ? parseInt(duration, 10) : DEFAULT_DURATION_MIN;
  const slots = await findOpenSlots(date, dur);

  if (slots.length === 0) {
    return `No free ${dur}-minute slots on **${formatDate(date)}**. 😕`;
  }

  let out = `🕒 **Your free ${dur}-minute slots on ${formatDate(date)}:**\n\n`;
  slots.forEach((s) => {
    out += `• ${formatTime(s.start)} – ${formatTime(s.end)}\n`;
  });

  return out;
}

// -----------------------------------------------
// DAY SUMMARY (fixed so "today/tomorrow" use real dates)
// -----------------------------------------------
async function handleDaySummary(dateFromIntent, originalText) {
  const lower = originalText.toLowerCase();
  const now = new Date();

  const isoToday = now.toISOString().split("T")[0];

  const tmr = new Date(now);
  tmr.setDate(tmr.getDate() + 1);
  const isoTomorrow = tmr.toISOString().split("T")[0];

  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  const isoYesterday = yest.toISOString().split("T")[0];

  let date = dateFromIntent; // what the model guessed

  // 🔒 Hard override for natural phrases – ignore the model’s date
  if (lower.includes("today")) {
    date = isoToday;
  } else if (lower.includes("tomorrow")) {
    date = isoTomorrow;
  } else if (lower.includes("yesterday")) {
    date = isoYesterday;
  } else if (!date) {
    // no date from model → default to today
    date = isoToday;
  }

  // Extra sanity check:
  // if the model gave a date > 1 year away and Dean didn't
  // explicitly type a year, snap back to today.
  try {
    const parsed = new Date(date);
    const diffDays = Math.abs((parsed - now) / (1000 * 60 * 60 * 24));
    const userMentionedYear = /\b20\d{2}\b/.test(originalText);

    if (diffDays > 365 && !userMentionedYear) {
      date = isoToday;
    }
  } catch {
    date = isoToday;
  }

  const events = await getEventsForDate(date);
  return renderEventList(events, formatDate(date));
}


// -----------------------------------------------
// RANGE SUMMARY
// -----------------------------------------------
async function handleRangeSummary(start, end) {
  if (!start || !end) {
    return "Which date range should I check? For example: *“my schedule next week”*.";
  }

  const events = await getEventsForRange(start, end);

  if (events.length === 0) {
    return `No events between **${formatDate(start)}** and **${formatDate(end)}**. 🎉`;
  }

  let out = `📆 **Your schedule from ${formatDate(start)} to ${formatDate(
    end
  )}:**\n\n`;

  events.forEach((ev) => {
    out += `• **${ev.summary}** — ${formatDate(
      ev.start.dateTime || ev.start.date
    )} (${formatTime(ev.start.dateTime || ev.start.date)})\n`;
  });

  return out;
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

function renderEventList(events, dateLabel = "") {
  if (!events || events.length === 0) {
    return `Your schedule is **wide open** on **${dateLabel}** 😎`;
  }

  let out = `📅 **Your schedule for ${dateLabel}:**\n\n`;

  events.forEach((ev, i) => {
    out += `${i + 1}. **${ev.summary.trim()}**${
      ev.location ? ` 📍${ev.location}` : ""
    } — ${formatTime(ev.start.dateTime || ev.start.date)} to ${formatTime(
      ev.end.dateTime || ev.end.date
    )}\n`;
  });

  out += `\nLet me know if you'd like changes, cancellations, or help planning the day! 😊`;
  return out;
}




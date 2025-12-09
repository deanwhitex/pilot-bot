// -----------------------------------------------------------------------------
// index.js — Discord Controller for Pilot (Chief-of-Staff Mode)
// -----------------------------------------------------------------------------

import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import cron from "node-cron";
import fs from "fs";
import OpenAI from "openai";
import { handleUserMessage, detectIntentType } from "./pilot.js";
import { getEventsForDate, getEventsForRange } from "./calendar.js";



// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const TIMEZONE = "Africa/Johannesburg";

const DAILY_CHANNEL = "1445756413472280668";      // Morning summaries
const WEEKLY_PLANNER_CHANNEL = "1448020304159969340"; // Sunday night planning

// OpenAI client (used for voice notes + priorities)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});



// -----------------------------------------------------------------------------
// DISCORD CLIENT
// -----------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});



client.once("ready", () => {
  console.log(`🔥 Pilot is online as ${client.user.tag}`);
  initSchedulers();
});



// -----------------------------------------------------------------------------
// MAIN MESSAGE HANDLER
// Responds to EVERY message Dean sends (no need to tag!)
// -----------------------------------------------------------------------------

client.on("messageCreate", async (message) => {
  if (!message) return;
  if (message.author.bot) return; // No loops

  // We prefer talking ONLY to Dean
  const deanIds = [
    "YOUR_DISCORD_ID_HERE" // Add yours here once you provide it
  ];

  // If you want the bot to respond to anyone, remove this check
  if (!deanIds.includes(message.author.id)) {
    return;  
  }

  // Handle voice notes
  if (message.attachments.size > 0) {
    const file = message.attachments.first();
    if (file.contentType?.includes("audio") || file.name.endsWith(".mp3") || file.name.endsWith(".wav") || file.name.endsWith(".m4a")) {
      const text = await transcribeVoice(file.url);
      const response = await handleUserMessage(text);

      return message.reply({
        content: response,
        flags: ["SuppressEmbeds"]
      });
    }
  }

  // If message contains NO scheduling intent → normal conversational AI
  const schedulingIntent = await detectIntentType(message.content);

  if (!schedulingIntent) {
    const reply = await handleUserMessage(message.content);
    return message.reply({
      content: reply,
      flags: ["SuppressEmbeds"]
    });
  }

  // If it *is* scheduling, route through Pilot brain
  try {
    const output = await handleUserMessage(message.content);

    return message.reply({
      content: output,
      flags: ["SuppressEmbeds"]
    });

  } catch (err) {
    console.error("Message handling error:", err);
    return message.reply("Sorry Dean — something went wrong. 😞");
  }
});



// -----------------------------------------------------------------------------
// VOICE NOTE TRANSCRIPTION
// -----------------------------------------------------------------------------

async function transcribeVoice(url) {
  try {
    const audio = await fetch(url);
    const buffer = Buffer.from(await audio.arrayBuffer());

    const transcript = await openai.audio.transcriptions.create({
      file: buffer,
      model: "gpt-4o-mini-tts",
      response_format: "text"
    });

    return transcript.text || "";
  } catch (err) {
    console.error("Voice transcription failed:", err);
    return "I couldn't transcribe that voice note.";
  }
}



// -----------------------------------------------------------------------------
// DAILY + WEEKLY SCHEDULERS
// -----------------------------------------------------------------------------

function initSchedulers() {
  // -------------------------------------------------------------------------
  // DAILY SUMMARY — EVERY DAY @ 7AM
  // -------------------------------------------------------------------------
  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(DAILY_CHANNEL);
        if (!channel) return;

        const today = new Date();
        const events = await getEventsForDate(today);

        let msg = `🌅 **Good morning Dean!**  
Here’s your schedule for **${today.toLocaleDateString("en-ZA")}**:\n\n`;

        if (events.length === 0) {
          msg += "You’re completely free today. 😎\n";
        } else {
          events.forEach((ev) => {
            msg += `• **${ev.summary}** — ${formatTime(ev.start.dateTime)}\n`;
          });
        }

        // Add AI priorities
        msg += await generateDailyPriorities(events);

        // Overload warning
        if (events.length >= 6) {
          msg += "\n⚠️ *Your day is very full. Pace yourself.*";
        }

        channel.send({ content: msg, flags: ["SuppressEmbeds"] });

      } catch (err) {
        console.error("Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );


  // -------------------------------------------------------------------------
  // WEEKLY PLANNING — EVERY SUNDAY @ 8PM
  // -------------------------------------------------------------------------
  cron.schedule(
    "0 20 * * SUN",
    async () => {
      try {
        const channel = await client.channels.fetch(WEEKLY_PLANNER_CHANNEL);
        if (!channel) return;

        const today = new Date();
        const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

        const events = await getEventsForRange(today, nextWeek);

        let msg = "🧠 **Weekly Planning Time, Dean**\n\n";

        if (events.length === 0) {
          msg += "Next week is completely open — let's build it intentionally.\n";
        } else {
          msg += "Here’s what’s coming up:\n\n";
          events.forEach((ev) => {
            msg += `• **${ev.summary}** — ${formatDate(ev.start.dateTime)} (${formatTime(ev.start.dateTime)})\n`;
          });
        }

        msg += `\nTell me:  
**“Plan my week”**  
**“Give me priorities”**  
**“Build a balanced week”**`;

        channel.send({ content: msg, flags: ["SuppressEmbeds"] });
      } catch (err) {
        console.error("Weekly planner error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  console.log("⏱️ Schedulers initialized.");
}



// -----------------------------------------------------------------------------
// AI PRIORITY LIST (daily)
// -----------------------------------------------------------------------------

async function generateDailyPriorities(events) {
  if (events.length === 0) return "\n📌 No priorities today.\n";

  try {
    const tasks = events.map((e) => e.summary).join(", ");

    const prompt = `
You are Dean’s Chief-of-Staff.

He has these events today:
${tasks}

Write a short, friendly, strategic **priority list**.
Be direct and supportive.
`;

    const out = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    });

    return `\n⭐ **Today's Priorities:**\n${out.choices[0].message.content}\n`;

  } catch (err) {
    console.error("Priority generation error:", err);
    return "\n⭐ Could not generate priorities.\n";
  }
}



// -----------------------------------------------------------------------------
// FORMAT HELPERS
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
// LOGIN
// -----------------------------------------------------------------------------

client.login(process.env.DISCORD_TOKEN);


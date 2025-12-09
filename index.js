// index.js
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import cron from "node-cron";
import { handleUserMessage, detectIntentType } from "./pilot.js";
import { getEventsForDate, getEventsForRange } from "./calendar.js";
import OpenAI from "openai";

// TIMEZONE SETTINGS
const TIMEZONE = "Africa/Johannesburg";
const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID;
const WEEKLY_CHANNEL_ID = "1448020304159969340"; // weekly-planner

// AI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------------------------------
// DISCORD CLIENT
// ----------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ----------------------------------------------------------
// READY
// ----------------------------------------------------------
client.once("ready", async () => {
  console.log(`🟢 Dean Pilot is online as ${client.user.tag}`);
  console.log(`Daily summaries → ${DAILY_CHANNEL_ID}`);
  console.log(`Weekly planning → ${WEEKLY_CHANNEL_ID}`);

  initSchedulers();
});

// ----------------------------------------------------------
// MESSAGE HANDLER
// Bot responds WITHOUT mention.
// ----------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const text = message.content.trim();

  // 1. Friendly greetings trigger conversation
  const greetings = ["hello", "hi", "hey", "morning", "evening", "yo", "sup"];
  if (greetings.includes(text.toLowerCase())) {
    return message.reply({
      content: "Hey Dean! 😊 How can I help?",
      flags: ["SuppressEmbeds"],
    });
  }

  // 2. Detect if message is a scheduling / planning request
  const isScheduling = await detectIntentType(text);

  if (!isScheduling) return; // not a bot-intended message

  try {
    const response = await handleUserMessage(text);

    await message.reply({
      content: response,
      flags: ["SuppressEmbeds"],
    });
  } catch (err) {
    console.error("❌ Bot error:", err);
    await message.reply("Sorry Dean, something went wrong. 😕");
  }
});

// ----------------------------------------------------------
// SCHEDULERS (Daily + Weekly)
// ----------------------------------------------------------
function initSchedulers() {
  // -------------------------------
  // DAILY SUMMARY @ 07:00
  // -------------------------------
  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(DAILY_CHANNEL_ID);
        if (!channel) return console.error("Daily channel not found.");

        const today = new Date();
        const events = await getEventsForDate(today);

        let msg = `🌅 **Good morning Dean! Here's your schedule for today (${today.toLocaleDateString(
          "en-ZA"
        )}):**\n\n`;

        if (events.length === 0) {
          msg += "You're wide open today 😎\n";
        } else {
          for (const ev of events) {
            msg += `• **${ev.summary}** — ${formatTime(
              ev.start.dateTime
            )} to ${formatTime(ev.end.dateTime)}\n`;
          }
        }

        // AI priorities
        msg += await generateDailyPriorities(events);

        // Overload warning
        if (events.length >= 6) {
          msg += `\n⚠️ *Heads up:* Today is extremely full — want me to lighten something?`;
        }

        channel.send({ content: msg, flags: ["SuppressEmbeds"] });
      } catch (err) {
        console.error("Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  // -------------------------------
  // WEEKLY PLANNING @ SUNDAY 20:00
  // -------------------------------
  cron.schedule(
    "0 20 * * SUN",
    async () => {
      try {
        const channel = await client.channels.fetch(WEEKLY_CHANNEL_ID);
        if (!channel)
          return console.error("Weekly planner channel not found.");

        const msg = `
📅 **Weekly Planning Time, Dean!**

It's Sunday 8PM — perfect moment to shape your upcoming week.

I can help organise:
• Gym sessions  
• Admin work  
• Client calls  
• Focus blocks  
• Personal time  
• Breaks & recovery  
• Project priorities  

Just reply **"plan my week"** and I'll guide you through step by step.
        `;

        channel.send({ content: msg, flags: ["SuppressEmbeds"] });
      } catch (err) {
        console.error("Weekly planning error:", err);
      }
    },
    { timezone: TIMEZONE }
  );
}

// ----------------------------------------------------------
// AI - DAILY PRIORITY LIST
// ----------------------------------------------------------
async function generateDailyPriorities(events) {
  if (!events || events.length === 0) return "\n📌 No major priorities today.\n";

  const tasks = events.map((e) => e.summary).join(", ");

  const prompt = `
You are Dean's AI chief-of-staff.

Here are today's events:
${tasks}

Write a short, clear, supportive list of his top priorities.
Tone: confident, friendly, strategic.
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    return `\n⭐ **Today's Priorities:**\n${completion.choices[0].message.content}\n`;
  } catch {
    return "\n⭐ Unable to generate priorities right now.\n";
  }
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------
function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });
}

// ----------------------------------------------------------
// LOGIN
// ----------------------------------------------------------
client.login(process.env.DISCORD_TOKEN);

// index.js
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import cron from "node-cron";
import { handleUserMessage } from "./pilot.js";
import { getEventsForDate, getEventsForRange } from "./calendar.js";
import OpenAI from "openai";

const TIMEZONE = "Africa/Windhoek";

// ----------------------------------------------------------
// SAFETY: Prevent duplicate bot processes (Render bug fix)
// ----------------------------------------------------------
if (global.pilotBotAlreadyStarted) {
  console.log("⚠️ Bot instance already running — skipping duplicate startup.");
  return;
}
global.pilotBotAlreadyStarted = true;

// ----------------------------------------------------------
// OPENAI CLIENT
// ----------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ----------------------------------------------------------
// DISCORD CLIENT
// ----------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`🚀 Dean Pilot is online as ${client.user.tag}`);
  initSchedulers();
});

// ----------------------------------------------------------
// MESSAGE HANDLER — reply ONLY when mentioned
// ----------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // prevent duplicate handling inside the same process
  if (message._handledByPilot) return;
  message._handledByPilot = true;

  if (!message.mentions.has(client.user)) return;

  // Clean message (remove @mention)
  const clean = message.content.replace(/<@!?\\d+>/g, "").trim();

  if (!clean) {
    return message.reply({
      content: "Hey Dean! How can I help with your schedule? 😊",
      flags: ["SuppressEmbeds"]
    });
  }

  try {
    const response = await handleUserMessage(clean);

    return message.reply({
      content: response,
      flags: ["SuppressEmbeds"] // stop showing Zoom preview
    });

  } catch (err) {
    console.error("Bot error:", err);
    return message.reply("Sorry Dean, something went wrong. 😕");
  }
});

// ----------------------------------------------------------
// SCHEDULERS — Daily & Weekly Summaries
// ----------------------------------------------------------
function initSchedulers() {
  const channelId = process.env.DAILY_CHANNEL_ID;

  if (!channelId) {
    console.error("❌ DAILY_CHANNEL_ID missing inside .env");
    return;
  }

  // 🕖 DAILY SUMMARY — 07:00 every day
  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const today = new Date();
        const events = await getEventsForDate(today);

        let msg = `🌅 **Good morning Dean! Here's your schedule for today (${today.toLocaleDateString(
          "en-ZA"
        )}):**\n\n`;

        if (events.length === 0) {
          msg += "You’re completely free today! 😎\n";
        } else {
          let i = 1;
          for (const ev of events) {
            msg += `${i}. **${ev.summary}** — ${formatTime(ev.start.dateTime)} to ${formatTime(
              ev.end.dateTime
            )}\n`;
            i++;
          }
        }

        msg += await generateDailyPriorities(events);

        if (events.length >= 6) {
          msg += `\n⚠️ *Heads up:* Today is extremely full. Consider blocking rest time.\n`;
        }

        return channel.send({
          content: msg,
          flags: ["SuppressEmbeds"]
        });

      } catch (err) {
        console.error("Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  // 📅 WEEKLY SUMMARY — Mondays @ 07:00
  cron.schedule(
    "0 7 * * MON",
    async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const today = new Date();
        const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

        const events = await getEventsForRange(today, nextWeek);

        let msg = `📆 **Happy Monday Dean! Here's your week overview:**\n\n`;

        if (events.length === 0) {
          msg += "This week is completely free! 🎉";
        } else {
          for (const ev of events) {
            msg += `• **${ev.summary}** — ${formatDate(
              ev.start.dateTime
            )} (${formatTime(ev.start.dateTime)}–${formatTime(
              ev.end.dateTime
            )})\n`;
          }
        }

        return channel.send({
          content: msg,
          flags: ["SuppressEmbeds"]
        });

      } catch (err) {
        console.error("Weekly summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );
}

// ----------------------------------------------------------
// AI PRIORITY LIST
// ----------------------------------------------------------
async function generateDailyPriorities(events) {
  if (events.length === 0) return "\n📌 No tasks today.\n";

  try {
    const tasks = events.map((e) => e.summary).join(", ");

    const prompt = `
You are Dean's friendly assistant.

Today's events:
${tasks}

Write a short list of **key priorities**.
Tone: friendly, helpful, motivating.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    return `\n⭐ **Today's Priorities:**\n${completion.choices[0].message.content}\n`;

  } catch (err) {
    console.error("Priority generation error:", err);
    return "\n⭐ Unable to generate priorities right now.\n";
  }
}

// ----------------------------------------------------------
// TIME HELPERS
// ----------------------------------------------------------
function formatDate(date) {
  return new Date(date).toLocaleDateString("en-ZA", { timeZone: TIMEZONE });
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE
  });
}

// ----------------------------------------------------------
// LOGIN
// ----------------------------------------------------------
client.login(process.env.DISCORD_TOKEN);


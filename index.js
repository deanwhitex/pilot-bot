// index.js
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import cron from "node-cron";
import { handleUserMessage, renderEventList } from "./pilot.js";
import { getEventsForDate, getEventsForRange } from "./calendar.js";

const TIMEZONE = process.env.TZ || "Africa/Johannesburg";

// Channel IDs (from Render env)
const CHANNEL_GENERAL = process.env.CHANNEL_GENERAL;
const CHANNEL_DAILY = process.env.CHANNEL_DAILY;
const CHANNEL_WEEKLY = process.env.CHANNEL_WEEKLY;

// ----------------------------------------------------------
// DISCORD CLIENT
// ----------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`🔥 Pilot is online as ${client.user.tag}`);
  initSchedulers();
});

// ----------------------------------------------------------
// SINGLE MESSAGE HANDLER (no duplicates)
// ----------------------------------------------------------
client.on("messageCreate", async (message) => {
  try {
    // 1) Never reply to ourselves
    if (message.author.bot) return;

    // 2) Optionally restrict to calendar channels only
    const allowedChannels = new Set(
      [CHANNEL_GENERAL, CHANNEL_DAILY, CHANNEL_WEEKLY].filter(Boolean)
    );
    if (allowedChannels.size && !allowedChannels.has(message.channelId)) {
      // Ignore messages in other channels
      return;
    }

    // 3) Ask pilot.js what to say
    const replyText = await handleUserMessage(message);

    // If pilot.js returns null/empty, don't reply
    if (!replyText) return;

    // 4) Exactly ONE reply per message
    await message.reply({
      content: replyText,
      // Suppress link previews by default
      flags: 1 << 2, // SuppressEmbeds bit
    });
  } catch (err) {
    console.error("messageCreate error:", err);
    try {
      await message.reply(
        "Sorry Dean, something went wrong while I was processing that. 😕"
      );
    } catch {
      /* ignore */
    }
  }
});

// ----------------------------------------------------------
// SCHEDULERS (Daily & Weekly)
// ----------------------------------------------------------
function initSchedulers() {
  console.log("⏰ Schedulers initialized.");

  // --- Daily schedule for TODAY at 08:00 local time ---
  if (CHANNEL_DAILY) {
    cron.schedule(
      "0 8 * * *",
      async () => {
        try {
          const channel = await client.channels.fetch(CHANNEL_DAILY);
          if (!channel) return;

          const today = new Date();
          const events = await getEventsForDate(today);
          const msg =
            "🌅 **Good morning Dean!**\n\n" +
            renderEventList(events, today, {
              includeHeader: false,
            });

          await channel.send({
            content: msg,
            flags: 1 << 2, // SuppressEmbeds
          });
        } catch (err) {
          console.error("Daily summary error:", err);
        }
      },
      { timezone: TIMEZONE }
    );
  } else {
    console.log("⚠️ CHANNEL_DAILY not set; daily summaries disabled.");
  }

  // --- Weekly planning message on Sunday 20:00 ---
  if (CHANNEL_WEEKLY) {
    cron.schedule(
      "0 20 * * 0",
      async () => {
        try {
          const channel = await client.channels.fetch(CHANNEL_WEEKLY);
          if (!channel) return;

          const today = new Date();
          const end = new Date(today);
          end.setDate(end.getDate() + 7);
          const events = await getEventsForRange(today, end);

          const header = "🧠 **Weekly planning time, Dean!**\n\n";
          const list = renderEventList(events, null, {
            includeHeader: false,
          });

          const msg =
            header +
            (events.length
              ? list
              : "You don’t have much on the calendar yet. Good week to be intentional. 😎");

          await channel.send({
            content: msg,
            flags: 1 << 2,
          });
        } catch (err) {
          console.error("Weekly planner error:", err);
        }
      },
      { timezone: TIMEZONE }
    );
  } else {
    console.log("⚠️ CHANNEL_WEEKLY not set; weekly planner disabled.");
  }
}

// ----------------------------------------------------------
// LOGIN
// ----------------------------------------------------------
client.login(process.env.DISCORD_TOKEN);

// index.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
} from "discord.js";
import cron from "node-cron";
import { handleUserMessage } from "./pilot.js";
import { getEventsForDate } from "./calendar.js";

const TIMEZONE = process.env.TZ || "Africa/Johannesburg";

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

client.once(Events.ClientReady, () => {
  console.log(`🔥 Pilot is online as ${client.user.tag}`);
  initSchedulers();
});

// ----------------------------------------------------------
// MESSAGE HANDLER – reply to ANY human message (no mention needed)
// ----------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    // ignore other bots (including itself)
    if (message.author.bot) return;

    const text = message.content.trim();
    if (!text) return;

    // Ask Pilot what to say
    const response = await handleUserMessage(text);
    if (!response || !response.trim()) return;

    await message.reply({
      content: response,
      // No embeds / Zoom previews
      flags: [MessageFlags.SuppressEmbeds],
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.error("Message handler error:", err);
    try {
      await message.reply(
        "Sorry Dean, something went wrong while I was checking your schedule. 😕"
      );
    } catch {
      // ignore secondary errors
    }
  }
});

// ----------------------------------------------------------
// DAILY SUMMARY – 08:00 every day in CHANNEL_DAILY
// ----------------------------------------------------------
function initSchedulers() {
  const dailyChannelId =
    process.env.CHANNEL_DAILY || process.env.DAILY_CHANNEL_ID;

  if (!dailyChannelId) {
    console.warn(
      "⚠️ No CHANNEL_DAILY / DAILY_CHANNEL_ID set – daily summary disabled."
    );
    return;
  }

  cron.schedule(
    "0 8 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(dailyChannelId);
        if (!channel) {
          console.warn("⚠️ Could not find daily channel:", dailyChannelId);
          return;
        }

        const today = new Date();
        const events = await getEventsForDate(today);
        const dateLabel = today.toISOString().slice(0, 10).replace(/-/g, "/");

        let msg;
        if (!events || events.length === 0) {
          msg = `🌅 Good morning Dean! Your schedule is *wide open* today (${dateLabel}). 😎`;
        } else {
          msg = `🌅 Good morning Dean! Here's your schedule for today (${dateLabel}):\n\n`;
          events.forEach((ev, idx) => {
            msg += `${idx + 1}. **${ev.summary.trim()}**${
              ev.location ? ` 📍${ev.location}` : ""
            } — ${formatTime(ev.start.dateTime)} to ${formatTime(
              ev.end.dateTime
            )}\n`;
          });
          msg +=
            `\nLet me know if you'd like changes, cancellations, or help planning the day! 😊`;
        }

        await channel.send({
          content: msg,
          flags: [MessageFlags.SuppressEmbeds],
        });
      } catch (err) {
        console.error("Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  console.log("⏰ Schedulers initialized (daily 08:00 summary).");
}

// ----------------------------------------------------------
// TIME FORMAT HELPER
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








// index.js – Pilot wiring + 8am daily summary for current day

import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
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
});

// ----------------------------------------------------------
// READY
// ----------------------------------------------------------
client.once("ready", () => {
  console.log(`🔥 Pilot is online as ${client.user.tag}`);
  initSchedulers();
});

// ----------------------------------------------------------
// MESSAGE HANDLER – reply to everything (except bots)
// ----------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  try {
    const reply = await handleUserMessage(message.content);

    if (!reply || reply.trim() === "") return;

    await message.reply({
      content: reply,
      // no embeds; links are already stripped in calendar.js
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.error("Message handler error:", err);
    try {
      await message.reply("Sorry Dean, something went wrong. 😕");
    } catch (_) {}
  }
});

// ----------------------------------------------------------
// SCHEDULERS
// ----------------------------------------------------------
function initSchedulers() {
  const dailyChannelId = process.env.CHANNEL_DAILY;
  if (!dailyChannelId) {
    console.error("❌ CHANNEL_DAILY is not set – daily summary disabled.");
    return;
  }

  // 8:00 AM every day – summary for TODAY
  cron.schedule(
    "0 8 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(dailyChannelId);
        if (!channel) {
          console.error("❌ Could not find daily summary channel.");
          return;
        }

        const today = new Date();
        const events = await getEventsForDate(today);

        const dateLabel = today.toLocaleDateString("en-ZA", {
          timeZone: TIMEZONE,
        });

        let msg = `🌅 **Good morning, Dean! Here's your schedule for today (${dateLabel}):**\n\n`;

        if (!events || events.length === 0) {
          msg += "You’re completely free today 😎\n";
        } else {
          events.forEach((ev, i) => {
            msg += `${i + 1}. **${(ev.summary || "").trim()}** ${
              ev.location ? `📍${ev.location}` : ""
            } — ${formatTime(ev.start.dateTime)} to ${formatTime(
              ev.end.dateTime
            )}\n`;
          });

          msg += `\nLet me know if you want to cancel, move, or add anything. 😊`;
        }

        await channel.send({
          content: msg,
          allowedMentions: { repliedUser: false },
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
// HELPERS
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






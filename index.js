// index.js (FULL RESET — Reply to everything, stable scheduling)
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { handleUserMessage } from "./pilot.js";
import cron from "node-cron";
import { getEventsForDate } from "./calendar.js";

const TIMEZONE = "Africa/Johannesburg";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  console.log(`🔥 Pilot is online as ${client.user.tag}`);
  initDailySummary();
});

// ----------------------------------------------------------
// 🌍 REPLY TO EVERYTHING ANYONE SAYS
// ----------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return; // ignore bots

  try {
    const reply = await handleUserMessage(message.content);

    await message.reply({
      content: reply,
      flags: ["SuppressEmbeds"] // hide link previews
    });

  } catch (err) {
    console.error("Pilot error:", err);
    message.reply("Sorry Dean — something went wrong. 😕");
  }
});

// ----------------------------------------------------------
// DAILY 7AM SUMMARY — sends to DAILY channel
// ----------------------------------------------------------
function initDailySummary() {
  const dailyChannelId = process.env.DAILY_CHANNEL_ID;

  if (!dailyChannelId) {
    console.error("❌ DAILY_CHANNEL_ID missing from .env");
    return;
  }

  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(dailyChannelId);
        if (!channel) return;

        const today = new Date();
        const events = await getEventsForDate(today);

        let msg = `🌅 **Good morning Dean! Here's your schedule for today (${today.toLocaleDateString(
          "en-ZA"
        )}):**\n\n`;

        if (events.length === 0) {
          msg += "You're completely free today! 😎";
        } else {
          events.forEach((ev) => {
            msg += `• **${ev.summary.trim()}** — ${formatTime(
              ev.start.dateTime
            )} to ${formatTime(ev.end.dateTime)}\n`;
          });
        }

        channel.send({
          content: msg,
          flags: ["SuppressEmbeds"]
        });

      } catch (err) {
        console.error("Daily Summary Error:", err);
      }
    },
    { timezone: TIMEZONE }
  );
}

// ----------------------------------------------------------
function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE
  });
}

client.login(process.env.DISCORD_TOKEN);




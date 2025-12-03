// index.js
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import cron from "node-cron";
import { handleUserMessage } from "./pilot.js";
import { getEventsForDate, getEventsForRange } from "./calendar.js";

const TIMEZONE = "Africa/Johannesburg";

/* ----------------------------------------------------------
   DISCORD CLIENT
---------------------------------------------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`✅ Dean Pilot is online as ${client.user.tag}`);
  initSchedulers();
});

/* ----------------------------------------------------------
   MESSAGE HANDLER — bot only replies when mentioned
---------------------------------------------------------- */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Only respond when bot is tagged
  if (!message.mentions.has(client.user)) return;

  // Remove the @mention text
  const clean = message.content.replace(/<@!?\\d+>/g, "").trim();

  if (!clean) {
    return message.reply({
      content: "Hey Dean! 😊 What can I help you with?",
      flags: ["SuppressEmbeds"],
    });
  }

  try {
    const response = await handleUserMessage(clean);

    return message.reply({
      content: response,
      flags: ["SuppressEmbeds"], // make sure Zoom links don't preview
    });
  } catch (err) {
    console.error("❌ Error handling message:", err);
    return message.reply({
      content: "Sorry Dean, something went wrong 😕",
      flags: ["SuppressEmbeds"],
    });
  }
});

/* ----------------------------------------------------------
   SCHEDULERS — daily summary + weekly summary
---------------------------------------------------------- */
function initSchedulers() {
  const channelId = process.env.DAILY_CHANNEL_ID;

  if (!channelId) {
    console.error("❌ DAILY_CHANNEL_ID missing in your .env");
    return;
  }

  /* -----------------------------------------------
     🕖 DAILY SUMMARY — 7AM South Africa Time
  ----------------------------------------------- */
  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const today = new Date();
        const events = await getEventsForDate(today);

        let msg = `🌅 **Good morning Dean! Here's your schedule for today (${formatDate(
          today
        )}):**\n\n`;

        if (events.length === 0) {
          msg += "✨ You're completely free today! 😎\n";
        } else {
          events.forEach((ev, i) => {
            msg += `${i + 1}. **${ev.summary}** — ${formatTime(
              ev.start.dateTime
            )} to ${formatTime(ev.end.dateTime)}\n`;
          });
        }

        channel.send({
          content: msg,
          flags: ["SuppressEmbeds"],
        });
      } catch (err) {
        console.error("❌ Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  /* -----------------------------------------------
     📅 WEEKLY SUMMARY — Monday at 7AM
  ----------------------------------------------- */
  cron.schedule(
    "0 7 * * MON",
    async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const today = new Date();
        const nextWeek = new Date(today.getTime() + 7 * 86400000);

        const events = await getEventsForRange(today, nextWeek);

        let msg = `📆 **Happy Monday! Here's your week overview:**\n\n`;

        if (events.length === 0) {
          msg += "✨ You have no events scheduled this week! 🎉";
        } else {
          events.forEach((ev) => {
            msg += `• **${ev.summary}** — ${formatDate(
              ev.start.dateTime
            )} (${formatTime(ev.start.dateTime)}–${formatTime(
              ev.end.dateTime
            )})\n`;
          });
        }

        channel.send({
          content: msg,
          flags: ["SuppressEmbeds"],
        });
      } catch (err) {
        console.error("❌ Weekly summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );
}

/* ----------------------------------------------------------
   Formatting
---------------------------------------------------------- */
function formatDate(date) {
  return new Date(date).toLocaleDateString("en-ZA", {
    timeZone: TIMEZONE,
  });
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });
}

/* ----------------------------------------------------------
   LOGIN
---------------------------------------------------------- */
client.login(process.env.DISCORD_TOKEN);

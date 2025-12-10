// index.js
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import cron from "node-cron";
import { handleUserMessage } from "./pilot.js";
import { getEventsForDate } from "./calendar.js";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const TIMEZONE = process.env.TZ || "Africa/Johannesburg";
const CHANNEL_DAILY = process.env.CHANNEL_DAILY;   // daily 08:00 summary

// ---------------------------------------------------------------------------
// DISCORD CLIENT
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`🔥 Pilot is online as ${client.user.tag}`);
  initSchedulers();
});

// ---------------------------------------------------------------------------
// MESSAGE HANDLER – EXACTLY ONE REPLY PER HUMAN MESSAGE
// ---------------------------------------------------------------------------
client.on("messageCreate", async (message) => {
  try {
    // ignore other bots (including Pilot itself)
    if (message.author.bot) return;

    const text = message.content?.trim();
    if (!text) return;

    // Ask Pilot what to say
    const replyText = await handleUserMessage(text);

    // If Pilot returns nothing, do nothing
    if (!replyText || !replyText.trim()) return;

    // Send reply
    const sent = await message.reply({ content: replyText });

    // Suppress ugly link previews (Zoom etc.)
    try {
      if (sent && typeof sent.suppressEmbeds === "function") {
        await sent.suppressEmbeds(true);
      }
    } catch (err) {
      console.warn("Failed to suppress embeds:", err.message || err);
    }
  } catch (err) {
    console.error("messageCreate error:", err);
    try {
      await message.reply("Sorry Dean, something went wrong. 😕");
    } catch {
      // ignore secondary failure
    }
  }
});

// ---------------------------------------------------------------------------
// DAILY SUMMARY SCHEDULER – 08:00 LOCAL TIME
// ---------------------------------------------------------------------------
function initSchedulers() {
  if (!CHANNEL_DAILY) {
    console.warn("⚠️ CHANNEL_DAILY not set; skipping daily summary scheduler.");
    return;
  }

  // 08:00 every day
  cron.schedule(
    "0 8 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(CHANNEL_DAILY);
        if (!channel) {
          console.warn("⚠️ Could not find daily channel:", CHANNEL_DAILY);
          return;
        }

        const today = new Date();
        const events = await getEventsForDate(today);

        const label = today.toLocaleDateString("en-ZA", {
          timeZone: TIMEZONE,
        });

        let msg;

        if (!events.length) {
          msg = `🌅 **Good morning Dean!**\n\nYour schedule is *wide open* today (**${label}**). 😎`;
        } else {
          msg = `🌅 **Good morning Dean! Here's your schedule for today (${label}):**\n\n`;

          events.forEach((ev, i) => {
            const startRaw = ev.start.dateTime || ev.start.date;
            const endRaw = ev.end.dateTime || ev.end.date;

            const startStr = new Date(startRaw).toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: TIMEZONE,
            });

            const endStr = new Date(endRaw).toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: TIMEZONE,
            });

            const location = ev.location ? ` 📍${ev.location}` : "";

            msg += `${i + 1}. **${(ev.summary || "").trim()}**${location} — ${startStr} to ${endStr}\n`;
          });

          msg += `\nLet me know if you'd like changes, cancellations, or help planning the day! 😊`;
        }

        const sent = await channel.send(msg);

        // Suppress previews in the daily summary too
        try {
          if (sent && typeof sent.suppressEmbeds === "function") {
            await sent.suppressEmbeds(true);
          }
        } catch (err) {
          console.warn("Failed to suppress embeds on daily summary:", err.message || err);
        }
      } catch (err) {
        console.error("Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  console.log("⏰ Schedulers initialized (daily 08:00 summary).");
}

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------
client.login(process.env.DISCORD_TOKEN);

// index.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import cron from "node-cron";
import { handleUserMessage } from "./pilot.js";
import { getEventsForDate } from "./calendar.js";

const TIMEZONE = process.env.TZ || "Africa/Johannesburg";

/* ------------------------------------------------------------------ */
/* DISCORD CLIENT */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* MESSAGE HANDLER – SINGLE REPLY, NO DUPLICATES */
/* ------------------------------------------------------------------ */

client.on("messageCreate", async (message) => {
  try {
    // Ignore bots (including Pilot himself)
    if (message.author.bot) return;

    const raw = message.content ?? "";

    // Strip THIS bot's mention from the message text (in case they tag him)
    let cleaned = raw;
    if (client.user && client.user.id) {
      const mentionRegex = new RegExp(`<@!?${client.user.id}>`, "g");
      cleaned = raw.replace(mentionRegex, "").trim();
    } else {
      cleaned = raw.trim();
    }

    const textForAI = cleaned || raw.trim();

    // If there's literally no text (e.g. just an image), don't reply
    if (!textForAI) return;

    // 🔥 ALWAYS reply to human messages (no “isMentioned / looksScheduling” gating)
    const replyText = await handleUserMessage(textForAI);

    // Don't send empty replies
    if (!replyText || !replyText.trim()) return;

    await message.reply({
      content: replyText,
      flags: MessageFlags.SuppressEmbeds, // no link previews
    });
  } catch (err) {
    console.error("messageCreate error:", err);
    try {
      await message.reply({
        content:
          "Sorry Dean, I ran into a problem while looking at that. 😕",
        flags: MessageFlags.SuppressEmbeds,
      });
    } catch {
      // ignore secondary failures
    }
  }
});

/* ------------------------------------------------------------------ */
/* DAILY SUMMARY – 08:00 LOCAL TIME */
/* ------------------------------------------------------------------ */

function initSchedulers() {
  const dailyChannelId =
    process.env.CHANNEL_DAILY ||
    process.env.DAILY_CHANNEL_ID ||
    process.env.DAILY_CHANNEL;

  if (!dailyChannelId) {
    console.warn(
      "⚠️ No CHANNEL_DAILY / DAILY_CHANNEL_ID set – skipping daily summary."
    );
    return;
  }

  // 08:00 every day
  cron.schedule(
    "0 8 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(dailyChannelId);
        if (!channel) {
          console.warn("⚠️ Daily summary channel not found.");
          return;
        }

        const today = new Date();
        const events = await getEventsForDate(today);

        const dateLabel = today.toLocaleDateString("en-ZA", {
          timeZone: TIMEZONE,
        });

        let msg = "";

        if (!events.length) {
          msg = `🌅 **Good morning Dean!**\nYour schedule is *wide open* today (${dateLabel}). 😎`;
        } else {
          msg = `🌅 **Good morning Dean! Here's your schedule for today (${dateLabel}):**\n\n`;

          events.forEach((ev, index) => {
            const title = stripLinks(ev.summary || "Untitled").trim();
            const start = ev.start.dateTime || ev.start.date;
            const end = ev.end.dateTime || ev.end.date;

            msg += `${index + 1}. **${title}** — ${formatTime(
              start
            )} to ${formatTime(end)}\n`;
          });
        }

        await channel.send({
          content: msg,
          flags: MessageFlags.SuppressEmbeds, // no Zoom / link previews
        });
      } catch (err) {
        console.error("Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  console.log("⏰ Schedulers initialized (daily 08:00 summary).");
}

/* ------------------------------------------------------------------ */
/* SMALL HELPERS */
/* ------------------------------------------------------------------ */

function stripLinks(text) {
  // Remove any visible URLs so Discord can't create cards
  return text ? text.replace(/https?:\/\/\S+/gi, "") : "";
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });
}

/* ------------------------------------------------------------------ */
/* LOGIN */
/* ------------------------------------------------------------------ */

client.login(process.env.DISCORD_TOKEN);







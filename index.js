// index.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";
import cron from "node-cron";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import OpenAI from "openai";

import {
  handleUserMessage,
  detectIntentType,
} from "./pilot.js";

import {
  getEventsForDate,
} from "./calendar.js";

// ---------------------------------------------
// CONSTANTS
// ---------------------------------------------
const TIMEZONE = "Africa/Johannesburg";

// CHANNEL ROUTING
const CHANNEL_GENERAL = "1445737224879738945";      // pilot-general
const CHANNEL_DAILY = "1445756413472280668";        // daily summary
const CHANNEL_WEEKLY = "1448020304159969340";       // weekly planning

// ---------------------------------------------
// DISCORD CLIENT
// ---------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once(Events.ClientReady, () => {
  console.log(`🤖 Dean Pilot Online — Logged in as ${client.user.tag}`);
  initSchedulers();
});

// ---------------------------------------------
// OPENAI CLIENT (for voice notes)
// ---------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------
// MESSAGE HANDLING (NO DOUBLE REPLIES)
// ---------------------------------------------
// Bot replies to EVERYTHING from ANYONE (not just mentions)
client.on(Events.MessageCreate, async (message) => {
  try {
    // Ignore messages from itself
    if (message.author.id === client.user.id) return;

    // HANDLE VOICE NOTES
    if (message.attachments.size > 0) {
      const audioAttachment = message.attachments.find((att) =>
        att.contentType?.includes("audio")
      );

      if (audioAttachment) {
        const transcript = await transcribeAudio(audioAttachment.url);

        if (!transcript) {
          await safeReply(message, "Sorry Dean, I couldn’t process the voice note.");
          return;
        }

        // Now treat transcript as the user's message
        const response = await handleUserMessage(transcript);
        await safeReply(message, response);
        return;
      }
    }

    // NORMAL TEXT MESSAGE
    const text = message.content.trim();
    if (!text) return;

    const reply = await handleUserMessage(text);
    await safeReply(message, reply);

  } catch (err) {
    console.error("Message handler error:", err);
  }
});

// ---------------------------------------------
// SAFE REPLY (NO EMBED PREVIEWS)
// ---------------------------------------------
async function safeReply(message, content) {
  return message.reply({
    content,
    allowedMentions: { repliedUser: false },
    flags: ["SuppressEmbeds"],
  });
}

// ---------------------------------------------
// VOICE TRANSCRIPTION
// ---------------------------------------------
async function transcribeAudio(url) {
  try {
    const tmpFile = "./audio_tmp.wav";

    await new Promise((resolve, reject) => {
      ffmpeg(url)
        .setFfmpegPath(ffmpegPath)
        .output(tmpFile)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: "whisper-1",
      language: "en",
    });

    fs.unlinkSync(tmpFile);

    return response.text;
  } catch (err) {
    console.error("Voice transcription error:", err);
    return null;
  }
}

// ---------------------------------------------
// SCHEDULERS
// ---------------------------------------------
function initSchedulers() {
  // ---------------------------------------------
  // DAILY SUMMARY — 08:00
  // ---------------------------------------------
  cron.schedule(
    "0 8 * * *",
    async () => {
      try {
        const channel = await client.channels.fetch(CHANNEL_DAILY);
        if (!channel) return;

        const today = new Date();
        const events = await getEventsForDate(today);

        let msg = `🌅 **Good morning Dean! Here is your schedule for today (${today.toLocaleDateString(
          "en-ZA"
        )}):**\n\n`;

        if (events.length === 0) {
          msg += "You're completely free today 😎";
        } else {
          events.forEach((ev) => {
            msg += `• **${ev.summary}** — ${formatTime(
              ev.start.dateTime
            )}\n`;
          });
        }

        await channel.send({
          content: msg,
          flags: ["SuppressEmbeds"],
        });
      } catch (err) {
        console.error("Daily summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  // ---------------------------------------------
  // WEEKLY PLANNING — Sunday 20:00
  // ---------------------------------------------
  cron.schedule(
    "0 20 * * SUN",
    async () => {
      try {
        const channel = await client.channels.fetch(CHANNEL_WEEKLY);
        if (!channel) return;

        const msg = `
🧭 **Weekly Planning Reminder**

Dean, it's Sunday evening — time to prepare for the week ahead.

You can say:
• **Plan my week with priorities**  
• **Plan my week around energy**  
• **Build a balanced week**  
• **Show next week’s schedule**  
`;

        await channel.send({
          content: msg,
          flags: ["SuppressEmbeds"],
        });
      } catch (err) {
        console.error("Weekly summary error:", err);
      }
    },
    { timezone: TIMEZONE }
  );
}

// ---------------------------------------------
// FORMATTING HELPERS
// ---------------------------------------------
function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });
}

// ---------------------------------------------
// LOGIN
// ---------------------------------------------
client.login(process.env.DISCORD_TOKEN);



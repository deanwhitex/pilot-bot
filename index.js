import { Client, GatewayIntentBits, Partials } from "discord.js";
import schedule from "node-schedule";
import OpenAI from "openai";
import { getEventsForDate } from "./calendar.js";
import { transcribeAudio } from "./speech.js";
import { interpretMessage } from "./pilot.js";
import dotenv from "dotenv";
dotenv.config();

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Attachment]
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Parse natural language date (“today”, “tomorrow” only for now)
function parseDate(text) {
  const lower = text.toLowerCase();
  const now = new Date();

  if (lower.includes("tomorrow")) {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  return now;
}

// Message handler
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  let content = message.content;

  // Voice note detection & transcription
  if (message.attachments.size > 0) {
    const file = message.attachments.first();
    if (file?.contentType?.startsWith("audio")) {
      content = await transcribeAudio(file.url);
    }
  }

  // Does message ask for schedule?
  const triggers = ["schedule", "today", "tomorrow", "meeting", "calendar"];
  if (!triggers.some(t => content.toLowerCase().includes(t))) return;

  // Get events for requested date
  const date = parseDate(content);
  const events = await getEventsForDate(date);

  // Ask Pilot to format response
  const reply = await interpretMessage(openai, content, events);

  message.reply(reply);
});

// Daily 7am summary
schedule.scheduleJob("0 7 * * *", async () => {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const channel = guild.channels.cache.find(
    (c) => c.name === process.env.SUMMARY_CHANNEL
  );
  if (!channel) return;

  const events = await getEventsForDate(new Date());
  const reply = await interpretMessage(openai, "Give today's schedule", events);

  channel.send("**🗓 Daily Summary**\n\n" + reply);
});

// Login
client.login(process.env.DISCORD_TOKEN);

// index.js
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import cron from "node-cron";
import { handleUserMessage } from "./pilot.js";
import { getEventsForDate } from "./calendar.js";

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

/* ----------------------------------------------------------
   MESSAGE HANDLING — Reply to EVERYTHING
---------------------------------------------------------- */
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const response = await handleUserMessage(msg.content);
  msg.reply(response);
});

/* ----------------------------------------------------------
   DAILY SUMMARY — 8 PM
---------------------------------------------------------- */
function initSchedulers() {
  const dailyChannel = "1445756413472280668";

  // Every day at 20:00
  cron.schedule("0 20 * * *", async () => {
    const channel = await client.channels.fetch(dailyChannel);
    if (!channel) return;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const events = await getEventsForDate(tomorrow);

    let out = `🌅 **Tomorrow’s Schedule (${tomorrow.toLocaleDateString("en-ZA")}):**\n\n`;

    if (!events.length) out += "You're completely free! 😎";
    else {
      events.forEach((ev, i) => {
        out += `${i + 1}. **${ev.summary}** — ${new Date(
          ev.start.dateTime
        ).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}\n`;
      });
    }

    channel.send(out);
  });
}

client.login(process.env.DISCORD_TOKEN);





import axios from "axios";
import fs from "fs";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function transcribeAudio(url) {
  const output = "/tmp/audio.ogg";

  // Download audio
  const audioRes = await axios.get(url, {
    responseType: "arraybuffer"
  });

  fs.writeFileSync(output, Buffer.from(audioRes.data));

  // Send to OpenAI for transcription
  const transcript = await openai.audio.transcriptions.create({
    file: fs.createReadStream(output),
    model: "gpt-4o-transcribe"
  });

  return transcript.text;
}

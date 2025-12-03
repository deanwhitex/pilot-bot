export async function interpretMessage(openai, content, events) {
  const messages = [
    {
      role: "system",
      content: `You are Pilot, an elite personal assistant.
You interpret user questions about their schedule.
You respond cleanly, concisely, and helpfully.
Format times in a readable way.
`
    },
    {
      role: "user",
      content: `
User query: ${content}
Events: ${JSON.stringify(events)}
`
    }
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages
  });

  return response.choices[0].message.content;
}

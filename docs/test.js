const { OpenAI } = require("openai");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // prueba primero con este modelo
      messages: [{ role: "user", content: "Hola, ¿cómo estás?" }],
    });
    console.log("Respuesta:", completion.choices[0].message.content);
  } catch (error) {
    console.error("❌ Error:", error);
  }
})();

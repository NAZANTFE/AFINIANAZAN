const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/chat", async (req, res) => {
  const { mensaje } = req.body;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Eres AfinIA, una IA cálida y empática que ayuda al usuario a mejorar sus parámetros personales." },
        { role: "user", content: mensaje }
      ]
    });

    res.json({ respuesta: completion.choices[0].message.content });
  } catch (error) {
    console.error("Error en la API de OpenAI:", error.message);
    res.status(500).json({ error: "Error al conectar con OpenAI" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));

// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Datos de ejemplo (luego lo puedes conectar a una base de datos)
let parametrosUsuario = {
  "Nivel AfinIA": 75,
  "Inteligencia": 88,
  "Simpatía": 72,
  "Comunicación": 91,
  "Carisma": 85,
  "Creatividad": 69,
  "Resolución de conflictos": 77,
  "Iniciativa": 83,
  "Organización": 65,
  "Impulso personal": 80
};

// Endpoint para enviar parámetros al frontend
app.get("/parametros", (req, res) => {
  res.json(parametrosUsuario);
});

// Endpoint para conversar con la IA
app.post("/chat", async (req, res) => {
  try {
    const { mensaje } = req.body;

    const respuesta = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Eres AfinIA, una IA cálida y motivadora que ayuda al usuario a crecer personalmente." },
          { role: "user", content: mensaje }
        ]
      })
    });

    const datos = await respuesta.json();
    const textoIA = datos.choices?.[0]?.message?.content || "No pude generar una respuesta en este momento.";

    res.json({ respuesta: textoIA });

  } catch (error) {
    console.error("Error en /chat:", error);
    res.status(500).json({ error: "Error al conectar con la IA" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor AfinIA corriendo en http://localhost:${PORT}`);
});

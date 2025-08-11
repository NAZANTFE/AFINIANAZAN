// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();
const app = express();
app.use(express.json());

// ==== Config paths ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;

// ==== Servir frontend ====
app.use(express.static(path.join(__dirname, "frontend")));

// ==== Cargar parámetros desde archivo JSON ====
const PARAM_FILE = path.join(__dirname, "parametros_usuario.json");
function cargarParametros() {
  if (!fs.existsSync(PARAM_FILE)) {
    fs.writeFileSync(PARAM_FILE, JSON.stringify({
      "Nivel AfinIA": 10,
      "Inteligencia": 10,
      "Simpatía": 10,
      "Comunicación": 10,
      "Carisma": 10,
      "Creatividad": 10,
      "Resolución de conflictos": 10,
      "Iniciativa": 10,
      "Organización": 10,
      "Impulso personal": 10
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(PARAM_FILE, "utf-8"));
}

function guardarParametros(datos) {
  fs.writeFileSync(PARAM_FILE, JSON.stringify(datos, null, 2));
}

// ==== Endpoint: obtener parámetros ====
app.get("/parametros", (req, res) => {
  res.json(cargarParametros());
});

// ==== Endpoint: chat con IA ====
app.post("/chat", async (req, res) => {
  const mensajeUsuario = req.body.mensaje || "";

  try {
    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Eres AfinIA, una IA muy cariñosa, empática y cálida. No seas robótica. Conversa como una amiga cercana, con naturalidad, usando un tono afectuoso y escuchando. No hagas preguntas directas todo el tiempo, fluye y responde con comprensión y dulzura." },
          { role: "user", content: mensajeUsuario }
        ],
        temperature: 0.9
      })
    });

    if (!completion.ok) {
      console.error("Error OpenAI:", await completion.text());
      return res.status(500).json({ respuesta: "Uy… hubo un problema al conectar. ¿Quieres que lo intentemos de nuevo más tarde? 💗" });
    }

    const data = await completion.json();
    const respuestaIA = data.choices[0]?.message?.content?.trim() || "Aquí estoy contigo 💞";

    // ==== Ajustar parámetros suavemente ====
    const parametros = cargarParametros();
    const claves = Object.keys(parametros).filter(k => k !== "Nivel AfinIA");
    const aleatorio = claves[Math.floor(Math.random() * claves.length)];

    // Sube un valor muy poquito para evitar exageraciones
    parametros[aleatorio] = Math.min(parametros[aleatorio] + 1, 100);

    // Nivel AfinIA crece más despacio
    parametros["Nivel AfinIA"] = Math.min(parametros["Nivel AfinIA"] + 0.5, 100);

    guardarParametros(parametros);

    res.json({ respuesta: respuestaIA });

  } catch (error) {
    console.error("Error en /chat:", error);
    res.status(500).json({ respuesta: "Lo siento, algo falló. Estoy aquí si quieres volver a intentarlo 🫂" });
  }
});

// ==== Redirección para rutas desconocidas (evita 404 al refrescar) ====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// ==== Iniciar servidor ====
app.listen(PORT, () => {
  console.log(`✅ Servidor AfinIA escuchando en puerto ${PORT}`);
});

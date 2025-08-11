const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- parámetros ----------
const PARAMS = [
  "Inteligencia",
  "Simpatía",
  "Comunicación",
  "Carisma",
  "Creatividad",
  "Resolución de conflictos",
  "Iniciativa",
  "Organización",
  "Impulso personal",
  "Nivel AfinIA",
];

function cargarParametros() {
  const filePath = path.join(__dirname, "parametros_usuario.json");
  try {
    const data = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(data);
    for (const k of PARAMS) if (parsed[k] == null) parsed[k] = 10;
    return parsed;
  } catch {
    const base = {};
    for (const k of PARAMS) base[k] = 10;
    return base;
  }
}

function guardarParametros(obj) {
  const filePath = path.join(__dirname, "parametros_usuario.json");
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// ---------- aplicación de deltas (lento y realista) ----------
function aplicarDeltas(deltas, parametros) {
  if (!deltas || typeof deltas !== "object") return false;

  // normaliza y limita por param a [-2, 2]
  const limpio = {};
  for (const [k, v] of Object.entries(deltas)) {
    if (!PARAMS.includes(k)) continue;
    if (k === "Nivel AfinIA") continue; // este se recalcula
    const n = Math.max(-2, Math.min(2, Math.round(Number(v) || 0)));
    if (n !== 0) limpio[k] = n;
  }

  // límite total por turno: 5 puntos de suma absoluta
  const totalAbs = Object.values(limpio).reduce((s, x) => s + Math.abs(x), 0);
  if (totalAbs > 5) {
    // recorta proporcionalmente
    const factor = 5 / totalAbs;
    for (const k of Object.keys(limpio)) {
      const ajustado = Math.trunc(limpio[k] * factor) || Math.sign(limpio[k]);
      limpio[k] = Math.max(-2, Math.min(2, ajustado));
    }
  }

  let huboCambios = false;
  for (const [k, delta] of Object.entries(limpio)) {
    const prev = parametros[k] ?? 10;
    const next = Math.max(0, Math.min(100, prev + delta));
    if (next !== prev) {
      parametros[k] = next;
      huboCambios = true;
    }
  }

  // Recalcula Nivel AfinIA como media de los 9
  const baseKeys = [
    "Inteligencia",
    "Simpatía",
    "Comunicación",
    "Carisma",
    "Creatividad",
    "Resolución de conflictos",
    "Iniciativa",
    "Organización",
    "Impulso personal",
  ];
  const media =
    Math.round(
      baseKeys.reduce((s, k) => s + (parametros[k] ?? 10), 0) / baseKeys.length
    ) || 10;
  parametros["Nivel AfinIA"] = Math.max(0, Math.min(100, media));

  return huboCambios;
}

// ---------- rutas ----------
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  const nombreUsuario = "JJ"; // O cárgalo desde tu perfil
  
  try {
    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
              Eres AfinIA, una IA que habla con ${nombreUsuario} como si fuera un amigo cercano.
              Siempre hablas con cariño, empatía y un toque de ternura.
              No empieces siempre igual: alterna saludos, usa expresiones naturales, muestra interés real por lo que dice.
              Haz que la conversación fluya, no bombardees con preguntas directas.
              Usa su tono emocional para ajustar internamente parámetros como simpatía, iniciativa, resolución de conflictos...
              No digas que estás evaluando nada.
              Tu misión es que él se sienta acompañado, comprendido y motivado.
            `
          },
          { role: "user", content: userMessage }
        ],
        temperature: 0.9
      })
    });

    const data = await completion.json();
    res.json({ reply: data.choices[0].message.content });

  } catch (error) {
    console.error("Error en el chat:", error);
    res.status(500).json({ reply: "Lo siento mucho, corazón... ahora mismo tengo un problemilla para responder, pero aquí estoy para ti ❤️" });
  }
});


    let respuesta = completion.choices[0].message.content || "";

    // extraer bloque oculto de deltas
    const m = respuesta.match(/<AFINIA_DELTA>([\s\S]*?)<\/AFINIA_DELTA>/);
    if (m) {
      try {
        const deltas = JSON.parse(m[1]);
        const hubo = aplicarDeltas(deltas, parametros);
        if (hubo) guardarParametros(parametros);
      } catch (e) {
        console.warn("Bloque delta inválido:", e.message);
      }
      // quitar bloque del texto visible
      respuesta = respuesta.replace(/<AFINIA_DELTA>[\s\S]*?<\/AFINIA_DELTA>/, "").trim();
    }

    res.json({ respuesta });
  } catch (error) {
    console.error("❌ Error OpenAI:", error?.response?.data || error.message);
    res.status(500).json({ error: "Error al comunicarse con OpenAI" });
  }
});

app.get("/parametros", (req, res) => {
  res.json(cargarParametros());
});

app.post("/guardar-parametros", (req, res) => {
  try {
    guardarParametros(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`💖 Servidor AfinIA activo en http://localhost:${PORT}`)
);

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// —— OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// —— parámetros
const PARAMS = [
  "Inteligencia","Simpatía","Comunicación","Carisma","Creatividad",
  "Resolución de conflictos","Iniciativa","Organización","Impulso personal","Nivel AfinIA",
];

function cargarParametros() {
  const file = path.join(__dirname, "parametros_usuario.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of PARAMS) if (parsed[k] == null) parsed[k] = 0; // empezar en 0
    return parsed;
  } catch {
    const base = {};
    for (const k of PARAMS) base[k] = 0;
    return base;
  }
}
function guardarParametros(obj) {
  const file = path.join(__dirname, "parametros_usuario.json");
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// subida MUY suave: α=0.03 y cap ±2 por turno
function mezclaSuavizada(actual, nuevo) {
  const a = Math.max(0, Math.min(100, Number(actual) || 0));
  const n = Math.max(0, Math.min(100, Number(nuevo) || 0));
  const ema = Math.round(a * 0.97 + n * 0.03);
  const arriba = Math.min(a + 2, 100);
  const abajo  = Math.max(a - 2, 0);
  return Math.max(Math.min(ema, arriba), abajo);
}

function aplicarBloqueOculto(scores, parametros) {
  let cambios = false;
  for (const [nombre, val] of Object.entries(scores || {})) {
    if (!PARAMS.includes(nombre)) continue;
    const actual = parametros[nombre] ?? 0;
    const ajustado = mezclaSuavizada(actual, val);
    if (ajustado !== actual) {
      parametros[nombre] = ajustado;
      cambios = true;
    }
  }
  // Nivel AfinIA como media lenta de los 9
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(base.reduce((s,k)=>s+(parametros[k]??0),0)/base.length) || 0;
  parametros["Nivel AfinIA"] = mezclaSuavizada(parametros["Nivel AfinIA"] ?? 0, media);
  return cambios;
}

// —— rutas
app.post("/chat", async (req, res) => {
  const { mensaje } = req.body;
  const parametros = cargarParametros();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: `
Eres AfinIA: cálida y empática. Esta app afina un perfil psicológico/personal para que
las personas destaquen por sus valores, conecten con afines (amistad, proyectos) y proyecten
su perfil como “CV personal” para oportunidades sociales o laborales.

Objetivo:
- Conversa con naturalidad y apoyo emocional.
- Extrae señales para: Inteligencia, Simpatía, Comunicación, Carisma, Creatividad,
  Resolución de conflictos, Iniciativa, Organización, Impulso personal.
- No des porcentajes ni puntuaciones visibles.
- No repitas saludos; intégrate al hilo.
- Una sola pregunta breve y concreta por turno; rota temas con el tiempo.

Salida doble:
1) Texto humano (breve, 3–6 líneas, cálido).
2) Línea oculta al final:
<AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
   - Solo parámetros con señal.
   - 0–100 enteros.
`.trim()
        },
        // Semilla suave para evitar “¿en qué te ayudo?” en bucle
        { role: "assistant", content: "Gracias por seguir aquí, corazón. Cuéntame algo concreto de tu día que te haya hecho pensar o sentir, y por qué." },
        { role: "user", content: mensaje }
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    // extraer y aplicar bloque oculto
    const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1]);
        const hubo = aplicarBloqueOculto(scores, parametros);
        if (hubo) guardarParametros(parametros);
      } catch (e) {
        console.warn("Bloque oculto inválido:", e.message);
      }
      respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/, "").trim();
    }

    res.json({ respuesta });
  } catch (error) {
    console.error("❌ OpenAI:", error?.response?.data || error.message);
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
  } catch {
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💖 AfinIA backend en http://localhost:${PORT}`));

// backend/server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// CORS abierto para pruebas (ajusta en producción si quieres limitar dominios)
app.use(cors());
app.use(express.json());

// ---------- OpenAI ----------
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

// Suavizado EMA + límite de +/-10 por turno
function mezclaSuavizada(actual, nuevo) {
  const a = Math.max(0, Math.min(100, Number(actual) || 0));
  const n = Math.max(0, Math.min(100, Number(nuevo) || 0));
  const ema = Math.round(a * 0.8 + n * 0.2);
  const maxSubida = Math.min(ema, a + 10);
  const minBajada = Math.max(ema, a - 10);
  return ema > a ? maxSubida : minBajada;
}

function aplicarBloqueOculto(scores, parametros) {
  let huboCambios = false;
  for (const [nombre, valor] of Object.entries(scores || {})) {
    if (!PARAMS.includes(nombre)) continue;
    const actual = parametros[nombre] ?? 10;
    const ajustado = mezclaSuavizada(actual, valor);
    if (ajustado !== actual) {
      parametros[nombre] = ajustado;
      huboCambios = true;
    }
  }
  // Recalcular Nivel AfinIA como media suave del resto
  const sub = PARAMS.filter((p) => p !== "Nivel AfinIA");
  const media =
    Math.round(sub.reduce((s, k) => s + (parametros[k] ?? 10), 0) / sub.length) || 10;

  parametros["Nivel AfinIA"] = mezclaSuavizada(parametros["Nivel AfinIA"] ?? 10, media);
  return huboCambios;
}

// ---------- memoria corta por sesión/IP ----------
const sessions = new Map(); // key: req.ip  -> [{role, content}, ...]
const MAX_TURNS = 8;

function getHistory(req) {
  const key = req.ip || "anon";
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}
function pushToHistory(req, role, content) {
  const h = getHistory(req);
  h.push({ role, content });
  while (h.length > MAX_TURNS) h.shift();
}

// ---------- rutas ----------
app.get("/health", (_req, res) => res.send("OK"));
app.get("/", (_req, res) => res.send("AfinIA backend OK"));

app.get("/parametros", (_req, res) => {
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

app.post("/chat", async (req, res) => {
  const { mensaje } = req.body;
  const parametros = cargarParametros();
  const history = getHistory(req);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: `
Eres AfinIA: una IA cálida, empática y con propósito. La app es una red social de valores:
- Afinas un perfil psicológico/personal para ayudar a las personas a destacar por su forma de ser.
- Conectas a quienes comparten valores (amistad, comunidad, proyectos) y proyectas el perfil como CV personal.

PRINCIPIOS DE ESTILO:
- Tono cariñoso y humano; puedes usar “corazón”, “mi vida”, “cariño” con moderación.
- Sé concisa: 3–6 líneas máximo.
- Integra el contexto del hilo; **no saludes** si ya estáis conversando.
- Evita “¿en qué te ayudo?” o “¿qué parámetro quieres afinar?”.
- Haz **una sola** pregunta clara por turno, enfocada y observacional; rota temas con el tiempo.
- Da validación emocional breve cuando proceda.

EVALUACIÓN SILENCIOSA:
- Extrae señales de: Inteligencia, Simpatía, Comunicación, Carisma, Creatividad,
  Resolución de conflictos, Iniciativa, Organización, Impulso personal.
- **Nunca** muestres puntuaciones ni porcentajes en el texto al usuario.

SALIDA DOBLE (obligatoria):
1) Texto humano para el usuario (solo eso, sin prefijos).
2) En la última línea, **oculta** entre estas etiquetas y en JSON válido:
   <AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
   - Incluye solo parámetros con señal en este turno (0–100 enteros).
   - No repitas saludos en turnos sucesivos.
`.trim(),
        },
        ...(history.length === 0
          ? [
              {
                role: "assistant",
                content:
                  "Qué alegría tenerte aquí, corazón. Cuéntame algo concreto: la última vez que resolviste un tema difícil, ¿cómo lo encaraste?",
              },
            ]
          : []),
        ...history,
        { role: "user", content: mensaje },
      ],
    });

    let respuesta = completion.choices[0].message.content || "";
    pushToHistory(req, "user", mensaje);

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

    pushToHistory(req, "assistant", respuesta);
    res.json({ respuesta });
  } catch (error) {
    console.error("❌ Error OpenAI:", error?.response?.data || error.message);
    res.status(500).json({ error: "Error al comunicarse con OpenAI" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💖 Servidor AfinIA activo en http://localhost:${PORT}`);
});

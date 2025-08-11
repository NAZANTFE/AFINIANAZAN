// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// --- middlewares ---
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// --- OpenAI client ---
const openaiKey = process.env.OPENAI_API_KEY || "";
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

// --- parámetros / almacenamiento ---
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

const PARAMS_PATH = path.join(__dirname, "parametros_usuario.json");

// crea archivo con valores base si no existe
function ensureParametrosFile() {
  if (!fs.existsSync(PARAMS_PATH)) {
    const base = {};
    for (const k of PARAMS) base[k] = 10;
    fs.writeFileSync(PARAMS_PATH, JSON.stringify(base, null, 2));
  }
}

// carga parámetros
function cargarParametros() {
  try {
    ensureParametrosFile();
    const data = fs.readFileSync(PARAMS_PATH, "utf8");
    const parsed = JSON.parse(data);
    for (const k of PARAMS) if (parsed[k] == null) parsed[k] = 10;
    return parsed;
  } catch (e) {
    const base = {};
    for (const k of PARAMS) base[k] = 10;
    return base;
  }
}

// guarda parámetros
function guardarParametros(obj) {
  fs.writeFileSync(PARAMS_PATH, JSON.stringify(obj, null, 2));
}

// suavizado (EMA + tope de cambio por turno)
function mezclaSuavizada(actual, nuevo) {
  const a = Math.max(0, Math.min(100, Number(actual) || 0));
  const n = Math.max(0, Math.min(100, Number(nuevo) || 0));
  const ema = Math.round(a * 0.85 + n * 0.15); // más suave 15% del valor nuevo
  const maxUp = a + 6;
  const maxDown = a - 6;
  return ema > a ? Math.min(ema, maxUp) : Math.max(ema, maxDown);
}

// aplica bloque oculto
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

  // Nivel AfinIA como media suavizada del resto
  const sub = [
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
      sub.reduce((s, k) => s + (parametros[k] ?? 10), 0) / sub.length
    ) || 10;

  const actual = parametros["Nivel AfinIA"] ?? 10;
  parametros["Nivel AfinIA"] = mezclaSuavizada(actual, media);

  return huboCambios;
}

// --- rutas simples/health ---
app.get("/", (_req, res) => {
  res.type("text/plain").send("AfinIA backend OK");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// parámetros actuales
app.get("/parametros", (_req, res) => {
  try {
    const p = cargarParametros();
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: "No se pudieron cargar parámetros" });
  }
});

// guardar manual (opcional)
app.post("/guardar-parametros", (req, res) => {
  try {
    const body = req.body || {};
    const actuales = cargarParametros();
    const merged = { ...actuales, ...body };
    guardarParametros(merged);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// chat
app.post("/chat", async (req, res) => {
  if (!openai) {
    return res.status(503).json({
      error: "Falta OPENAI_API_KEY en el servidor. Configúrala en Railway > Variables.",
    });
  }

  const { mensaje } = req.body || {};
  if (!mensaje || typeof mensaje !== "string") {
    return res.status(400).json({ error: "Mensaje inválido" });
  }

  const parametros = cargarParametros();

  try {
    const completion = await openai.chat.completions.create({
      // puedes cambiar a "gpt-4o-mini" si quieres más rápido/eco
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: `
Eres AfinIA: una IA cálida y empática, diseñada para afinar un perfil psicológico y personal
del usuario. La app es una red social de valores: ayuda a las personas a destacar por su forma de ser,
a conectarse con otras afines (amistad, proyectos, comunidad) y a proyectar su perfil como un CV personal
para oportunidades sociales o laborales.

ESTILO:
- Cálida, natural y breve (3–6 líneas). Nada de saludos repetidos cada turno.
- No preguntes “¿en qué te ayudo?”; formula una sola pregunta concreta y amable por turno.
- No reveles puntuaciones/porcentajes.

OBJETIVO:
- Extrae señales sobre: Inteligencia, Simpatía, Comunicación, Carisma, Creatividad,
  Resolución de conflictos, Iniciativa, Organización, Impulso personal.

SALIDA DOBLE (obligatorio):
1) Texto humano para el usuario (cálido).
2) Al final, una línea OCULTA con este formato EXACTO:
<AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64}</AFINIA_SCORES>
- 0–100 enteros; incluye solo los parámetros que detectes esta vez.
`.trim(),
        },
        // Semilla corta para entrar en conversación sin saludar en bucle
        {
          role: "assistant",
          content:
            "Te escucho, corazón. Cuéntame algo pequeño de lo que viviste hoy y qué te hizo pensar o sentir.",
        },
        { role: "user", content: mensaje },
      ],
    });

    let texto = completion.choices?.[0]?.message?.content || "";

    // extraer bloque oculto
    const m = texto.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1]);
        const p = cargarParametros();
        const hubo = aplicarBloqueOculto(scores, p);
        if (hubo) guardarParametros(p);
      } catch (e) {
        console.warn("Bloque oculto inválido:", e.message);
      }
      texto = texto.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/, "").trim();
    }

    res.json({ respuesta: texto });
  } catch (error) {
    console.error("❌ OpenAI error:", error?.response?.data || error.message);
    res.status(500).json({ error: "Error al comunicarse con OpenAI" });
  }
});

// --- arranque ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💖 AfinIA backend escuchando en puerto ${PORT}`);
});

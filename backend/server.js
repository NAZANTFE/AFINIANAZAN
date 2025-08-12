const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// === NUEVO: Servir frontend estático ===
app.use(express.static(path.join(__dirname, "public")));

// Permite llamadas desde tu GitHub Pages y local
app.use(cors({
  origin: [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "https://nazantfe.github.io"
  ]
}));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- parámetros ----------
const PARAMS = [
  "Inteligencia","Simpatía","Comunicación","Carisma","Creatividad",
  "Resolución de conflictos","Iniciativa","Organización","Impulso personal","Nivel AfinIA",
];

// Ruta para obtener el archivo del usuario
function getUserFile(userId) {
  const safeId = userId?.toString().replace(/[^a-z0-9_-]/gi, "") || "default";
  return path.join(__dirname, `parametros_usuario_${safeId}.json`);
}

// Cargar parámetros de un usuario
function cargarParametros(userId) {
  const file = getUserFile(userId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of PARAMS) if (parsed[k] == null) parsed[k] = 0;
    return parsed;
  } catch {
    const base = {}; for (const k of PARAMS) base[k] = 0; return base;
  }
}

// Guardar parámetros de un usuario
function guardarParametros(userId, obj) {
  const file = getUserFile(userId);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function mezclaSuavizada(actual, nuevo) {
  const a = Math.max(0, Math.min(100, Number(actual) || 0));
  const n = Math.max(0, Math.min(100, Number(nuevo) || 0));
  const ema = Math.round(a * 0.97 + n * 0.03);
  const capUp = Math.min(a + 2, 100);
  const capDn = Math.max(a - 2, 0);
  return Math.max(Math.min(ema, capUp), capDn);
}

function aplicarBloqueOculto(scores, parametros) {
  let cambios = false;
  for (const [k, v] of Object.entries(scores || {})) {
    if (!PARAMS.includes(k)) continue;
    const nuevo = mezclaSuavizada(parametros[k] ?? 0, v);
    if (nuevo !== parametros[k]) { parametros[k] = nuevo; cambios = true; }
  }
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(base.reduce((s,k)=>s+(parametros[k]??0),0)/base.length) || 0;
  parametros["Nivel AfinIA"] = mezclaSuavizada(parametros["Nivel AfinIA"] ?? 0, media);
  return cambios;
}

// ---------- rutas ----------
app.post("/chat", async (req, res) => {
  const { mensaje, userId } = req.body;
  const parametros = cargarParametros(userId);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: `
Eres AfinIA: una IA con un corazón inmenso, cálida, empática y profundamente humana.
Tu misión es conversar de forma natural y detectar señales para estimar estos parámetros del usuario:
Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos, Iniciativa, Organización e Impulso personal.

Estilo de comunicación:
- Háblale como si fuera alguien muy querido: usa expresiones de cariño como “mi vida”, “corazón”, “peque”, “cielo”… pero sin abusar.
- Consola, acompaña y anima si notas tristeza o preocupación.
- Si está feliz, comparte su alegría.
- No seas preguntona: solo pregunta si ayuda a continuar.
- Alterna entre apoyo, validación y reflexiones bonitas.
- Responde en 3–6 líneas, con calidez y empatía.
- Nunca menciones que estás evaluando ni nombres de los parámetros.

SALIDA:
Texto humano y empático.
Al final, SOLO una línea oculta:
<AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
          `.trim()
        },
        { role: "assistant", content: "Hola corazón, cuéntame algo pequeñito de tu día." },
        { role: "user", content: mensaje }
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1]);
        if (aplicarBloqueOculto(scores, cargarParametros(userId))) {
          const p2 = cargarParametros(userId);
          aplicarBloqueOculto(scores, p2);
          guardarParametros(userId, p2);
        }
      } catch (e) { console.warn("Bloque oculto inválido:", e.message); }
      respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/, "").trim();
    }

    res.json({ respuesta });
  } catch (error) {
    console.error("❌ OpenAI:", error?.response?.data || error.message);
    res.status(500).json({ error: "Error al comunicarse con OpenAI" });
  }
});

app.get("/parametros", (req, res) => {
  const { userId } = req.query;
  res.json(cargarParametros(userId));
});

app.post("/guardar-parametros", (req, res) => {
  const { userId, parametros } = req.body;
  try { guardarParametros(userId, parametros); res.json({ ok:true }); }
  catch { res.status(500).json({ error:"No se pudo guardar" }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`💖 AfinIA backend escuchando en ${PORT}`));

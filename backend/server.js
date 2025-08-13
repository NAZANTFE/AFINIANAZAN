const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// === Servir frontend estático (public/index.html, etc.) ===
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

// Historial de conversaciones por usuario (solo en RAM de la instancia)
const conversaciones = {};

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

/* ---------- Detección de indicios por parámetro ----------
   Muy simple: si el último mensaje del usuario contiene palabras
   relacionadas con el parámetro, consideramos que hay señal. */
function hayIndicios(param, texto = "") {
  if (!texto) return false;
  const t = (texto || "").toLowerCase();

  const dic = {
    "Inteligencia": [
      "analic", "lógica", "razon", "deduc", "estudi", "aprend", "investig", "resolver"
    ],
    "Simpatía": [
      "amable", "simpát", "caer bien", "amig", "agrad", "empat", "cariño", "sonrisa"
    ],
    "Comunicación": [
      "hablé", "convers", "explic", "present", "comuni", "escuchar", "llamé", "mensaje"
    ],
    "Carisma": [
      "carisma", "encanto", "presencia", "causar impresión", "lideré", "inspiré", "inspirar"
    ],
    "Creatividad": [
      "creativ", "dibuj", "diseñ", "idea", "imagin", "innov", "improvis"
    ],
    "Resolución de conflictos": [
      "conflic", "discut", "negoci", "medi", "resolver problema", "acuerdo", "tensión", "pelea", "problema"
    ],
    "Iniciativa": [
      "iniciativa", "propuse", "empecé", "lancé", "tomé la delantera", "me ofrecí", "me adelanté"
    ],
    "Organización": [
      "organ", "planifi", "agenda", "orden", "priori", "lista", "calend"
    ],
    "Impulso personal": [
      "motiv", "constancia", "disciplina", "ganas", "esfuerzo", "persist", "energía", "impulso"
    ]
  };

  const palabras = dic[param] || [];
  return palabras.some(p => t.includes(p));
}

/* ---------- Ajuste de parámetros: más rápido con evidencia ----------
   Sube SOLO donde hay indicios en el último mensaje.
   Diales subidos respecto a la versión anterior. */
function aplicarBloqueOculto(scores, parametros, ultimoMensajeUsuario) {
  let cambios = false;

  // Diales (más ágiles)
  const MIN_SIGNAL = 3;               // antes 4 → detecta señales más débiles
  const MAX_PARAMS_PER_TURN = 4;      // antes 3 → puede mover hasta 4 con evidencia
  const CAP_UP = 12;                  // antes 10 → subida máxima por turno
  const CAP_DN = 4;                   // bajada máxima por turno

  // 1) Solo claves válidas (no tocamos "Nivel AfinIA" directamente)
  let entradas = Object.entries(scores || {}).filter(([k, v]) =>
    PARAMS.includes(k) && k !== "Nivel AfinIA" && Number.isFinite(Number(v))
  );

  // 2) Filtrar por INDICIOS en el último mensaje del usuario
  entradas = entradas.filter(([k]) => hayIndicios(k, ultimoMensajeUsuario));

  if (entradas.length > 0) {
    // 3) Evaluar deltas y descartar microcambios sin valor
    const conDelta = entradas
      .map(([k, v]) => {
        const target = Math.max(0, Math.min(100, Math.round(Number(v))));
        const actual = Math.max(0, Math.min(100, Number(parametros[k]) || 0));
        const delta = Math.abs(target - actual);
        return { k, target, actual, delta, dirUp: target > actual };
      })
      .filter(x => x.delta >= MIN_SIGNAL);

    // 4) Priorizamos mayor delta y limitamos cuántos mover
    conDelta.sort((a, b) => b.delta - a.delta);
    const seleccion = conDelta.slice(0, MAX_PARAMS_PER_TURN);

    // 5) Ajuste más rápido pero controlado
    for (const { k, target, actual, dirUp } of seleccion) {
      let factor = 0.13;                    // base (más vivo)
      if (actual > 70 && dirUp) factor = 0.08; // cuesta más si ya es alto
      if (actual < 30 && dirUp) factor = 0.20; // sube más fácil si está bajo

      const ema = Math.round(actual * (1 - factor) + target * factor);
      const capUp = Math.min(actual + CAP_UP, 100);
      const capDn = Math.max(actual - CAP_DN, 0);
      const nuevo = Math.max(Math.min(ema, capUp), capDn);

      if (nuevo !== actual) {
        parametros[k] = nuevo;
        cambios = true;
      }
    }
  }

  // 6) Nivel AfinIA = media suave del resto (un poco más reactivo)
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(
    base.reduce((s, k) => s + (parametros[k] ?? 0), 0) / base.length
  ) || 0;

  const actualNivel = Math.max(0, Math.min(100, Number(parametros["Nivel AfinIA"]) || 0));
  const nivelNuevo = Math.round(actualNivel * 0.88 + media * 0.12); // más reactivo
  if (nivelNuevo !== actualNivel) {
    parametros["Nivel AfinIA"] = nivelNuevo;
    cambios = true;
  }

  return cambios;
}

// ---------- rutas ----------
app.post("/chat", async (req, res) => {
  const { mensaje, userId } = req.body;
  const parametros = cargarParametros(userId);

  if (!conversaciones[userId]) conversaciones[userId] = [];

  try {
    // Guardamos el mensaje del usuario en el historial en RAM
    conversaciones[userId].push({ role: "user", content: mensaje });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.75,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: `
Eres AfinIA: una IA con un corazón inmenso, cálida, empática y profundamente humana.
Conversas como si conocieras bien al usuario, recordando lo que ha dicho antes en esta sesión.
Tu misión es detectar señales para estimar: Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos, Iniciativa, Organización e Impulso personal.

Estilo:
- Usa expresiones de cariño como “mi vida”, “corazón”, “peque”, “cielo”, pero sin abusar.
- Varía el saludo inicial y evita repetirlo en cada mensaje.
- Alterna entre preguntas abiertas y concretas basadas en la conversación actual.
- Si hay un tema reciente, sigue indagando en él antes de cambiar.
- Haz preguntas específicas que puedan dar pistas sobre los parámetros.
- Responde en 3–6 líneas con calidez y naturalidad.
- Nunca menciones que estás evaluando ni nombres de los parámetros.

SALIDA:
Texto humano y empático.
Al final, SOLO una línea oculta:
<AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
          `.trim()
        },
        ...conversaciones[userId]
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    // Extraer bloque oculto de scores
    const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1]);
        if (aplicarBloqueOculto(scores, parametros, mensaje)) {
          guardarParametros(userId, parametros);
        }
      } catch (e) {
        console.warn("Bloque oculto inválido:", e.message);
      }
      respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/, "").trim();
    }

    // Guardamos la respuesta en el historial para contexto
    conversaciones[userId].push({ role: "assistant", content: respuesta });

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
  try { guardarParametros(userId, parametros); res.json({ ok: true }); }
  catch { res.status(500).json({ error: "No se pudo guardar" }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`💖 AfinIA backend escuchando en ${PORT}`));

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

// ===== Normalización de claves de la IA (acentos / variantes) =====
const quitarAcentos = (s="") =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");

const CANON_MAP = (() => {
  const pares = [
    ["Inteligencia", "inteligencia"],
    ["Simpatía", "simpatia"],
    ["Comunicación", "comunicacion"],
    ["Carisma", "carisma"],
    ["Creatividad", "creatividad"],
    ["Resolución de conflictos", "resolucion de conflictos"],
    ["Iniciativa", "iniciativa"],
    ["Organización", "organizacion"],
    ["Impulso personal", "impulso personal"],
    ["Nivel AfinIA", "nivel afinia"],
  ];
  const m = new Map();
  for (const [canon, base] of pares) {
    m.set(base, canon); // sin tildes exacto
    m.set(quitarAcentos(canon).toLowerCase(), canon); // por si acaso
  }
  return m;
})();

function canonizaClave(k) {
  const key = quitarAcentos(String(k||"")).toLowerCase().trim();
  return CANON_MAP.get(key) || null;
}

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
   Simple: si el último mensaje del usuario contiene palabras
   relacionadas con el parámetro, consideramos que hay señal. */
function hayIndicios(param, texto = "") {
  if (!texto) return false;
  const t = (texto || "").toLowerCase();

  const dic = {
    "Inteligencia": [
      "analic", "lógica", "logica", "razon", "deduc", "estudi", "aprend", "investig", "resolver"
    ],
    "Simpatía": [
      "amable", "simpát", "simpat", "caer bien", "amig", "agrad", "empat", "cariño", "carino", "sonrisa"
    ],
    "Comunicación": [
      "hablé", "hable", "convers", "explic", "present", "comuni", "escuchar", "llamé", "llame", "mensaje"
    ],
    "Carisma": [
      "carisma", "encanto", "presencia", "causar impresión", "impresion", "lideré", "lidere", "lider", "inspiré", "inspire", "inspirar"
    ],
    "Creatividad": [
      "creativ", "dibuj", "diseñ", "disen", "idea", "imagin", "innov", "improvis"
    ],
    "Resolución de conflictos": [
      "conflic", "discut", "negoci", "medi", "resolver problema", "acuerdo", "tensión", "tension", "pelea", "problema"
    ],
    "Iniciativa": [
      "iniciativa", "propuse", "empecé", "empece", "lancé", "lance", "lanzar", "tomé la delantera", "me ofrecí", "ofreci", "me adelanté", "adelante"
    ],
    "Organización": [
      "organ", "planifi", "agenda", "orden", "priori", "lista", "calend"
    ],
    "Impulso personal": [
      "motiv", "constancia", "disciplina", "ganas", "esfuerzo", "persist", "energía", "energia", "impulso"
    ]
  };

  const palabras = dic[param] || [];
  return palabras.some(p => t.includes(p));
}

/* ---------- Ajuste de parámetros: más rápido con evidencia,
             y fallback MUY suave si no hay indicios ----------
*/
function aplicarBloqueOculto(scoresRaw, parametros, ultimoMensajeUsuario) {
  let cambios = false;

  // Diales
  const MIN_SIGNAL = 3;               // delta mínimo para mover
  const MAX_PARAMS_PER_TURN = 4;      // límite de parámetros movidos por turno
  const CAP_UP = 12;                  // subida máxima por turno
  const CAP_DN = 4;                   // bajada máxima por turno

  // 0) Canonizar claves del modelo → nombres tuyos exactos
  const scores = {};
  for (const [k, v] of Object.entries(scoresRaw || {})) {
    const canon = canonizaClave(k);
    if (canon && canon !== "Nivel AfinIA" && Number.isFinite(Number(v))) {
      scores[canon] = Number(v);
    }
  }

  // 1) Solo claves válidas
  let entradas = Object.entries(scores);

  // 2) Filtrar por INDICIOS en el último mensaje
  let withSignal = entradas.filter(([k]) => hayIndicios(k, ultimoMensajeUsuario));

  // Si no hay señal, probamos un fallback muy suave sobre el mayor delta
  const usarFallbackSuave = withSignal.length === 0;

  // 3) Conjunto a evaluar (con señal o, si no hay, todas pero luego limitamos a 1)
  const baseEval = (usarFallbackSuave ? entradas : withSignal).map(([k, v]) => {
    const target = Math.max(0, Math.min(100, Math.round(Number(v))));
    const actual = Math.max(0, Math.min(100, Number(parametros[k]) || 0));
    const delta = Math.abs(target - actual);
    return { k, target, actual, delta, dirUp: target > actual };
  });

  // Nada que mover
  if (baseEval.length === 0) {
    // Aún así, recalculamos Nivel AfinIA suavemente
    recalcularNivel(parametros);
    return false;
  }

  // 4) Ordenar por delta
  baseEval.sort((a, b) => b.delta - a.delta);

  // 5) Selección final
  const seleccion = usarFallbackSuave
    ? baseEval.slice(0, 1)                   // sin indicios: mueve SOLO el mayor delta un poco
    : baseEval
        .filter(x => x.delta >= MIN_SIGNAL)  // con indicios: respeta delta mínimo
        .slice(0, MAX_PARAMS_PER_TURN);

  // 6) Aplicar ajustes
  for (const { k, target, actual, dirUp } of seleccion) {
    let factor = usarFallbackSuave ? 0.06 : 0.13;        // fallback más suave; con señal más alegre
    if (actual > 70 && dirUp) factor = usarFallbackSuave ? 0.04 : 0.08;
    if (actual < 30 && dirUp) factor = usarFallbackSuave ? 0.10 : 0.20;

    const ema = Math.round(actual * (1 - factor) + target * factor);
    const capUp = Math.min(actual + CAP_UP, 100);
    const capDn = Math.max(actual - CAP_DN, 0);
    const nuevo = Math.max(Math.min(ema, capUp), capDn);

    if (nuevo !== actual) {
      parametros[k] = nuevo;
      cambios = true;
    }
  }

  // 7) Nivel AfinIA = media suave del resto (un poco más reactivo)
  cambios = recalcularNivel(parametros) || cambios;

  return cambios;
}

function recalcularNivel(parametros) {
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(
    base.reduce((s, k) => s + (parametros[k] ?? 0), 0) / base.length
  ) || 0;

  const actualNivel = Math.max(0, Math.min(100, Number(parametros["Nivel AfinIA"]) || 0));
  const nivelNuevo = Math.round(actualNivel * 0.88 + media * 0.12); // más reactivo
  if (nivelNuevo !== actualNivel) {
    parametros["Nivel AfinIA"] = nivelNuevo;
    return true;
  }
  return false;
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

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// === Servir frontend estático ===
app.use(express.static(path.join(__dirname, "public")));

// CORS para GitHub Pages y local
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

// Historial de conversaciones por usuario (memoria de sesión)
const conversaciones = {};

// Fichero por usuario
function getUserFile(userId) {
  const safeId = userId?.toString().replace(/[^a-z0-9_-]/gi, "") || "default";
  return path.join(__dirname, `parametros_usuario_${safeId}.json`);
}

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

function guardarParametros(userId, obj) {
  const file = getUserFile(userId);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/* --- NUEVO: palabras clave por parámetro para validar señal en el último mensaje --- */
const PARAM_KEYWORDS = {
  "Inteligencia": ["resolver","problema","lógica","estudi","análisis","analític","investig","aprend"],
  "Simpatía": ["amable","amabilidad","ayud","amig","cariñ","empát","caer bien","detall"],
  "Comunicación": ["hablar","convers","contar","explicar","present","escuchar","reunión","comunica"],
  "Carisma": ["lider","lideraz","energ","carism","sonris","confianz","inspir","motivar"],
  "Creatividad": ["idea","crear","creativ","diseñ","arte","improvis","original","innov"],
  "Resolución de conflictos": ["conflict","discut","pelea","mediar","acuerdo","negoci","solucion"],
  "Iniciativa": ["iniciativa","proponer","empez","arrancar","tomé la iniciativa","me animé","impulsé"],
  "Organización": ["organiz","planific","agenda","orden","prioriz","calend","estructura"],
  "Impulso personal": ["motiv","meta","hábito","constancia","disciplina","entren","esfuerzo","superar"]
};

/* Comprueba si el último mensaje del usuario contiene indicios del parámetro */
function hayIndicios(param, texto) {
  const t = (texto || "").toLowerCase();
  const palabras = PARAM_KEYWORDS[param] || [];
  return palabras.some(w => t.includes(w));
}

/* Actualiza SOLO parámetros con:
   - señal en bloque del modelo,
   - indicios en el último mensaje del usuario,
   - diferencia mínima (umbral),
   - límite de cuántos se mueven por turno. */
function aplicarBloqueOculto(scores, parametros, ultimoMensajeUsuario) {
  let cambios = false;

  // ---- diales ajustables ----
  const MIN_SIGNAL = 7;            // diferencia mínima para considerar señal válida
  const MAX_PARAMS_PER_TURN = 2;   // cuántos parámetros como máximo se mueven por turno
  const CAP_UP = 6;                // subida máxima por turno
  const CAP_DN = 3;                // bajada máxima por turno
  // ---------------------------

  // 1) Solo claves válidas (y nunca tocamos "Nivel AfinIA" directo)
  let entradas = Object.entries(scores || {}).filter(([k, v]) =>
    PARAMS.includes(k) && k !== "Nivel AfinIA" && Number.isFinite(Number(v))
  );

  // 2) Filtro por INDICIOS en el último mensaje del usuario
  entradas = entradas.filter(([k]) => hayIndicios(k, ultimoMensajeUsuario));

  if (entradas.length > 0) {
    // 3) Calcula delta y umbral mínimo
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

    // 5) Ajuste suave por parámetro seleccionado
    for (const { k, target, actual, dirUp } of seleccion) {
      let factor = 0.06;                 // base
      if (actual > 70 && dirUp) factor = 0.03; // difícil subir muy alto
      if (actual < 30 && dirUp) factor = 0.10; // más fácil subir si está bajo

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

  // 6) Nivel AfinIA como media suave del resto
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(
    base.reduce((s, k) => s + (parametros[k] ?? 0), 0) / base.length
  ) || 0;

  const actualNivel = Math.max(0, Math.min(100, Number(parametros["Nivel AfinIA"]) || 0));
  const nivelNuevo = Math.round(actualNivel * 0.96 + media * 0.04);
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
    // Guarda turno del usuario
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
- Nunca menciones que estás evaluando ni los nombres de los parámetros.

INSTRUCCIONES DE PUNTUACIÓN (MUY IMPORTANTE):
- SOLO emite puntuaciones para parámetros con evidencia clara en EL ÚLTIMO mensaje del usuario (y contexto inmediato).
- No rellenes todos: máximo 3 parámetros por turno.
- Si no hay señal suficiente, envía un objeto vacío: <AFINIA_SCORES>{}</AFINIA_SCORES>.

SALIDA:
1) Texto humano y empático.
2) Al final, SOLO una línea oculta:
<AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
`.trim()
        },
        ...conversaciones[userId]
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1] || "{}");
        // 🔒 Solo aplicamos si hay indicios en el ÚLTIMO mensaje del usuario
        if (aplicarBloqueOculto(scores, parametros, mensaje)) {
          guardarParametros(userId, parametros);
        }
      } catch (e) {
        console.warn("Bloque oculto inválido:", e.message);
      }
      // limpia el bloque oculto
      respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/, "").trim();
    }

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

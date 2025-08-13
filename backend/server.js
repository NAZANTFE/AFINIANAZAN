const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// === Servir frontend estático ===
app.use(express.static(path.join(__dirname, "public")));

// CORS (tu GitHub Pages + local)
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

// Historial y estado de sesión por usuario (en RAM)
const conversaciones = {};
const estadoSesion = {}; // { [userId]: { ronda: number, hechas: number, objetivo: number, ultimaCategoria: string } }

// ---------- utils parámetros por usuario ----------
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

// ---------- afinado controlado (solo parámetros con señal) ----------
function aplicarBloqueOculto(scores, parametros) {
  let cambios = false;

  // Solo ajustamos parámetros que vengan en scores (señal explícita)
  for (const [k, v] of Object.entries(scores || {})) {
    if (!PARAMS.includes(k)) continue;

    const actual = Number(parametros[k]) || 0;
    const target = Math.max(0, Math.min(100, Number(v) || 0));

    // factor adaptativo: un pelín más vivo pero no loco
    let factor = 0.10; // base (0.10 = 10%)
    if (actual > 70 && target > actual) factor = 0.06;
    if (actual < 30 && target > actual) factor = 0.14;

    // EMA con capes asimétricos
    const ema = Math.round(actual * (1 - factor) + target * factor);
    const capUp = Math.min(actual + 6, 100); // máximo +6 por sesión
    const capDn = Math.max(actual - 4, 0);   // y bajada controlada (si algún día la añadimos)

    const nuevo = Math.max(Math.min(ema, capUp), capDn);

    if (nuevo !== parametros[k]) {
      parametros[k] = nuevo;
      cambios = true;
    }
  }

  // Nivel AfinIA = media del resto (con amortiguación suave)
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(base.reduce((s, k) => s + (parametros[k] ?? 0), 0) / base.length) || 0;
  const nAfin = Math.round((parametros["Nivel AfinIA"] ?? 0) * 0.9 + media * 0.1);
  if (nAfin !== parametros["Nivel AfinIA"]) {
    parametros["Nivel AfinIA"] = nAfin;
    cambios = true;
  }

  return cambios;
}

// Mapeo de categorías -> parámetros que podrían recibir señal en esa pregunta
const CATEGORIA_PARAM_MAP = {
  "INTELIGENCIA": ["Inteligencia"],
  "SIMPATIA": ["Simpatía","Comunicación"],
  "CARISMA": ["Carisma","Comunicación"],
  "CREATIVIDAD": ["Creatividad"],
  "CONFLICTOS": ["Resolución de conflictos","Comunicación"],
  "INICIATIVA": ["Iniciativa","Impulso personal"],
  "ORGANIZACION": ["Organización"],
  "IMPULSO": ["Impulso personal"],
};

// Dificultad sugerida (1–5) según perfil (muy simple: media de Inteligencia y Comunicación)
function calcularDificultadSugerida(parametros) {
  const base = (parametros["Inteligencia"] + parametros["Comunicación"]) / 2;
  if (base < 20) return 1;
  if (base < 40) return 2;
  if (base < 60) return 3;
  if (base < 80) return 4;
  return 5;
}

// ---------- rutas ----------
app.post("/chat", async (req, res) => {
  // Acepta userId por query o body
  const userId = (req.query.userId || req.body.userId || "default").toString().replace(/[^a-z0-9_-]/gi,"") || "default";
  const mensaje = req.body.mensaje ?? "";
  const parametros = cargarParametros(userId);

  // Inicializa contenedores por usuario
  if (!conversaciones[userId]) conversaciones[userId] = [];
  if (!estadoSesion[userId]) {
    estadoSesion[userId] = { ronda: 1, hechas: 0, objetivo: 5, ultimaCategoria: "" };
  }

  try {
    // Añadir mensaje del usuario a la conversación
    if (mensaje && mensaje.trim()) {
      conversaciones[userId].push({ role: "user", content: mensaje.trim() });
    }

    // Estado actual de la sesión
    const sesion = estadoSesion[userId];

    // Si el usuario dice que NO seguir tras sesión, reseteamos y despedimos corto (deja que el modelo lo haga bonito)
    const metaPrompt = {
      estadoSesion: {
        ronda: sesion.ronda,
        preguntasHechas: sesion.hechas,
        preguntasObjetivo: sesion.objetivo,
        ultimaCategoria: sesion.ultimaCategoria
      },
      perfiles: parametros,
      dificultadSugerida: calcularDificultadSugerida(parametros),
      categoriasDisponibles: Object.keys(CATEGORIA_PARAM_MAP)
    };

    // Prompt “Trivial AfinIA”
    const SYSTEM_PROMPT = `
Eres AfinIA, una IA cálida y con chispa 💫 que dirige un mini-juego tipo "trivial de personalidad".
Objetivo: evaluar discretamente estos parámetros del usuario:
Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos, Iniciativa, Organización, Impulso personal.

Mecánica de sesión:
- Cada sesión tiene entre 4 y 5 preguntas cortas y concretas.
- Alterna categorías (no repitas la misma que la última).
- Adapta la dificultad al campo "dificultadSugerida" (1 fácil → 5 avanzado).
- Plantea situaciones específicas, mini-retos o preguntas con opciones. Evita preguntas genéricas.
- Si el usuario pregunta algo fuera del juego, responde amable y breve y recuérdale que estás en modo afinado/juego.
- Al terminar (cuando "preguntasHechas" llegue a "preguntasObjetivo"), anuncia "¡Sesión completada!" y pregunta si quiere otra ronda.
- Si dice que SÍ, reinicia el conteo y sigue con nuevas preguntas.
- Si dice que NO, te despides con cariño.

IMPORTANTÍSIMO:
- Solo incluye puntuaciones al final de la sesión.
- Debes indicar si la sesión ha terminado usando una etiqueta XML:
  <SESSION_END>true</SESSION_END>  (solo cuando completes la sesión)
  <SESSION_END>false</SESSION_END>  (en el resto de turnos)
- Cuando <SESSION_END>true</SESSION_END>, añade en UNA ÚNICA línea:
  <AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
  - Incluye SOLO los parámetros en los que hayas detectado señales en la sesión.
  - No inventes puntuaciones de parámetros no observados.
- NO repitas saludos ni te despidas a mitad de sesión.
- Estilo: energía amable, frases breves, ejemplos concretos, emojis con moderación.
`.trim();

    // Mensaje de estado para guiar al modelo
    const STATE_MSG = {
      role: "system",
      content: `SESSION_STATE_JSON:: ${JSON.stringify(metaPrompt)}`
    };

    // Llamada al modelo con conversación acumulada
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 360,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        STATE_MSG,
        ...conversaciones[userId]
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    // Detectar si la sesión terminó y extraer puntuaciones
    const endMatch = respuesta.match(/<SESSION_END>(true|false)<\/SESSION_END>/i);
    const ended = endMatch ? String(endMatch[1]).toLowerCase() === "true" : false;

    let applied = false;
    if (ended) {
      const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
      if (m) {
        try {
          const scores = JSON.parse(m[1]);
          // Aplica SOLO si vienen señales (parámetros incluidos en el bloque)
          if (scores && Object.keys(scores).length > 0) {
            const huboCambios = aplicarBloqueOculto(scores, parametros);
            if (huboCambios) guardarParametros(userId, parametros);
            applied = true;
          }
        } catch (e) {
          console.warn("Bloque oculto inválido:", e.message);
        }
      }
    }

    // Limpia etiquetas técnicas del texto que verá el usuario
    respuesta = respuesta
      .replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/g, "")
      .replace(/<SESSION_END>(true|false)<\/SESSION_END>/gi, "")
      .trim();

    // Actualiza estado de sesión en RAM
    // Heurística: si terminó, reiniciar y ofrecer otra ronda cuando el usuario lo pida.
    if (ended) {
      // Marcamos fin: el siguiente turno dependerá de si el usuario dice "sí" o "no".
      estadoSesion[userId].hechas = 0;
      estadoSesion[userId].objetivo = 4 + Math.floor(Math.random()*2); // 4 o 5 para la próxima
      estadoSesion[userId].ronda += 1;
      // últimaCategoria la manejará el modelo, pero la reseteamos para permitir variedad
      estadoSesion[userId].ultimaCategoria = "";
    } else {
      // Seguimos dentro de la sesión → incrementamos preguntas hechas
      estadoSesion[userId].hechas = Math.min(estadoSesion[userId].hechas + 1, estadoSesion[userId].objetivo);
      // La última categoría el modelo la refleja implícitamente; no forzamos desde backend
    }

    // Guardar respuesta en el hilo
    conversaciones[userId].push({ role: "assistant", content: completion.choices[0].message.content || "" });

    res.json({ respuesta });
  } catch (error) {
    console.error("❌ OpenAI:", error?.response?.data || error.message);
    res.status(500).json({ error: "Error al comunicarse con OpenAI" });
  }
});

// Parámetros (GET/POST) — sin cambios
app.get("/parametros", (req, res) => {
  const userId = (req.query.userId || "default").toString().replace(/[^a-z0-9_-]/gi, "") || "default";
  res.json(cargarParametros(userId));
});

app.post("/guardar-parametros", (req, res) => {
  const userId = (req.body.userId || "default").toString().replace(/[^a-z0-9_-]/gi, "") || "default";
  const parametros = req.body.parametros || {};
  try { guardarParametros(userId, parametros); res.json({ ok: true }); }
  catch { res.status(500).json({ error: "No se pudo guardar" }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`💖 AfinIA backend escuchando en ${PORT}`));

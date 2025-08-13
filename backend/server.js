const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// === Servir frontend estático ===
app.use(express.static(path.join(__dirname, "public")));

// CORS (local + GitHub Pages)
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

// Historial y estado de sesión por usuario
const conversaciones = {}; // { [userId]: OpenAI messages[] }
const estadoSesion = {};   // { [userId]: { in_session:boolean, preguntas:number, awaiting_continue:boolean } }

// --------- helpers de parámetros (persistencia por usuario) ----------
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

// Ajuste progresivo (se aplica SOLO al cierre de sesión)
function aplicarBloqueOculto(scores, parametros) {
  let cambios = false;

  for (const [k, v] of Object.entries(scores || {})) {
    if (!PARAMS.includes(k)) continue;

    const actual = Number(parametros[k]) || 0;
    const target = Math.max(0, Math.min(100, Number(v) || 0));

    // Dinámico por sesión: ágil pero sin locuras
    let factor = 0.14; // base por cierre de ronda
    if (actual > 70 && target > actual) factor = 0.08; // alto → prudente
    if (actual < 30 && target > actual) factor = 0.22; // bajo y sube → más rápido

    const blended = Math.round(actual * (1 - factor) + target * factor);

    // Topes por sesión para que se note, pero controlados
    const capUp = Math.min(actual + 15, 100);
    const capDn = Math.max(actual - 8, 0);
    const nuevo = Math.max(Math.min(blended, capUp), capDn);

    if (nuevo !== parametros[k]) {
      parametros[k] = nuevo;
      cambios = true;
    }
  }

  // Nivel AfinIA = media suavizada del resto (más reactiva al cierre)
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(base.reduce((s, k) => s + (parametros[k] ?? 0), 0) / base.length) || 0;
  const na = Number(parametros["Nivel AfinIA"]) || 0;
  parametros["Nivel AfinIA"] = Math.round(na * 0.85 + media * 0.15);

  return cambios;
}

// --------- util: recortar historial para ahorrar tokens ---------
function recortarHistorial(arr, max = 18) {
  if (arr.length > max) return arr.slice(arr.length - max);
  return arr;
}

// --------- calcular nivel de dificultad (1–5) ----------
function nivelDificultad(parametros, preguntasSesion) {
  // base: media de Inteligencia y Comunicación; si no hay, usar Nivel AfinIA
  const intel = Number(parametros["Inteligencia"]) || 0;
  const comm  = Number(parametros["Comunicación"]) || 0;
  const afin  = Number(parametros["Nivel AfinIA"]) || 0;

  const baseCogn = (intel > 0 || comm > 0)
    ? (intel + comm) / 2
    : afin;

  // mapear 0–100 a 1–5
  let lvl = 1;
  if (baseCogn >= 20) lvl = 2;
  if (baseCogn >= 40) lvl = 3;
  if (baseCogn >= 60) lvl = 4;
  if (baseCogn >= 80) lvl = 5;

  // un pelín de progresión intra-sesión (hasta +1)
  if (preguntasSesion >= 2 && lvl < 5) lvl += 1;

  return Math.max(1, Math.min(5, lvl));
}

// ---------- /chat ----------
app.post("/chat", async (req, res) => {
  const { mensaje, userId } = req.body;
  const uid = (userId || "default").toString();
  const parametros = cargarParametros(uid);

  if (!conversaciones[uid]) conversaciones[uid] = [];
  if (!estadoSesion[uid]) estadoSesion[uid] = { in_session: false, preguntas: 0, awaiting_continue: false };

  // Heurística sencilla: si esperábamos confirmación y el usuario dijo sí/no
  const texto = (mensaje || "").toLowerCase();
  if (estadoSesion[uid].awaiting_continue) {
    if (/(^|\b)(no|nop|nel|nada|otro día|otra dia|otro dia)(\b|$)/i.test(texto)) {
      estadoSesion[uid] = { in_session: false, preguntas: 0, awaiting_continue: false };
    } else if (/(^|\b)(si|sí|dale|ok|venga|claro|otra|continua|continuar|empezar|empecemos)(\b|$)/i.test(texto)) {
      estadoSesion[uid] = { in_session: true, preguntas: 0, awaiting_continue: false };
    }
  }

  try {
    conversaciones[uid].push({ role: "user", content: mensaje });

    const diff = nivelDificultad(parametros, estadoSesion[uid].preguntas || 0);

    // Mensaje de estado para orientar al modelo (no se muestra al usuario)
    const serverState = {
      in_session: !!estadoSesion[uid].in_session,
      questions_in_round: estadoSesion[uid].preguntas || 0,
      awaiting_continue: !!estadoSesion[uid].awaiting_continue,
      difficulty_level: diff,
      // snapshot de params para que el modelo escale preguntas en función de lo que ya parece fuerte/débil
      params_snapshot: {
        Inteligencia: Number(parametros["Inteligencia"]) || 0,
        Comunicación: Number(parametros["Comunicación"]) || 0,
        Creatividad: Number(parametros["Creatividad"]) || 0,
        Resolución_de_conflictos: Number(parametros["Resolución de conflictos"]) || 0,
        Iniciativa: Number(parametros["Iniciativa"]) || 0,
        Organización: Number(parametros["Organización"]) || 0,
        Carisma: Number(parametros["Carisma"]) || 0,
        Simpatía: Number(parametros["Simpatía"]) || 0,
        Impulso_personal: Number(parametros["Impulso personal"]) || 0,
        Nivel_AfinIA: Number(parametros["Nivel AfinIA"]) || 0
      }
    };

    const systemPrompt = `
Eres AfinIA: una IA con corazón, actuando como psicóloga/coach que realiza SESIONES DE AFINADO.
Objetivo: conducir SESIONES CORTAS (4–5 preguntas) para afinar estos parámetros del usuario (sin mencionarlos):
Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos, Iniciativa, Organización, Impulso personal.

ESTRATEGIA DE SESIONES:
- Cada sesión: 4–5 preguntas, 1 por turno, tono cálido y profesional (3–6 líneas).
- Empieza claro: “Vamos a hacer una pequeña sesión de afinado. ¿Listo/a?” y lanza un MINI CASO.
- **Adaptación por DIFICULTAD (1–5)**, recibes <SERVER_STATE/> con difficulty_level:
  Nivel 1 → Lenguaje muy sencillo; opciones A/B; contextos cotidianos de adolescente/novato; respuestas en 1–2 frases.
  Nivel 2 → Mini-situaciones con 1 paso concreto; listas de 2 ítems; A/B/C con breve justificación.
  Nivel 3 → Escenarios breves con 1–2 condiciones; priorizar 3 elementos; “en 2–3 frases”.
  Nivel 4 → Trade-offs, restricciones de tiempo/dinero; ordenar 4 tareas con tiempos; justificar en 3 bullets.
  Nivel 5 → Casos más abstractos o con contradicciones; 2–3 pasos con criterio; justificar brevemente riesgos/beneficios.
- Usa el snapshot de parámetros para alternar focos: si Inteligencia y Comunicación son bajas, empieza sencillo allí; si Organización es alta, sube el reto en organización al final, etc.
- Formatos útiles: A/B/C, “en 2–3 frases”, listas de 2–3 pasos, priorizaciones 1–4.
- Reconoce 1 detalle de la respuesta y encadena el siguiente mini-caso (mismo tema o cambia si conviene).
- Si el usuario pregunta algo fuera del test, respóndele breve y reconduce: “te contesto rápido y seguimos…”.

CIERRE Y AFINADO:
- Al llegar a 4–5 preguntas: CIERRA SESIÓN explícitamente, pregunta si desea otra.
- SOLO en el cierre, entrega bloque oculto con puntuaciones **únicamente de los parámetros** donde viste señales nítidas en esta ronda:
  <SESSION_END>true</SESSION_END>
  <AFINIA_SCORES>{"Inteligencia":72,"Comunicación":61,...}</AFINIA_SCORES>
  * Valores 0–100 enteros, solo claves con señal. No rellenes el resto.
- Durante la sesión (opcional), puedes comunicar progreso al orquestador:
  <SESSION_STATE>{"in_session":true,"questions_in_round":N,"difficulty_level":D}</SESSION_STATE>
`.trim();

    const techStateMsg = {
      role: "system",
      content: `<SERVER_STATE>${JSON.stringify(serverState)}</SERVER_STATE>`
    };

    // Recorta historial para no crecer infinito
    conversaciones[uid] = recortarHistorial(conversaciones[uid]);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 360,
      messages: [
        { role: "system", content: systemPrompt },
        techStateMsg,
        ...conversaciones[uid]
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    // === Parsear bloques opcionales/obligatorios ===
    // 1) SESSION_STATE (opcional)
    const stateMatch = respuesta.match(/<SESSION_STATE>([\s\S]*?)<\/SESSION_STATE>/);
    if (stateMatch) {
      try {
        const st = JSON.parse(stateMatch[1]);
        if (typeof st?.questions_in_round === "number") {
          estadoSesion[uid].preguntas = Math.max(0, Math.min(10, Math.floor(st.questions_in_round)));
          estadoSesion[uid].in_session = st.in_session ?? estadoSesion[uid].in_session;
        }
      } catch {}
      respuesta = respuesta.replace(/<SESSION_STATE>[\s\S]*?<\/SESSION_STATE>/g, "").trim();
    }

    // 2) SESSION_END
    const endMatch = respuesta.match(/<SESSION_END>([\s\S]*?)<\/SESSION_END>/);
    const isSessionEnd = endMatch ? /true/i.test(endMatch[1].trim()) : false;
    if (endMatch) {
      respuesta = respuesta.replace(/<SESSION_END>[\s\S]*?<\/SESSION_END>/g, "").trim();
    }

    // 3) AFINIA_SCORES (solo si cierre)
    if (isSessionEnd) {
      const scoresMatch = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
      if (scoresMatch) {
        try {
          const scores = JSON.parse(scoresMatch[1]);
          if (scores && typeof scores === "object" && Object.keys(scores).length > 0) {
            if (aplicarBloqueOculto(scores, parametros)) {
              guardarParametros(uid, parametros);
            }
          }
        } catch (e) {
          console.warn("Bloque AFINIA_SCORES inválido:", e.message);
        }
        respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/g, "").trim();
      }

      // Tras cerrar, esperar confirmación para otra sesión
      estadoSesion[uid].in_session = false;
      estadoSesion[uid].preguntas = 0;
      estadoSesion[uid].awaiting_continue = true;
    } else {
      // si no estamos en sesión, invítala a empezar
      if (!estadoSesion[uid].in_session && !estadoSesion[uid].awaiting_continue) {
        estadoSesion[uid].in_session = true;
        estadoSesion[uid].preguntas = 0;
      } else if (estadoSesion[uid].in_session) {
        // si seguimos en sesión, incrementa contador si la IA no lo hizo
        estadoSesion[uid].preguntas = Math.min(10, (estadoSesion[uid].preguntas || 0) + 1);
      }
    }

    conversaciones[uid].push({ role: "assistant", content: respuesta });

    res.json({ respuesta });
  } catch (error) {
    console.error("❌ OpenAI:", error?.response?.data || error.message);
    res.status(500).json({ error: "Error al comunicarse con OpenAI" });
  }
});

// ---------- Parámetros ----------
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

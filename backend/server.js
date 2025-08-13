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

  // Nivel AfinIA = media suavizada del resto (un poco más reactiva al cierre)
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
    if (/(^|\b)(no|nop|nel|nada|otro día)(\b|$)/i.test(texto)) {
      estadoSesion[uid] = { in_session: false, preguntas: 0, awaiting_continue: false };
    } else if (/(^|\b)(si|sí|dale|ok|venga|claro|otra|continua|continuar)(\b|$)/i.test(texto)) {
      estadoSesion[uid] = { in_session: true, preguntas: 0, awaiting_continue: false };
    }
  }

  try {
    conversaciones[uid].push({ role: "user", content: mensaje });

    // Mensaje de estado para orientar al modelo (no se muestra al usuario)
    const serverState = {
      in_session: !!estadoSesion[uid].in_session,
      questions_in_round: estadoSesion[uid].preguntas || 0,
      awaiting_continue: !!estadoSesion[uid].awaiting_continue
    };

    const systemPrompt = `
Eres AfinIA: una IA con corazón, pero operando como psicóloga/coach de "sesiones de afinado".
Objetivo: conducir SESIONES CORTAS (4–5 preguntas) para afinar estos parámetros del usuario:
Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos, Iniciativa, Organización e Impulso personal.
No menciones esos nombres ni digas que evalúas.

Mecánica de SESIONES:
- Cada sesión: 4 o 5 preguntas, 1 por turno, tono cálido y profesional (3–6 líneas).
- Evita saludos genéricos; arranca claro: “Vamos a empezar una pequeña sesión de afinado. ¿Listo/a?” y lanza un MINI CASO.
- Preguntas SIEMPRE SITUACIONALES y CONCRETAS: plantea micro-escenarios realistas (trabajo, familia, amigos, estudios, ocio).
  • Inteligencia: “Te dan 20 min y un puzzle lógico con 3 pistas contradictorias; ¿qué harías primero y por qué (en 2 frases)?”
  • Comunicación: “Imagina que tu idea es buena pero nadie te escucha en una reunión. En 2–3 frases, ¿cómo la presentas de forma clara?”
  • Carisma: “Llegas a un grupo que no te conoce; en 2 líneas, ¿cómo rompes el hielo sin resultar forzado?”
  • Creatividad: “Con 15€ y 1 hora, propone una forma original de animar una tarde gris con amigos (en 3 bullets).”
  • Resolución de conflictos: “Dos amigos discuten por un malentendido de dinero. Elige A/B/C y explica breve: A) mediación conjunta B) hablar por separado C) mensaje escrito.”
  • Iniciativa: “Ves un problema pequeño en tu barrio/centro. ¿Qué primer paso concreto darías esta semana?”
  • Organización: “Tienes 4 tareas (estudiar, entrenar, recado, descanso). Ordena y pon tiempos (en minutos).”
  • Impulso personal: “Elige un objetivo para hoy (muy pequeño) y di el primer paso que harás en 15 min.”
  • Simpatía: “Un compañero llega apagado. En 2 líneas, muéstrale apoyo sin tópicos.”
- Formatos que ayudan: opciones A/B/C con breve justificación; “en 2–3 frases”; lista de 3 pasos; priorización 1–4.
- Reconoce 1 detalle de la respuesta y formula el siguiente mini-caso encadenado (misma temática o cambia de ámbito si conviene).
- Si el usuario pregunta algo fuera del test, respóndele brevemente y reconduce: “te contesto rápido y seguimos con la sesión…”.
- Al llegar a 4–5 preguntas, CIERRA SESIÓN: dilo explícitamente, pregunta si desea otra, y ENTREGA SOLO EN ESE MOMENTO el bloque oculto con puntuaciones
  ÚNICAMENTE de los parámetros donde hayas visto señales nítidas en esta ronda (no rellenes los demás).

Bloques ocultos:
- Durante la sesión (opcional):
  <SESSION_STATE>{"in_session":true,"questions_in_round":N}</SESSION_STATE>
- Al cerrar sesión (obligatorio):
  <SESSION_END>true</SESSION_END>
  <AFINIA_SCORES>{"Inteligencia":72,"Comunicación":61,...}</AFINIA_SCORES>
  * Solo claves con señal en esta ronda, valores 0–100 enteros.
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
      max_tokens: 320,
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
          estadoSesion[uid].in_session = !!st.in_session;
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

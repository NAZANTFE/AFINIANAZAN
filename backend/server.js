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
  if (arr.length > max) {
    // Conserva el system + últimos turnos
    // (como guardamos system fuera, aquí solo truncamos la cola)
    return arr.slice(arr.length - max);
  }
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
- Cada sesión: 4 o 5 preguntas, 1 por turno, claras, concretas y basadas en lo que el usuario acaba de decir.
- Si el usuario habla de otro tema, respóndele brevemente y reconduce a la sesión.
- Tono cálido y profesional. 3–6 líneas. No te despidas hasta cerrar sesión o si el usuario rechaza continuar.
- Al llegar a 4–5 preguntas, CIERRA SESIÓN: di explícitamente que cierras la ronda con una frase positiva,
  pregunta si desea otra, y ENTREGA SOLO EN ESE MOMENTO el bloque oculto con puntuaciones de los parámetros DONDE VISTE SEÑALES CLARAS.
  No incluyas parámetros sin evidencia en esta ronda.
- Si el usuario dice que NO quiere otra: despídete con cariño breve ("nos vemos en la siguiente sesión").
- Si el usuario dice que SÍ: inicia nueva sesión desde 0 y vuelve a preguntar (no des puntuaciones hasta cerrar esa nueva sesión).

Bloques ocultos:
- Durante la sesión (sin cerrar), puedes incluir de forma opcional:
  <SESSION_STATE>{"in_session":true,"questions_in_round":N}</SESSION_STATE>
- Al cerrar la sesión DEBES incluir:
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
    // 1) SESSION_STATE (opcional) → actualiza contador local si viene
    const stateMatch = respuesta.match(/<SESSION_STATE>([\s\S]*?)<\/SESSION_STATE>/);
    if (stateMatch) {
      try {
        const st = JSON.parse(stateMatch[1]);
        if (typeof st?.questions_in_round === "number") {
          estadoSesion[uid].preguntas = Math.max(0, Math.min(10, Math.floor(st.questions_in_round)));
          estadoSesion[uid].in_session = !!st.in_session;
        }
      } catch {}
      // No mostramos la etiqueta al usuario:
      respuesta = respuesta.replace(/<SESSION_STATE>[\s\S]*?<\/SESSION_STATE>/g, "").trim();
    }

    // 2) SESSION_END (obligatorio solo en cierre)
    const endMatch = respuesta.match(/<SESSION_END>([\s\S]*?)<\/SESSION_END>/);
    const isSessionEnd = endMatch ? /true/i.test(endMatch[1].trim()) : false;
    if (endMatch) {
      // ocultar del texto al usuario
      respuesta = respuesta.replace(/<SESSION_END>[\s\S]*?<\/SESSION_END>/g, "").trim();
    }

    // 3) AFINIA_SCORES (solo si SESSION_END)
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
        // ocultar del texto al usuario
        respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/g, "").trim();
      }

      // Tras cerrar, quedamos a la espera de confirmación para otra sesión
      estadoSesion[uid].in_session = false;
      estadoSesion[uid].preguntas = 0;
      estadoSesion[uid].awaiting_continue = true;
    }

    // Añadir respuesta al historial visible
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

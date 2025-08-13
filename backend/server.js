const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// Servir frontend estático (carpeta /public)
app.use(express.static(path.join(__dirname, "public")));

// CORS para local + GitHub Pages
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

// Historial en memoria por usuario (sesión viva del backend)
const conversaciones = {};

// ---------- util fichero por usuario ----------
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

// ---------- ajuste de parámetros (más dinámico, sólo con indicios) ----------
function aplicarBloqueOculto(scores, parametros, opts = { msgLen: 0 }) {
  let cambios = false;
  const msgLen = Number(opts.msgLen || 0);

  // Ajuste del factor según longitud del mensaje
  // mensajes ricos mueven un poco más la aguja
  const richnessBoost = msgLen >= 180 ? 1.35 : msgLen >= 80 ? 1.15 : msgLen >= 30 ? 1.0 : 0.85;

  // Solo actualizamos las claves que lleguen en `scores`
  for (const [k, v] of Object.entries(scores || {})) {
    if (!PARAMS.includes(k) || k === "Nivel AfinIA") continue;

    const actual = Math.max(0, Math.min(100, Number(parametros[k]) || 0));
    const nuevoBruto = Math.max(0, Math.min(100, Number(v) || 0));

    // Si el "nuevo" está por debajo o muy pegado y no aporta, no lo tocamos
    if (Math.abs(nuevoBruto - actual) < 3 && nuevoBruto <= actual) continue;

    // Factor base (más vivo que antes)
    let factor = 0.06 * richnessBoost; // ↑ dinamismo base

    // Si hay gran diferencia hacia arriba, acelera un poco
    if (nuevoBruto > actual + 15) factor = 0.12 * richnessBoost;

    // Tramos dependientes del nivel actual (crecer arriba es más difícil)
    if (actual > 70 && nuevoBruto > actual) factor *= 0.7;      // frena arriba
    if (actual < 30 && nuevoBruto > actual) factor *= 1.35;     // acelera abajo

    // Permitir pequeñas bajadas si el score viene menor (realismo)
    if (nuevoBruto < actual) factor = Math.max(0.035, factor * 0.8);

    // EMA acotada por paso máximo/min
    const ema = Math.round(actual * (1 - factor) + nuevoBruto * factor);

    // Capas de seguridad por paso
    const capUp = Math.min(actual + 7, 100); // <= +7 por turno
    const capDn = Math.max(actual - 4, 0);   // >= -4 por turno

    const nuevo = Math.max(Math.min(ema, capUp), capDn);

    if (nuevo !== parametros[k]) {
      parametros[k] = nuevo;
      cambios = true;
    }
  }

  // Nivel AfinIA = media del resto, suavizada (se mueve un poco más que antes)
  const base = PARAMS.filter(p => p !== "Nivel AfinIA");
  const media = Math.round(base.reduce((s, k) => s + (parametros[k] ?? 0), 0) / base.length) || 0;
  const nivelActual = Math.max(0, Math.min(100, Number(parametros["Nivel AfinIA"]) || 0));
  const nivelNuevo = Math.round(nivelActual * 0.9 + media * 0.1); // 10% hacia la media
  if (nivelNuevo !== nivelActual) {
    parametros["Nivel AfinIA"] = nivelNuevo;
    cambios = true;
  }

  return cambios;
}

// ---------- rutas ----------
app.post("/chat", async (req, res) => {
  const { mensaje, userId } = req.body;
  const uid = (userId || "default").toString();
  const parametros = cargarParametros(uid);

  if (!conversaciones[uid]) conversaciones[uid] = [];

  try {
    // guardamos el turno del usuario
    conversaciones[uid].push({ role: "user", content: mensaje });

    const systemPrompt = `
Eres AfinIA: una IA cálida, empática y activa. Quieres conocer de verdad a la persona
y, con mucho cariño, vas extrayendo pequeñas pistas (sin decirlo) para afinar:
Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos,
Iniciativa, Organización e Impulso personal.

REGLAS DE ESTILO
- Nada de despedidas tempranas. Mantén la charla viva.
- 3–6 líneas, tono cercano ("corazón", "peque", "cielo" si cuadra), natural, nada mecánico.
- Haz SIEMPRE 1 pregunta (máx. 2 si lo amerita) conectada al último mensaje del usuario.
- Alterna preguntas abiertas y concretas. Sigue el hilo (no cambies de tema si el usuario sigue en el mismo).
- Ejemplos de micro-indagación camuflada:
  • Inteligencia/Creatividad: "¿Cómo se te ocurrió resolverlo así?" / "¿Le diste alguna vuelta creativa?"
  • Comunicación/Carisma: "¿Cómo lo contaste para que te entendieran?" / "¿Qué nota de tu forma de conectar con la gente?"
  • Resolución de conflictos: "¿Qué hiciste cuando no salió como esperabas?"
  • Organización: "¿Cómo te organizaste para llegar a tiempo?"
  • Iniciativa/Impulso personal: "¿Quién dio el primer paso?"
  • Simpatía: "¿Cómo procuraste que la otra persona se sintiera bien?"
- NO repitas saludos. Si la conversación ya empezó, entra directo al tema.
- Nunca menciones que estás evaluando ni nombres la lista de parámetros.

REGLAS DE SCORES OCULTOS (MUY IMPORTANTE)
- Devuelve al final una sola línea con JSON dentro de <AFINIA_SCORES>...</AFINIA_SCORES>.
- Incluye SOLO los parámetros para los que haya indicios CLAROS en los **últimos 1–2 mensajes del usuario**.
- Máximo 3 parámetros por turno. Si no hay pistas, devuelve un objeto vacío {}.
- Los valores son enteros 0–100 estimados para ese parámetro (no todos los parámetros, solo los tocados).
- Ejemplo:
  <AFINIA_SCORES>{"Comunicación":64,"Resolución de conflictos":58}</AFINIA_SCORES>
    `.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 260,
      messages: [
        { role: "system", content: systemPrompt },
        ...conversaciones[uid]
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    // Extraer y aplicar bloque oculto
    const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1]);
        // Aplicamos SOLO a los parámetros presentes y ajustamos según longitud del mensaje
        const huboCambios = aplicarBloqueOculto(scores, parametros, { msgLen: (mensaje || "").length });
        if (huboCambios) guardarParametros(uid, parametros);
      } catch (e) {
        console.warn("Bloque oculto inválido:", e.message);
      }
      // Limpiamos el bloque oculto de la respuesta visible
      respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/, "").trim();
    }

    // guardamos respuesta del asistente en el hilo
    conversaciones[uid].push({ role: "assistant", content: respuesta });

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

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// ❗Permite llamadas desde tu GitHub Pages (ajusta si tu user/org cambia)
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

function cargarParametros() {
  const file = path.join(__dirname, "parametros_usuario.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of PARAMS) if (parsed[k] == null) parsed[k] = 0; // arranque en 0
    return parsed;
  } catch {
    const base = {}; for (const k of PARAMS) base[k] = 0; return base;
  }
}
function guardarParametros(obj) {
  const file = path.join(__dirname, "parametros_usuario.json");
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// subida MUY suave
function mezclaSuavizada(actual, nuevo) {
  const a = Math.max(0, Math.min(100, Number(actual) || 0));
  const n = Math.max(0, Math.min(100, Number(nuevo) || 0));
  const ema = Math.round(a * 0.97 + n * 0.03); // α=0.03
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
  const { mensaje } = req.body;
  const parametros = cargarParametros();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: `
Eres AfinIA: una IA cálida, empática y con propósito. 
Tu misión es conversar de forma natural y detectar señales para estimar estos parámetros del usuario: 
Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos, Iniciativa, Organización e Impulso personal.

Objetivo general:
La app AfinIA está destinada a afinar un perfil psicológico y personal del usuario con el fin de que sea una red social donde las personas destaquen por sus valores reales. 
Además, busca acercar personas con perfiles semejantes con fines sociales o incluso laborales, sirviendo como un currículum personal vivo y auténtico.

Reglas de estilo:
- Cariñosa y cercana, empatiza con el usuario, pero concisa (3–6 líneas normalmente).
- NO preguntes “¿en qué te puedo ayudar?” ni “¿qué parámetro quieres afinar?”.
- No des porcentajes, puntuaciones ni menciones a evaluaciones.
- Formula PREGUNTAS CONCRETAS y observables, una por turno.
- Alterna temas y evita repetir la misma pregunta seguida.
- Valida emocionalmente cuando sea oportuno (“gracias por contármelo, corazón”).
- Evita interrogatorios: combina 1 idea + 1 pregunta.
- Si el usuario está casual, sigue con calidez y cuela una pregunta suave que aporte señal.

NO menciones los nombres de los parámetros ni que estás evaluando.

SALIDA:
1) Texto humano, no insistas con preguntas si el usuario solo busca ser escuchado, empatiza, da consejos, responde con cariño siempre, si notas que el usuario busca apoyo o consuelo, dáselo, pero no insistas con preguntas en esos casos, analiza al usuario por lo que te dice (3–6 líneas, cálido, con empatía, si el usuario está triste responde con cariño, trata de ayudarlo, si el usuario no desea contestar preguntas trata de aconejarle y dale cariño, usa palabras bonitas y adjetivos que consuelen con amor).
2) Al final, SOLO una línea oculta:
<AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
(0–100 enteros, solo claves con señal)
`.trim()
        },
        { role: "assistant", content: "Gracias por seguir aquí, corazón. Cuéntame algo pequeño de tu día que te haya movido un poquito, y por qué." },
        { role: "user", content: mensaje }
      ]
    });

    let respuesta = completion.choices[0].message.content || "";

    const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1]);
        if (aplicarBloqueOculto(scores, cargarParametros())) {
          // recarga y guarda para evitar condición de carrera mínima
          const p2 = cargarParametros();
          aplicarBloqueOculto(scores, p2);
          guardarParametros(p2);
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

app.get("/parametros", (req, res) => res.json(cargarParametros()));

app.post("/guardar-parametros", (req, res) => {
  try { guardarParametros(req.body); res.json({ ok:true }); }
  catch { res.status(500).json({ error:"No se pudo guardar" }); }
});

// Railway suele usar 8080
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`💖 AfinIA backend escuchando en ${PORT}`));

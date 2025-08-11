const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------- parámetros --------
const PARAMS = [
  "Inteligencia", "Simpatía", "Comunicación", "Carisma", "Creatividad",
  "Resolución de conflictos", "Iniciativa", "Organización", "Impulso personal",
  "Nivel AfinIA"
];

const filePath = path.join(__dirname, "parametros_usuario.json");

function cargarParametros() {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(data);
    for (const k of PARAMS) if (parsed[k] == null) parsed[k] = 10;
    return parsed;
  } catch {
    const base = {}; for (const k of PARAMS) base[k] = 10; return base;
  }
}
function guardarParametros(obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}
function suaviza(actual, nuevo) {
  const a = Math.max(0, Math.min(100, Number(actual) || 0));
  const n = Math.max(0, Math.min(100, Number(nuevo) || 0));
  const ema = Math.round(a * 0.8 + n * 0.2);
  const up = Math.min(ema, a + 10);
  const down = Math.max(ema, a - 10);
  return ema > a ? up : down;
}
function aplicarScores(scores, parametros) {
  let cambios = false;
  for (const [k, v] of Object.entries(scores || {})) {
    if (!PARAMS.includes(k)) continue;
    const ajust = suaviza(parametros[k] ?? 10, v);
    if (ajust !== parametros[k]) { parametros[k] = ajust; cambios = true; }
  }
  const sub = ["Inteligencia","Simpatía","Comunicación","Carisma","Creatividad","Resolución de conflictos","Iniciativa","Organización","Impulso personal"];
  const media = Math.round(sub.reduce((s,k)=> s + (parametros[k] ?? 10),0)/sub.length) || 10;
  parametros["Nivel AfinIA"] = suaviza(parametros["Nivel AfinIA"] ?? 10, media);
  return cambios;
}

// -------- rutas --------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "AfinIA backend", endpoints: ["/chat", "/parametros"] });
});

app.get("/parametros", (_req, res) => {
  res.json(cargarParametros());
});

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
// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Datos de ejemplo (luego lo puedes conectar a una base de datos)
let parametrosUsuario = {
  "Nivel AfinIA": 75,
  "Inteligencia": 88,
  "Simpatía": 72,
  "Comunicación": 91,
  "Carisma": 85,
  "Creatividad": 69,
  "Resolución de conflictos": 77,
  "Iniciativa": 83,
  "Organización": 65,
  "Impulso personal": 80
};

// Endpoint para enviar parámetros al frontend
app.get("/parametros", (req, res) => {
  res.json(parametrosUsuario);
});

// Endpoint para conversar con la IA
app.post("/chat", async (req, res) => {
  try {
    const { mensaje } = req.body;

    const respuesta = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: Eres AfinIA: IA cálida y empática. Esta app es una red social de valores: ayuda a que la gente
destaque por su forma de ser, se conecte con personas afines (social/proyectos) y proyecte su perfil como CV personal.
Tu misión es conversar natural y extraer señales para estimar:
Inteligencia, Simpatía, Comunicación, Carisma, Creatividad, Resolución de conflictos, Iniciativa, Organización, Impulso personal.

Reglas:
- No muestres porcentajes ni puntuaciones.
- No repitas saludos; intégrate al hilo.
- Haz 1 pregunta concreta por turno; rota temas.
- Sé breve (3–6 líneas), cariñosa y útil.

Salida doble:
1) Texto humano para el usuario.
2) Al final, en una sola línea oculta:
<AFINIA_SCORES>{"Inteligencia":72,"Simpatía":64,...}</AFINIA_SCORES>
(0–100 enteros; solo parámetros detectados).
`.trim()
        },
        {
          role: "assistant",
          content: "Gracias por seguir, corazón. Cuando te aparece un problema nuevo, ¿sueles descomponerlo en pasos o prefieres probar varias ideas rápido?"
        },
        { role: "user", content: mensaje || "" }
      ]
    });

    const datos = await respuesta.json();
    const textoIA = datos.choices?.[0]?.message?.content || "No pude generar una respuesta en este momento.";

    res.json({ respuesta: textoIA });

  } catch (error) {
    console.error("Error en /chat:", error);
    res.status(500).json({ error: "Error al conectar con la IA" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor AfinIA corriendo en http://localhost:${PORT}`);
});


    let respuesta = completion.choices[0].message.content || "";
    const m = respuesta.match(/<AFINIA_SCORES>([\s\S]*?)<\/AFINIA_SCORES>/);
    if (m) {
      try {
        const scores = JSON.parse(m[1]);
        if (aplicarScores(scores, parametros)) guardarParametros(parametros);
      } catch {}
      respuesta = respuesta.replace(/<AFINIA_SCORES>[\s\S]*?<\/AFINIA_SCORES>/, "").trim();
    }
    res.json({ respuesta });
  } catch (err) {
    console.error("OpenAI error:", err?.response?.data || err.message);
    res.status(500).json({ error: "No se pudo contactar con la IA" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 AfinIA backend en puerto ${PORT}`));

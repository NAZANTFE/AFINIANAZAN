const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();

// 🔓 CORS: permite tu GitHub Pages y localhost
app.use(cors({
  origin: [
    "https://nazantfe.github.io",    // <-- tu GitHub Pages (ajusta si tu user/org cambia)
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ]
}));
app.use(express.json());

// ---- utilidades de parámetros (archivo JSON en backend) ----
const PARAMS = [
  "Inteligencia","Simpatía","Comunicación","Carisma","Creatividad",
  "Resolución de conflictos","Iniciativa","Organización","Impulso personal","Nivel AfinIA"
];
function cargarParametros() {
  const p = path.join(__dirname,"parametros_usuario.json");
  try {
    const data = JSON.parse(fs.readFileSync(p,"utf8"));
    for (const k of PARAMS) if (data[k]==null) data[k]=10;
    return data;
  } catch {
    const base={}; for (const k of PARAMS) base[k]=10; return base;
  }
}
function guardarParametros(o){
  const p = path.join(__dirname,"parametros_usuario.json");
  fs.writeFileSync(p, JSON.stringify(o,null,2));
}

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- rutas mínimas ----
app.get("/health",(req,res)=>res.json({ok:true}));

app.get("/parametros",(req,res)=> res.json(cargarParametros()));

app.post("/chat", async (req,res)=>{
  const { mensaje } = req.body;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role:"system",
          content:
`Eres AfinIA, una IA cálida y empática. Conversa natural,
no des porcentajes ni “scores”, y formula 1 pregunta concreta por turno
para ir conociendo al usuario (inteligencia, simpatía, comunicación, etc.).`
        },
        { role:"user", content: mensaje }
      ],
      temperature: 0.6,
      max_tokens: 220
    });
    res.json({ respuesta: r.choices[0].message.content });
  } catch (e) {
    console.error("OpenAI error:", e?.response?.data || e.message);
    res.status(500).json({ error: "OpenAI error" });
  }
});

const PORT = process.env.PORT || 8080; // Railway usa 8080 por defecto
app.listen(PORT, ()=> console.log("AfinIA backend en puerto", PORT));

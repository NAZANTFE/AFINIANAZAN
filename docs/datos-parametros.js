const parametrosAfinIA = [
  { nombre: "Nivel AfinIA", valor: 78, clase: "rosa" },
  { nombre: "Inteligencia", valor: 92, clase: "verde" },
  { nombre: "Simpatía", valor: 88, clase: "rojo" },
  { nombre: "Comunicación", valor: 84, clase: "azul" },
  { nombre: "Carisma", valor: 81, clase: "melocoton" },
  { nombre: "Creatividad", valor: 76, clase: "lavanda" },
  { nombre: "Resolución de conflictos", valor: 82, clase: "coral" },
  { nombre: "Iniciativa", valor: 69, clase: "oliva" },
  { nombre: "Organización", valor: 73, clase: "lila" },
  { nombre: "Impulso personal", valor: 64, clase: "amarillo" }
];
// Al final del bloque donde ya tienes el top4
const colorPorClase = {
  "verde": "#a4eac8",
  "rojo": "#f7a1a1",
  "azul": "#c7e1f6",
  "dorado": "#fbeac3",
  "lavanda": "#e4c7f5",
  "coral": "#f7c8b2",
  "oliva": "#d4eac1",
  "lila": "#d8ccf1",
  "amarillo": "#fff0b3"
};

const claseTop = colores[top4[0][0]];
const foto = document.getElementById('fotoPerfil');
foto.className = `foto-perfil borde-${claseTop}`;


progreso.style.background = `conic-gradient(${colorHex} 0% ${valorTop}%, #f0f0f0 ${valorTop}% 100%)`;

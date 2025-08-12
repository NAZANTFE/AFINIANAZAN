const chatInput = document.querySelector("#entradaUsuario");
const chatButton = document.querySelector("#enviarBtn");
const chatMensajes = document.querySelector(".mensajes-chat");

// ⚡ Reemplaza esto con los IDs correctos si los cambiaste

// Función para enviar mensaje al backend y procesar respuesta
async function enviarMensaje() {
  const mensaje = chatInput.value.trim();
  if (!mensaje) return;

  // Mostrar mensaje del usuario en el chat
  const mensajeUsuario = document.createElement("div");
  mensajeUsuario.classList.add("mensaje-usuario");
  mensajeUsuario.textContent = mensaje;
  chatMensajes.appendChild(mensajeUsuario);
  chatInput.value = "";

  try {
    const respuesta = await fetch('/guardar-parametros', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(nuevosValores) // donde nuevosValores contiene el nuevo estado de todos los parámetros
});


    const data = await respuesta.json();

    const mensajeIA = document.createElement("div");
    mensajeIA.classList.add("mensaje-bot");
    mensajeIA.textContent = data.respuesta;
    chatMensajes.appendChild(mensajeIA);

    // Analizar y actualizar parámetros si se incluyen
    if (data.parametros_actualizados) {
      actualizarParametrosVisuales(data.parametros_actualizados);
    }

    // Desplazar hacia abajo automáticamente
    chatMensajes.scrollTop = chatMensajes.scrollHeight;
  } catch (error) {
    console.error("Error al comunicar con AfinIA 🥺:", error);
  }
}

// Función para actualizar visualmente los parámetros
function actualizarParametrosVisuales(parametros) {
  for (const clave in parametros) {
    const porcentaje = parametros[clave];
    const barra = document.querySelector(`.${clave.toLowerCase()} .barra`);
    if (barra) {
      barra.style.width = porcentaje + "%";
      barra.textContent = porcentaje + "%";
    }
  }
}

// Evento al pulsar el botón
chatButton.addEventListener("click", enviarMensaje);

// También al pulsar Enter
chatInput.addEventListener("keypress", function (e) {
  if (e.key === "Enter") enviarMensaje();
});

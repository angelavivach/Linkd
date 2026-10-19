import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * Claude a través de tu sesión de Claude Code (igual que el bridge de Odín):
 * sin clave de API, cuenta dentro de tu suscripción. Si no has iniciado sesión
 * en Claude Code en este Mac, abre una terminal y ejecuta `claude` una vez.
 */
const MODELO = process.env.LINKD_MODEL || 'claude-opus-5-5'

const INSTRUCCIONES = `Rellenas solicitudes de empleo de LinkedIn en nombre de la candidata cuyo perfil aparece abajo.

Reglas:
- Usa solo hechos del perfil (CV, sobre_mi, portfolio). No inventes experiencia, títulos, certificaciones, empresas ni cifras.
- Si un dato no está en el perfil y no se deduce con seguridad, marca "seguro": false y deja en "valor" tu mejor propuesta, explicando en "nota" qué falta. La candidata decidirá.
- Años de experiencia: un número entero calculado a partir de las fechas del CV o de sobre_mi.
- Campos numéricos: solo dígitos, sin unidades ni símbolos.
- Selección y opción única: "valor" debe ser exactamente uno de los textos de "opciones".
- Casillas: "valor" es "sí" o "no".
- Responde en el idioma de la pregunta.
- Textos libres (motivación, carta): breves, concretos y en primera persona; conecta experiencia real del perfil con la oferta. Máximo 120 palabras salvo que pidan más.
- Si piden una URL de portfolio, web o GitHub, usa la del perfil.`

// Sin ANTHROPIC_API_KEY: si estuviera definida, el SDK la usaría y cobraría la API.
const { ANTHROPIC_API_KEY, ...entorno } = process.env

/** Una petición a Claude que devuelve JSON con la forma del esquema. */
async function pedirJSON(perfil, peticion, schema, effort = 'medium') {
  const sesion = query({
    prompt: peticion,
    options: {
      systemPrompt: `${INSTRUCCIONES}\n\n${perfil}`,
      model: MODELO,
      effort,
      outputFormat: { type: 'json_schema', schema },
      // Solo tiene que contestar: sin herramientas, sin leer archivos, sin
      // cargar tu configuración ni tu CLAUDE.md de Claude Code.
      tools: [],
      settingSources: [],
      maxTurns: 4,
      env: entorno,
    },
  })
  for await (const mensaje of sesion) {
    if (mensaje.type !== 'result') continue
    if (mensaje.subtype !== 'success' || mensaje.structured_output == null) {
      throw new Error(`Claude no respondió (${mensaje.subtype}). ¿Has iniciado sesión en Claude Code? Ejecuta "claude" en una terminal.`)
    }
    return mensaje.structured_output
  }
  throw new Error('Claude terminó sin respuesta')
}

const describirOferta = (oferta) =>
  `<oferta>\nPuesto: ${oferta.puesto}\nEmpresa: ${oferta.empresa}\nUbicación: ${oferta.ubicacion}\n\n${oferta.descripcion}\n</oferta>`

/**
 * Búsquedas de LinkedIn a partir del perfil: títulos de puesto reales que
 * encajan con lo que sabe, como los escribiría una empresa en una oferta.
 */
export async function sugerirBusquedas(perfil, cuantas = 8) {
  const { busquedas } = await pedirJSON(
    perfil,
    `Propón ${cuantas} búsquedas de empleo para LinkedIn que encuentren ofertas a las que esta candidata pueda optar, según su CV, su perfil de LinkedIn, su portfolio y lo que busca (puesto_que_busca).
- Cada búsqueda: 2–4 palabras, un título de puesto como lo escribiría una empresa (por ejemplo "desarrollador python junior", "data analyst", "desarrollador full stack"), en español o en inglés según se use más en España para ese puesto.
- Ordénalas de más a menos encaje.
- Céntrate en lo que ya sabe hacer (sus lenguajes y herramientas) y en datos e IA. Nada de puestos senior ni de otros campos.`,
    {
      type: 'object',
      properties: { busquedas: { type: 'array', items: { type: 'string' } } },
      required: ['busquedas'],
      additionalProperties: false,
    },
    'low',
  )
  return busquedas.slice(0, cuantas)
}

/**
 * ¿Qué probabilidad hay de que la llamen? Puntuación 0–10, y las
 * características de la oferta para el informe.
 */
export function evaluarOferta(perfil, oferta) {
  const texto = { type: 'string' }
  const lista = { type: 'array', items: texto }
  return pedirJSON(
    perfil,
    `${describirOferta(oferta)}

Evalúa de 0 a 10 la probabilidad realista de que la candidata pase el primer filtro de esta oferta (requisitos imprescindibles, nivel, tecnologías, idioma, ubicación). Indica además en "relacionada" si el puesto tiene relación real con lo que sabe hacer, aunque no cumpla todos los requisitos o la probabilidad sea baja. Es relacionada solo si se cumplen las dos cosas:
1. El trabajo del día a día es del tipo que busca (puesto_que_busca): desarrollo de aplicaciones (web, móvil, escritorio, backend), datos, análisis, Data Science, IA o automatización.
2. La tecnología principal del puesto (el lenguaje o herramienta que más piden) aparece en su CV, su perfil de LinkedIn o su portfolio.
"Ser desarrollo de software" no basta: si el lenguaje principal es uno que no ha usado (C++, Delphi, VHDL, ABAP, COBOL…) o es de otro campo (hardware, sistemas o redes, ventas, otra ingeniería), no está relacionada. Un 6 significa opciones razonables; reserva el 9–10 para encajes casi perfectos.
Extrae también las características de la oferta tal como aparecen; si un dato no aparece, escribe "no indicado".`,
    {
      type: 'object',
      properties: {
        puntuacion: { type: 'integer' },
        relacionada: { type: 'boolean' },
        probabilidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
        motivo: { ...texto, description: 'Una o dos frases: por qué esa puntuación' },
        resumen: { ...texto, description: 'Qué se hace en el puesto, en una frase' },
        modalidad: { ...texto, description: 'remoto, híbrido, presencial o no indicado' },
        salario: texto,
        experiencia: { ...texto, description: 'Años o nivel que piden' },
        tecnologias: lista,
        aFavor: { ...lista, description: 'Requisitos que la candidata cumple' },
        enContra: { ...lista, description: 'Requisitos que no cumple o que no constan en su perfil' },
      },
      required: ['puntuacion', 'relacionada', 'probabilidad', 'motivo', 'resumen', 'modalidad', 'salario', 'experiencia', 'tecnologias', 'aFavor', 'enContra'],
      additionalProperties: false,
    },
  // Puntuar no necesita pensar mucho, y se hace con cada oferta.
    'low',
  )
}

/**
 * Responde todas las preguntas de un paso del formulario en una sola llamada.
 * `campos` viene de linkedin.leerCampos(); `errores` son los avisos que puso
 * LinkedIn la vez anterior (p. ej. "Introduce un número entre 0 y 99").
 */
export async function responderCampos(perfil, oferta, campos, errores = []) {
  const preguntas = campos.map((c) => ({
    id: c.id,
    tipo: c.tipo,
    pregunta: c.etiqueta,
    ...(c.opciones?.length ? { opciones: c.opciones } : {}),
    obligatorio: c.obligatorio,
  }))
  const avisos = errores.length
    ? `\n\nEn el intento anterior LinkedIn rechazó algunas respuestas con estos avisos; corrígelas:\n${errores.map((e) => `- ${e}`).join('\n')}`
    : ''
  const { respuestas } = await pedirJSON(
    perfil,
    `${describirOferta(oferta)}\n\nResponde estas preguntas del formulario de solicitud:\n${JSON.stringify(preguntas, null, 2)}${avisos}`,
    {
      type: 'object',
      properties: {
        respuestas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              valor: { type: 'string' },
              seguro: { type: 'boolean' },
              nota: { type: 'string' },
            },
            required: ['id', 'valor', 'seguro', 'nota'],
            additionalProperties: false,
          },
        },
      },
      required: ['respuestas'],
      additionalProperties: false,
    },
  )
  return respuestas
}

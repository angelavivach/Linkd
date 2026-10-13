import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()
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

/** Una petición a Claude que devuelve JSON con la forma del esquema. */
async function pedirJSON(perfil, peticion, schema) {
  const res = await client.beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    // Si el modelo declina por un falso positivo de seguridad, la API
    // reintenta en otro modelo dentro de la misma llamada.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    // El perfil va en el system y con caché: es igual en todas las llamadas.
    system: [
      { type: 'text', text: `${INSTRUCCIONES}\n\n${perfil}`, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: peticion }],
  })
  if (res.stop_reason === 'refusal') throw new Error('Claude no quiso responder a esta petición')
  if (res.stop_reason === 'max_tokens') throw new Error('La respuesta de Claude se cortó')
  const texto = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return JSON.parse(texto)
}

const describirOferta = (oferta) =>
  `<oferta>\nPuesto: ${oferta.puesto}\nEmpresa: ${oferta.empresa}\nUbicación: ${oferta.ubicacion}\n\n${oferta.descripcion}\n</oferta>`

/** ¿Merece la pena solicitar? Puntuación 0–10 y por qué. */
export function evaluarOferta(perfil, oferta) {
  return pedirJSON(
    perfil,
    `${describirOferta(oferta)}\n\nEvalúa de 0 a 10 cuánto encaja la candidata con esta oferta (requisitos imprescindibles, nivel, tecnologías, idioma, ubicación). Sé realista: un 6 significa que tiene opciones razonables.`,
    {
      type: 'object',
      properties: {
        puntuacion: { type: 'integer' },
        motivo: { type: 'string' },
      },
      required: ['puntuacion', 'motivo'],
      additionalProperties: false,
    },
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

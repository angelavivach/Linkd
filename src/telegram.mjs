import { readdir, readFile } from 'node:fs/promises'

// Telegram: un bot tuyo (creado con @BotFather) te escribe a tu chat personal.
// El token es una contraseña del bot: vive solo en config.json (que no se sube a GitHub).
const API_POR_DEFECTO = 'https://api.telegram.org'
const LIMITE = 3900 // Telegram admite 4096 caracteres por mensaje

const api = (config) => config.telegram?.api || API_POR_DEFECTO

/** Trocea el texto por líneas para no pasar el límite de Telegram. */
function trocear(texto) {
  const trozos = []
  let actual = ''
  for (const linea of texto.split('\n')) {
    if ((actual + linea).length > LIMITE) {
      trozos.push(actual)
      actual = ''
    }
    actual += linea + '\n'
  }
  if (actual.trim()) trozos.push(actual)
  return trozos
}

/** Envía un texto a tu chat. Devuelve false si Telegram no está configurado. */
export async function enviarTelegram(config, texto) {
  const t = config.telegram
  if (!t?.token || !t?.chatId) return false
  for (const trozo of trocear(texto)) {
    const r = await fetch(`${api(config)}/bot${t.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text: trozo, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      const datos = await r.json().catch(() => ({}))
      // El mensaje de error no incluye el token.
      throw new Error(`Telegram respondió ${r.status}: ${datos.description ?? 'sin detalle'}`)
    }
  }
  return true
}

/** Los chats que han escrito al bot: de ahí sale tu chatId. */
export async function chatsDelBot(config) {
  const t = config.telegram
  if (!t?.token) throw new Error('Pon el token del bot en config.json, en "telegram.token".')
  const r = await fetch(`${api(config)}/bot${t.token}/getUpdates`, { signal: AbortSignal.timeout(15_000) })
  const datos = await r.json().catch(() => ({}))
  if (!r.ok || !datos.ok) throw new Error(`Telegram respondió ${r.status}: ${datos.description ?? 'token no válido'}`)
  const chats = new Map()
  for (const u of datos.result) {
    const c = u.message?.chat ?? u.channel_post?.chat
    if (c) chats.set(c.id, c.title ?? c.first_name ?? c.username ?? '(sin nombre)')
  }
  return [...chats].map(([id, nombre]) => ({ id, nombre }))
}

/** Las ofertas que se han tocado desde `desde` (registro/*.json tiene fecha). */
export async function ofertasDesde(desde) {
  const archivos = (await readdir('registro').catch(() => [])).filter((f) => f.endsWith('.json'))
  const ofertas = []
  for (const f of archivos) {
    const o = JSON.parse(await readFile(`registro/${f}`, 'utf8'))
    if (o.fecha && new Date(o.fecha).getTime() >= desde) ofertas.push(o)
  }
  return ofertas
}

const ESTADO = {
  enviada: '✅ Enviada',
  prueba: '🧪 Rellenada (prueba)',
  'necesita ayuda': '✋ Necesita que la termines tú',
  error: '❌ Error',
  'no enviada': '⏭ No enviada',
  'sin solicitar': '⏭ Sin solicitar',
  omitida: '⏭ Omitida',
}

/** El texto del resumen: agrupado por estado, con probabilidad y enlace. */
export function textoResumen(ofertas, titulo = 'Resumen de Linkd') {
  if (!ofertas.length) return `${titulo}: no hay ofertas nuevas en esta ejecución.`
  const grupos = new Map()
  for (const o of ofertas) {
    const clave = ESTADO[o.estado] ?? (o.evaluacion ? '📋 Evaluada' : '📋 Vista')
    if (!grupos.has(clave)) grupos.set(clave, [])
    grupos.get(clave).push(o)
  }
  const orden = [...grupos].sort(([a], [b]) => a.localeCompare(b))
  const lineas = [`${titulo} · ${new Date().toLocaleString('es-ES')}`, '']
  for (const [clave, lista] of orden) {
    lineas.push(`${clave} (${lista.length})`)
    lista.sort((a, b) => (b.evaluacion?.puntuacion ?? -1) - (a.evaluacion?.puntuacion ?? -1))
    for (const o of lista) {
      const prob = o.evaluacion?.puntuacion != null ? ` · ${o.evaluacion.puntuacion}/10` : ''
      lineas.push(`• ${o.puesto ?? '(sin puesto)'} · ${o.empresa ?? ''}${prob}`)
      lineas.push(`  ${o.url}`)
    }
    lineas.push('')
  }
  return lineas.join('\n').trimEnd()
}

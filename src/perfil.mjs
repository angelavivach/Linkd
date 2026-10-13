import { readFile, writeFile, access } from 'node:fs/promises'
import { extractText } from 'unpdf'

const existe = (ruta) => access(ruta).then(() => true, () => false)

/** El texto de una página web, sin etiquetas. Suficiente para un portfolio. */
function htmlATexto(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/**
 * El portfolio se descarga una vez y se guarda en perfil/.portfolio.txt: así
 * el texto que ve Claude no cambia entre ofertas y la caché de prompts acierta.
 * Bórralo para volver a descargarlo.
 */
async function leerPortfolio(url) {
  if (!url) return ''
  const cache = 'perfil/.portfolio.txt'
  if (await existe(cache)) return readFile(cache, 'utf8')
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const texto = htmlATexto(await res.text())
    await writeFile(cache, texto)
    return texto
  } catch (e) {
    console.warn(`⚠️  No pude leer el portfolio (${url}): ${e.message}. Sigo sin él.`)
    return ''
  }
}

/**
 * Tu perfil de LinkedIn se lee una vez y se guarda en perfil/.linkedin.txt.
 * Bórralo para que lo vuelva a leer (por ejemplo, si añades aptitudes).
 */
export async function perfilLinkedIn(leer) {
  const cache = 'perfil/.linkedin.txt'
  if (await existe(cache)) return readFile(cache, 'utf8')
  try {
    const texto = await leer()
    await writeFile(cache, texto)
    return texto
  } catch (e) {
    console.warn(`⚠️  No pude leer tu perfil de LinkedIn: ${e.message.split('\n')[0]}. Sigo sin él.`)
    return ''
  }
}

/** Todo lo que Claude sabe de ti: CV, perfil de LinkedIn, sobre-mi.md y portfolio. */
export async function cargarPerfil(config, linkedin = '') {
  if (!(await existe(config.cv))) {
    throw new Error(`No encuentro el CV en "${config.cv}". Ponlo ahí (PDF) o cambia "cv" en config.json.`)
  }
  const pdf = await readFile(config.cv)
  const { text: cv } = await extractText(new Uint8Array(pdf), { mergePages: true })
  if (!cv.trim()) {
    throw new Error('El CV no tiene texto seleccionable (¿es una imagen escaneada?). Expórtalo de nuevo como PDF con texto.')
  }

  const sobreMi = (await existe(config.sobreMi)) ? await readFile(config.sobreMi, 'utf8') : ''
  if (!sobreMi) console.warn(`⚠️  No hay ${config.sobreMi}: Claude solo sabrá lo que pone el CV.`)

  const portfolio = await leerPortfolio(config.portfolio)

  return [
    // El tipo de puesto que busca: Claude puntúa más bajo lo que se aleja de esto.
    ...(config.objetivo ? [`<puesto_que_busca>${config.objetivo}</puesto_que_busca>`] : []),
    `<cv>\n${cv.trim()}\n</cv>`,
    `<perfil_linkedin>\n${linkedin.trim()}\n</perfil_linkedin>`,
    `<sobre_mi>\n${sobreMi.trim()}\n</sobre_mi>`,
    `<portfolio url="${config.portfolio ?? ''}">\n${portfolio}\n</portfolio>`,
  ].join('\n\n')
}

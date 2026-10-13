import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms))
/** Pausas con algo de azar: LinkedIn bloquea a quien hace clic a ritmo de máquina. */
export const pausa = (min = 1200, max = 3000) => esperar(min + Math.random() * (max - min))

const RUTAS = {
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}
const PERFIL = resolve('.sesion')
const PUERTO = 9333

/**
 * Brave o Chrome arrancados como un navegador normal, con un perfil propio en
 * .sesion/ (no toca tu perfil de siempre). Si Playwright los lanzara él mismo,
 * marcaría el navegador como automatizado y Google rechazaría el inicio de
 * sesión ("Es posible que el navegador no sea seguro").
 */
function arrancar(navegador, extra = []) {
  const ruta = RUTAS[navegador]
  if (!ruta || !existsSync(ruta)) return null
  return spawn(ruta, [`--user-data-dir=${PERFIL}`, '--no-first-run', '--no-default-browser-check', ...extra], {
    stdio: 'ignore',
  })
}

/**
 * Para iniciar sesión: el navegador sin ningún control del programa. Entras tú
 * (con Google o con email) y lo cierras con Cmd+Q; las cookies quedan en .sesion/.
 * Devuelve false si ese navegador no está instalado.
 */
export function abrirParaLogin(navegador) {
  const proceso = arrancar(navegador, ['https://www.linkedin.com/login'])
  if (!proceso) return false
  return new Promise((r) => proceso.on('exit', () => r(true)))
}

/**
 * Para trabajar: arranca el navegador con un puerto de depuración local y
 * Playwright se conecta a él. 'chromium' usa el Chromium de Playwright.
 */
export async function abrirNavegador(navegador = 'brave') {
  if (navegador === 'chromium' || !RUTAS[navegador]) {
    const contexto = await chromium.launchPersistentContext(PERFIL, { headless: false, viewport: null, locale: 'es-ES' })
    const pagina = contexto.pages()[0] ?? (await contexto.newPage())
    return { pagina, cerrar: () => contexto.close() }
  }

  const proceso = arrancar(navegador, [`--remote-debugging-port=${PUERTO}`, '--remote-debugging-address=127.0.0.1'])
  if (!proceso) throw new Error(`No encuentro ${navegador} en /Applications. Cambia "navegador" en config.json.`)

  let navegadorCDP
  for (let i = 0; i < 30 && !navegadorCDP; i++) {
    await esperar(500)
    navegadorCDP = await chromium.connectOverCDP(`http://127.0.0.1:${PUERTO}`).catch(() => null)
  }
  if (!navegadorCDP) {
    throw new Error(`No pude conectar con ${navegador}. Si quedó abierta una ventana de Linkd (la de npm run login), ciérrala con Cmd+Q y vuelve a probar.`)
  }
  const contexto = navegadorCDP.contexts()[0]
  const pagina = contexto.pages()[0] ?? (await contexto.newPage())
  return {
    pagina,
    cerrar: async () => {
      await navegadorCDP.close().catch(() => {})
      proceso.kill()
    },
  }
}

export async function haySesion(pagina) {
  await pagina.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' })
  await pausa()
  return /linkedin\.com\/feed/.test(pagina.url())
}

/**
 * El texto de tu propio perfil de LinkedIn (titular, extracto, experiencia,
 * formación y aptitudes), para que Claude sepa lo que tienes ahí.
 */
export async function leerMiPerfil(pagina) {
  await pagina.goto('https://www.linkedin.com/in/me/', { waitUntil: 'domcontentloaded' })
  await pausa(3000, 4500)
  const url = pagina.url().replace(/\/$/, '')
  const textoDe = () => pagina.evaluate(() => (document.querySelector('main')?.innerText ?? '').replace(/\n{2,}/g, '\n').trim())
  const partes = [await textoDe()]
  // Las aptitudes completas están en su propia página.
  await pagina.goto(`${url}/details/skills/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await pausa(2500, 4000)
  partes.push(await textoDe())
  return partes.join('\n\n')
}

// ---------------------------------------------------------------- Búsqueda --

/** IDs de las ofertas de una búsqueda. */
export async function buscarOfertas(pagina, busqueda, { dias = 7, paginas = 1, soloSencilla = false, niveles = [], orden = 'relevancia' } = {}) {
  const ids = new Set()
  for (let p = 0; p < paginas; p++) {
    const url = new URL('https://www.linkedin.com/jobs/search/')
    url.searchParams.set('keywords', busqueda.palabras)
    if (busqueda.ubicacion) url.searchParams.set('location', busqueda.ubicacion)
    if (soloSencilla) url.searchParams.set('f_AL', 'true')
    if (dias) url.searchParams.set('f_TPR', `r${dias * 86400}`)
    url.searchParams.set('sortBy', orden === 'fecha' ? 'DD' : 'R')
    // Nivel de experiencia: 1 prácticas, 2 sin experiencia, 3 junior/asociado, 4 intermedio-senior.
    if (niveles.length) url.searchParams.set('f_E', niveles.join(','))
    if (p) url.searchParams.set('start', String(p * 25))

    await pagina.goto(url.toString(), { waitUntil: 'domcontentloaded' })
    await pausa(2500, 4500)

    // La lista carga las tarjetas al hacer scroll dentro de su propio panel.
    for (let i = 0; i < 8; i++) {
      await pagina.evaluate(() => {
        const tarjeta = document.querySelector('[data-occludable-job-id], [data-job-id]')
        let el = tarjeta?.parentElement
        while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) {
          el = el.parentElement
        }
        ;(el ?? document.scrollingElement).scrollBy(0, 600)
      })
      await pausa(400, 900)
    }

    const encontrados = await pagina.evaluate(() =>
      [...document.querySelectorAll('[data-occludable-job-id], [data-job-id]')]
        .map((el) => el.getAttribute('data-occludable-job-id') || el.getAttribute('data-job-id'))
        .filter((id) => /^\d+$/.test(id)),
    )
    if (!encontrados.length) break
    encontrados.forEach((id) => ids.add(id))
  }
  return [...ids]
}

// ------------------------------------------------------------------ Oferta --

const BOTON_SOLICITUD = /solicitud sencilla|easy apply/i
// El "Solicitar" que lleva a la web de la empresa.
const BOTON_EXTERNO = /^\s*(solicitar|apply|inscribirse)\b/i
const botonExterno = (pagina) =>
  pagina
    .locator('.jobs-apply-button, button[aria-label*="sitio web"], button[aria-label*="company website"], button, a')
    .filter({ hasText: BOTON_EXTERNO })
    .first()

export async function leerOferta(pagina, id) {
  const url = `https://www.linkedin.com/jobs/view/${id}/`
  await pagina.goto(url, { waitUntil: 'domcontentloaded' })
  await pagina.locator('h1').first().waitFor({ timeout: 20_000 }).catch(() => {})
  await pausa(1500, 3000)

  // "Ver más" de la descripción, si está.
  await pagina.locator('button[aria-label*="descripción"], button[aria-label*="description"]').first().click({ timeout: 1500 }).catch(() => {})

  const datos = await pagina.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.innerText?.trim() ?? ''
    // LinkedIn ofusca sus clases, pero el título de la pestaña es estable:
    // "Puesto | Empresa | LinkedIn".
    const [tPuesto, tEmpresa] = document.title.split(' | ')
    const acerca = [...document.querySelectorAll('h2, h3')].find((h) => /acerca del empleo|about the job/i.test(h.innerText))
    let bloque = acerca
    while (bloque && bloque.innerText.length < 300 && bloque.parentElement) bloque = bloque.parentElement
    return {
      puesto: tPuesto?.trim() || txt('h1'),
      empresa:
        tEmpresa?.trim() ||
        txt('.job-details-jobs-unified-top-card__company-name') ||
        txt('.jobs-unified-top-card__company-name') ||
        document.querySelector('main a[href*="/company/"]')?.innerText?.trim() || '',
      ubicacion:
        txt('.job-details-jobs-unified-top-card__primary-description-container') ||
        txt('.job-details-jobs-unified-top-card__tertiary-description-container') || '',
      descripcion:
        (bloque?.innerText?.trim() ?? '') ||
        txt('#job-details') || txt('.jobs-description__content') || txt('.jobs-box__html-content') ||
        (document.querySelector('main')?.innerText ?? '').slice(0, 15000),
    }
  })
  const boton = pagina.locator('button, a').filter({ hasText: BOTON_SOLICITUD }).first()
  const sencilla = await boton.isVisible().catch(() => false)
  const externa = !sencilla && (await botonExterno(pagina).isVisible().catch(() => false))
  return { id, url, ...datos, sencilla, externa }
}

// ---------------------------------------------------------- El formulario --

/**
 * Pulsa "Solicitar" y devuelve la pestaña con la web de la empresa (LinkedIn
 * la abre en una pestaña nueva, a veces tras un aviso de "Continuar").
 */
export async function abrirWebExterna(pagina) {
  const nueva = pagina.context().waitForEvent('page', { timeout: 20_000 }).catch(() => null)
  await botonExterno(pagina).click()
  await pausa(1500, 2500)
  await pagina
    .locator('[role="dialog"] button, [role="dialog"] a')
    .filter({ hasText: /continuar|continue/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {})
  const web = (await nueva) ?? (/linkedin\.com/.test(pagina.url()) ? null : pagina)
  if (!web) throw new Error('no se abrió la web de la empresa')
  await web.waitForLoadState('domcontentloaded').catch(() => {})
  await pausa(2000, 3500)
  return web
}

/** El modal de "Solicitud sencilla". */
const modalDe = (pagina) =>
  pagina.locator('dialog[data-testid="dialog"][open], .jobs-easy-apply-modal, [role="dialog"][aria-modal="true"]').last()

export async function abrirSolicitud(pagina) {
  const boton = pagina.locator('button, a').filter({ hasText: BOTON_SOLICITUD, visible: true }).first()
  const modal = modalDe(pagina)
  // Si la página aún se está montando, el primer clic a veces no hace nada.
  for (let intento = 0; intento < 3; intento++) {
    await boton.click()
    if (await modal.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await pausa()
      return modal
    }
  }
  throw new Error('no se abrió el formulario de Solicitud sencilla')
}

/**
 * Describe los campos del paso actual: tipo, pregunta, opciones y valor actual.
 * Marca cada uno con data-linkd="cN" para poder rellenarlo después.
 */
export function leerCampos(modal) {
  return modal.evaluate((raiz) => {
    const limpiar = (t) => (t || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    const contenedor = (el) =>
      el.closest('.fb-dash-form-element, .jobs-easy-apply-form-element, [data-test-form-element], .jobs-easy-apply-form-section__grouping')
    const etiquetaDe = (el) => {
      if (el.id) {
        const l = raiz.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (l) return limpiar(l.innerText)
      }
      const l = el.closest('label')
      if (l) return limpiar(l.innerText)
      if (el.getAttribute('aria-label')) return limpiar(el.getAttribute('aria-label'))
      const ref = el.getAttribute('aria-labelledby')
      if (ref) return limpiar(ref.split(/\s+/).map((i) => document.getElementById(i)?.innerText ?? '').join(' '))
      return limpiar(contenedor(el)?.innerText).slice(0, 300)
    }
    const obligatorio = (el, texto) =>
      el.required || el.getAttribute('aria-required') === 'true' || /\*|obligatori|required/i.test(texto)

    raiz.querySelectorAll('[data-linkd]').forEach((el) => el.removeAttribute('data-linkd'))
    let n = 0
    const marcar = (el) => {
      const id = `c${n++}`
      el.setAttribute('data-linkd', id)
      return id
    }
    const campos = []
    const esSeguir = (cb) => /follow|sigue a|seguir a/i.test(`${cb.id} ${cb.getAttribute('aria-label') ?? ''} ${etiquetaDe(cb)}`)

    // Opción única: radios agrupados en un fieldset (los radios están ocultos; el fieldset no).
    for (const fs of raiz.querySelectorAll('fieldset')) {
      const radios = [...fs.querySelectorAll('input[type="radio"]')].filter((r) => !/\.pdf$|\.docx?$/i.test(r.getAttribute('aria-label') ?? ''))
      if (!radios.length || !visible(fs)) continue
      // La pregunta: el legend o, en la web nueva, el aria-label de los radios.
      const etiqueta =
        limpiar(fs.querySelector('legend')?.innerText) ||
        limpiar(radios[0].getAttribute('aria-label')) ||
        limpiar(fs.getAttribute('aria-label')) ||
        limpiar(fs.innerText).slice(0, 300)
      // El texto de cada opción: su label o, si está vacío, el texto que tiene al lado.
      const opcionDe = (r) => {
        const propia = limpiar([...(r.labels ?? [])].map((l) => l.innerText).join(' '))
        if (propia) return propia
        let el = r.parentElement
        while (el && el !== fs && !limpiar(el.innerText)) el = el.parentElement
        return el && el !== fs ? limpiar(el.innerText) : limpiar(r.value)
      }
      const opciones = radios.map(opcionDe)
      campos.push({
        id: marcar(fs), tipo: 'opcion', etiqueta, opciones,
        // Lo que LinkedIn trae marcado no se da por bueno (puede ser una
        // respuesta antigua o un valor por defecto): se responde según el perfil.
        valorActual: '',
        obligatorio: obligatorio(radios[0], etiqueta),
      })
    }

    for (const sel of raiz.querySelectorAll('select')) {
      if (!visible(sel)) continue
      const etiqueta = etiquetaDe(sel)
      const opciones = [...sel.options].slice(sel.options[0]?.value ? 0 : 1).map((o) => limpiar(o.text))
      const placeholder = /selecciona|select an option/i.test(sel.options[sel.selectedIndex]?.text ?? '')
      campos.push({
        id: marcar(sel), tipo: 'seleccion', etiqueta, opciones,
        valorActual: sel.selectedIndex >= 0 && !placeholder && sel.value ? limpiar(sel.options[sel.selectedIndex].text) : '',
        obligatorio: obligatorio(sel, etiqueta),
      })
    }

    const textos = raiz.querySelectorAll(
      'input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input[type="url"], input:not([type]), textarea',
    )
    for (const el of textos) {
      if (!visible(el) || el.disabled || el.readOnly) continue
      const etiqueta = etiquetaDe(el)
      const tipo =
        el.tagName === 'TEXTAREA' ? 'texto_largo'
        : el.getAttribute('role') === 'combobox' ? 'autocompletar'
        : el.type === 'number' || /numeric/.test(el.id) ? 'numero'
        : 'texto'
      campos.push({ id: marcar(el), tipo, etiqueta, valorActual: el.value ?? '', obligatorio: obligatorio(el, etiqueta) })
    }

    for (const cb of raiz.querySelectorAll('input[type="checkbox"]')) {
      if (cb.closest('[data-linkd]') || esSeguir(cb)) continue
      const etiqueta = etiquetaDe(cb)
      if (!etiqueta) continue
      campos.push({
        id: marcar(cb), tipo: 'casilla', etiqueta,
        valorActual: cb.checked ? 'sí' : '',
        obligatorio: obligatorio(cb, etiqueta),
      })
    }

    for (const f of raiz.querySelectorAll('input[type="file"]')) {
      const etiqueta = etiquetaDe(f) || limpiar(contenedor(f)?.innerText)
      // Si ya hay un CV elegido de solicitudes anteriores no hace falta subir otro.
      const yaHayCV =
        [...raiz.querySelectorAll('input[type="radio"]')].some((r) => r.checked && /\.(pdf|docx?)$/i.test(r.getAttribute('aria-label') ?? '')) ||
        !!raiz.querySelector('.jobs-document-upload-redesign-card__container--selected, .jobs-resume-picker__resume--selected')
      campos.push({ id: marcar(f), tipo: 'archivo', etiqueta, valorActual: yaHayCV ? 'cv ya elegido' : '', obligatorio: false })
    }

    return campos
  })
}

/** Escribe `valor` en el campo `campo` (uno de los devueltos por leerCampos). */
export async function rellenar(modal, campo, valor) {
  const el = modal.locator(`[data-linkd="${campo.id}"]`)
  // Los radios y casillas de LinkedIn están ocultos: se pulsa su etiqueta.
  const pulsar = (loc) => loc.evaluate((i) => (i.labels?.[0] ?? i).click())

  switch (campo.tipo) {
    case 'texto':
    case 'texto_largo':
    case 'numero':
      await el.fill(String(valor))
      break
    case 'autocompletar':
      await el.fill('')
      await el.pressSequentially(String(valor), { delay: 60 })
      await pausa(1200, 2000)
      await el.press('ArrowDown')
      await el.press('Enter')
      break
    case 'seleccion':
      await el.selectOption({ label: valor })
      break
    case 'opcion': {
      const i = campo.opciones.indexOf(valor)
      if (i < 0) throw new Error(`"${valor}" no es una opción de "${campo.etiqueta}"`)
      await pulsar(el.locator('input[type="radio"]').nth(i))
      break
    }
    case 'casilla': {
      const quiero = /^(s[ií]|yes|true)$/i.test(String(valor).trim())
      if (quiero !== (await el.isChecked())) await pulsar(el)
      break
    }
    case 'archivo':
      await el.setInputFiles(valor)
      break
  }
  await pausa(300, 800)
}

/** Avisos de error que LinkedIn muestra bajo los campos. */
export function erroresVisibles(modal) {
  return modal.evaluate((raiz) =>
    // Los campos que LinkedIn marca como inválidos, con el aviso que tengan
    // asociado. (Los role="alert" no sirven: también avisan de "CV cargado".)
    [...raiz.querySelectorAll('[aria-invalid="true"]')]
      .map((el) => {
        const ids = `${el.getAttribute('aria-errormessage') ?? ''} ${el.getAttribute('aria-describedby') ?? ''}`.trim().split(/\s+/)
        const aviso = ids.map((id) => id && document.getElementById(id)?.innerText?.trim()).filter(Boolean).join(' ') || 'respuesta no válida'
        const pregunta =
          [...(el.labels ?? [])].map((l) => l.innerText).join(' ') ||
          el.closest('fieldset')?.querySelector('legend')?.innerText ||
          el.getAttribute('aria-label') ||
          ''
        return `${pregunta.trim()}: ${aviso}`.replace(/\s+/g, ' ')
      }),
  )
}

const BOTONES = {
  enviar: /enviar solicitud|submit application/i,
  revisar: /^\s*(revisar|review)\s*$/i,
  siguiente: /siguiente|next|continuar|continue/i,
}

/** Qué botón ofrece el pie del modal ahora: 'enviar', 'revisar', 'siguiente' o null. */
export async function botonDisponible(modal) {
  for (const [nombre, texto] of Object.entries(BOTONES)) {
    if (await modal.locator('button').filter({ hasText: texto }).first().isVisible().catch(() => false)) return nombre
  }
  return null
}

export async function pulsarBoton(modal, nombre) {
  await modal.locator('button').filter({ hasText: BOTONES[nombre] }).first().click()
  await pausa(1500, 2500)
}

/** Desmarca "Seguir a la empresa", que viene marcado por defecto en el último paso. */
export async function noSeguirEmpresa(modal) {
  const casillas = modal.locator('input[type="checkbox"]')
  for (let i = 0; i < (await casillas.count()); i++) {
    const cb = casillas.nth(i)
    const texto = `${await cb.getAttribute('id')} ${await cb.getAttribute('aria-label')}`
    if (/follow|sigue a|seguir a/i.test(texto) && (await cb.isChecked())) await cb.evaluate((i) => (i.labels?.[0] ?? i).click())
  }
}

/** Texto del paso de revisión, para enseñártelo antes de enviar. */
export const resumenRevision = (modal) => modal.innerText().then((t) => t.replace(/\n{2,}/g, '\n').trim())

/** Cierra el modal; si pregunta, descarta el borrador. */
export async function cerrarSolicitud(pagina) {
  await pagina.keyboard.press('Escape')
  await pausa(800, 1500)
  await pagina
    .locator('[role="alertdialog"] button, [role="dialog"] button, dialog button')
    .filter({ hasText: /descartar|discard/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {})
  await pausa(800, 1500)
}

/** Tras enviar, LinkedIn abre un aviso de "Solicitud enviada": se cierra. */
export async function cerrarConfirmacion(pagina) {
  await pausa(2000, 3500)
  await pagina.keyboard.press('Escape').catch(() => {})
  await pausa(500, 1000)
}

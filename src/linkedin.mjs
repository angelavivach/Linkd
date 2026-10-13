import { chromium } from 'playwright'

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms))
/** Pausas con algo de azar: LinkedIn bloquea a quien hace clic a ritmo de máquina. */
export const pausa = (min = 1200, max = 3000) => esperar(min + Math.random() * (max - min))

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

/**
 * Navegador con perfil propio en .sesion/: inicias sesión una vez a mano y las
 * cookies se quedan ahí. La contraseña nunca pasa por este programa.
 * `navegador` (de config.json): 'brave', 'chrome' o 'chromium'. Si el elegido
 * no está instalado, usa el Chromium de Playwright.
 */
export async function abrirNavegador(navegador = 'chrome') {
  const opciones = { headless: false, viewport: null, locale: 'es-ES', args: ['--start-maximized'] }
  const elegido =
    navegador === 'brave' ? { executablePath: BRAVE }
    : navegador === 'chrome' ? { channel: 'chrome' }
    : {}
  let contexto
  try {
    contexto = await chromium.launchPersistentContext('.sesion', { ...opciones, ...elegido })
  } catch (e) {
    if (navegador !== 'chromium') console.warn(`⚠️  No pude abrir ${navegador} (${e.message.split('\n')[0]}). Uso Chromium.`)
    contexto = await chromium.launchPersistentContext('.sesion', opciones)
  }
  const pagina = contexto.pages()[0] ?? (await contexto.newPage())
  return { contexto, pagina }
}

export async function haySesion(pagina) {
  await pagina.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' })
  await pausa()
  return /linkedin\.com\/feed/.test(pagina.url())
}

/** Abre el login y espera (hasta 5 min) a que entres tú. */
export async function esperarLogin(pagina) {
  await pagina.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' })
  await pagina.waitForURL(/linkedin\.com\/feed/, { timeout: 5 * 60_000 })
}

// ---------------------------------------------------------------- Búsqueda --

/** IDs de las ofertas con "Solicitud sencilla" de una búsqueda. */
export async function buscarOfertas(pagina, busqueda, { dias = 7, paginas = 1 } = {}) {
  const ids = new Set()
  for (let p = 0; p < paginas; p++) {
    const url = new URL('https://www.linkedin.com/jobs/search/')
    url.searchParams.set('keywords', busqueda.palabras)
    if (busqueda.ubicacion) url.searchParams.set('location', busqueda.ubicacion)
    url.searchParams.set('f_AL', 'true') // solo "Solicitud sencilla"
    if (dias) url.searchParams.set('f_TPR', `r${dias * 86400}`)
    url.searchParams.set('sortBy', 'DD')
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

export async function leerOferta(pagina, id) {
  const url = `https://www.linkedin.com/jobs/view/${id}/`
  await pagina.goto(url, { waitUntil: 'domcontentloaded' })
  await pagina.locator('h1').first().waitFor({ timeout: 20_000 }).catch(() => {})
  await pausa(1500, 3000)

  // "Ver más" de la descripción, si está.
  await pagina.locator('button[aria-label*="descripción"], button[aria-label*="description"]').first().click({ timeout: 1500 }).catch(() => {})

  const datos = await pagina.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.innerText?.trim() ?? ''
    return {
      puesto: txt('h1'),
      empresa:
        txt('.job-details-jobs-unified-top-card__company-name') ||
        txt('.jobs-unified-top-card__company-name') ||
        document.querySelector('main a[href*="/company/"]')?.innerText?.trim() || '',
      ubicacion:
        txt('.job-details-jobs-unified-top-card__primary-description-container') ||
        txt('.job-details-jobs-unified-top-card__tertiary-description-container') || '',
      descripcion:
        txt('#job-details') || txt('.jobs-description__content') || txt('.jobs-box__html-content') ||
        (document.querySelector('main')?.innerText ?? '').slice(0, 15000),
    }
  })
  const boton = pagina.locator('button, a').filter({ hasText: BOTON_SOLICITUD }).first()
  const sencilla = await boton.isVisible().catch(() => false)
  return { id, url, ...datos, sencilla }
}

// ---------------------------------------------------------- El formulario --

/** El modal de "Solicitud sencilla". */
const modalDe = (pagina) => pagina.locator('.jobs-easy-apply-modal, div[role="dialog"]:has(form)').last()

export async function abrirSolicitud(pagina) {
  await pagina.locator('button, a').filter({ hasText: BOTON_SOLICITUD }).first().click()
  const modal = modalDe(pagina)
  await modal.waitFor({ timeout: 15_000 })
  await pausa()
  return modal
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

    // Opción única: radios agrupados en un fieldset (los radios están ocultos; el fieldset no).
    for (const fs of raiz.querySelectorAll('fieldset')) {
      const radios = [...fs.querySelectorAll('input[type="radio"]')]
      if (!radios.length || !visible(fs)) continue
      const etiqueta = limpiar(fs.querySelector('legend')?.innerText) || limpiar(fs.innerText).slice(0, 300)
      const opciones = radios.map(etiquetaDe)
      const marcado = radios.find((r) => r.checked)
      campos.push({
        id: marcar(fs), tipo: 'opcion', etiqueta, opciones,
        valorActual: marcado ? etiquetaDe(marcado) : '',
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
      if (cb.closest('[data-linkd]') || /follow/i.test(cb.id)) continue
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
      const yaHayCV = !!raiz.querySelector(
        '.jobs-document-upload-redesign-card__container--selected, .jobs-resume-picker__resume--selected, [aria-label*="seleccionado"] [data-test-document-upload-file-name]',
      )
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
    [...raiz.querySelectorAll('.artdeco-inline-feedback--error, [data-test-form-element-error-messages]')]
      .filter((e) => e.offsetParent)
      .map((e) => {
        const campo = e.closest('.fb-dash-form-element, .jobs-easy-apply-form-element, [data-test-form-element]')
        const pregunta = campo?.querySelector('label, legend')?.innerText?.trim() ?? ''
        return `${pregunta}: ${e.innerText.trim()}`.replace(/\s+/g, ' ')
      })
      .filter(Boolean),
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
  const cb = modal.locator('input[type="checkbox"][id*="follow"]').first()
  if (await cb.isChecked().catch(() => false)) await cb.evaluate((i) => (i.labels?.[0] ?? i).click())
}

/** Texto del paso de revisión, para enseñártelo antes de enviar. */
export const resumenRevision = (modal) => modal.innerText().then((t) => t.replace(/\n{2,}/g, '\n').trim())

/** Cierra el modal; si pregunta, descarta el borrador. */
export async function cerrarSolicitud(pagina) {
  await pagina.keyboard.press('Escape')
  await pausa(800, 1500)
  await pagina
    .locator('[role="alertdialog"] button, div[role="dialog"] button')
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

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { cargarPerfil, perfilLinkedIn } from './perfil.mjs'
import { evaluarOferta, responderCampos, sugerirBusquedas } from './claude.mjs'
import * as li from './linkedin.mjs'
import { ofertasVistas, anotar, guardarOferta, cargarRespuestas } from './registro.mjs'
import { generarInforme } from './informe.mjs'
import { solicitarEnWeb } from './web.mjs'

/**
 * Modos:
 *   revisar (por defecto)  rellena todo, te pregunta lo que no sabe y te pide
 *                          confirmación antes de enviar cada solicitud.
 *   --auto                 envía sin preguntar; si falta algún dato, salta la oferta.
 *   --prueba               rellena hasta el último paso y descarta. No envía nada.
 */
const args = process.argv.slice(2)
const modo = args.includes('--auto') ? 'auto' : args.includes('--prueba') ? 'prueba' : 'revisar'

let terminal
const preguntar = (texto) => {
  if (!terminal) {
    terminal = createInterface({ input: process.stdin, output: process.stdout })
    // Mientras espera una respuesta, Ctrl+C lo recoge readline y no llega al
    // proceso: se reenvía para que cierre el navegador y salga.
    terminal.on('SIGINT', () => process.emit('SIGINT'))
  }
  return terminal.question(texto)
}

async function leerConfig() {
  try {
    return JSON.parse(await readFile('config.json', 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('Falta config.json. Copia config.example.json como config.json y rellénalo.')
    throw new Error(`config.json no es JSON válido: ${e.message}`)
  }
}

/** Busca entre las opciones la que Claude quiso decir (mayúsculas, espacios…). */
function ajustarOpcion(campo, valor) {
  if (!campo.opciones?.length) return valor
  const norm = (s) => s.toLowerCase().trim()
  return (
    campo.opciones.find((o) => norm(o) === norm(valor)) ??
    campo.opciones.find((o) => norm(o).includes(norm(valor)) || norm(valor).includes(norm(o))) ??
    null
  )
}

/** Te enseña una pregunta dudosa con la propuesta de Claude. Enter = aceptar. */
async function confirmarConmigo(campo, propuesta, nota) {
  console.log(`\n❓ ${campo.etiqueta}`)
  if (campo.opciones?.length) campo.opciones.forEach((o, i) => console.log(`   ${i + 1}. ${o}`))
  if (nota) console.log(`   (Claude: ${nota})`)
  const r = (await preguntar(`   Respuesta [${propuesta}]: `)).trim()
  if (!r) return propuesta
  if (campo.opciones?.length && /^\d+$/.test(r)) return campo.opciones[Number(r) - 1] ?? propuesta
  return r
}

/** Rellena una "Solicitud sencilla" de principio a fin. Devuelve { estado, motivo }. */
async function solicitar(pagina, oferta, { perfil, respuestas, config }) {
  const modal = await li.abrirSolicitud(pagina, oferta)
  const usadas = []
  let errores = []
  let reintentos = 0
  let revisarTodo = false

  for (let paso = 0; paso < 20; paso++) {
    if ((await li.botonDisponible(modal)) === 'enviar') {
      await li.noSeguirEmpresa(modal)
      await guardarOferta(oferta, { respuestas: usadas })

      if (modo === 'prueba') {
        console.log(`\n${await li.resumenRevision(modal)}\n`)
        await li.cerrarSolicitud(pagina)
        return { estado: 'prueba', motivo: 'llegó al último paso (no se envía en modo prueba)' }
      }
      // "confirmarEnvio": false en config.json → envía sin preguntar s/n.
      if (modo === 'revisar' && config.confirmarEnvio !== false) {
        console.log('\n— Respuestas —')
        usadas.forEach((u) => console.log(`• ${u.pregunta}\n  → ${u.respuesta}`))
        const r = (await preguntar(`\n¿Enviar a ${oferta.empresa} (${oferta.puesto})? [s]í / [n]o / [p]arar: `)).trim().toLowerCase()
        if (r === 'p') {
          await li.cerrarSolicitud(pagina)
          return { estado: 'parar' }
        }
        if (r !== 's') {
          await li.cerrarSolicitud(pagina)
          return { estado: 'omitida', motivo: 'descartada por ti' }
        }
      }
      await li.pulsarBoton(modal, 'enviar')
      await li.cerrarConfirmacion(pagina)
      return { estado: 'enviada' }
    }

    const campos = await li.leerCampos(modal)

    // El CV, si este paso lo pide y no hay uno elegido ya.
    for (const c of campos.filter((c) => c.tipo === 'archivo' && !c.valorActual)) {
      if (/cv|curr[ií]cul|resume|résumé/i.test(c.etiqueta) || campos.filter((x) => x.tipo === 'archivo').length === 1) {
        await li.rellenar(modal, c, resolve(config.cv))
      }
    }

    // Qué hay que responder: lo vacío, y lo que LinkedIn marcó como erróneo.
    const conError = (c) => errores.some((e) => e.toLowerCase().includes(c.etiqueta.toLowerCase().slice(0, 40)))
    let pendientes = campos.filter((c) => c.tipo !== 'archivo' && (!c.valorActual || conError(c)))
    // Si el paso no avanzó, se revisan todas, también las que ya tenían valor.
    if (revisarTodo || (errores.length && !pendientes.length)) pendientes = campos.filter((c) => c.tipo !== 'archivo')

    const decididas = new Map()
    const paraClaude = []
    for (const c of pendientes) {
      const sabida = !conError(c) && respuestas.buscar(c)
      if (sabida != null && sabida !== false && ajustarOpcion(c, sabida) != null) decididas.set(c.id, ajustarOpcion(c, sabida))
      else paraClaude.push(c)
    }

    if (paraClaude.length) {
      const deClaude = await responderCampos(perfil, oferta, paraClaude, errores)
      const dudas = []
      for (const c of paraClaude) {
        const r = deClaude.find((x) => x.id === c.id)
        const valor = r ? ajustarOpcion(c, r.valor) : null
        if (r && r.seguro && valor != null) {
          decididas.set(c.id, valor)
          await respuestas.guardar(c, valor)
        } else {
          dudas.push({ c, propuesta: valor ?? r?.valor ?? '', nota: r?.nota ?? '' })
        }
      }

      if (dudas.length) {
        if (modo === 'auto') {
          await li.cerrarSolicitud(pagina)
          return { estado: 'omitida', motivo: `faltan datos: ${dudas.map((d) => d.c.etiqueta).join(' | ')}` }
        }
        for (const { c, propuesta, nota } of dudas) {
          const valor = await confirmarConmigo(c, propuesta, nota)
          decididas.set(c.id, valor)
          await respuestas.guardar(c, valor)
        }
      }
    }

    for (const c of pendientes) {
      const valor = decididas.get(c.id)
      if (valor == null || valor === '') continue
      try {
        await li.rellenar(modal, c, valor)
        usadas.push({ pregunta: c.etiqueta, respuesta: valor })
      } catch (e) {
        console.warn(`   ⚠️  No pude rellenar "${c.etiqueta}": ${e.message}`)
      }
    }

    const siguiente = await li.botonDisponible(modal)
    if (!siguiente) throw new Error('no encuentro el botón para seguir')
    const antes = await li.firmaPaso(modal)
    await li.pulsarBoton(modal, siguiente)

    errores = await li.erroresVisibles(modal)
    const avanzo = (await li.firmaPaso(modal)) !== antes
    // Si después de dos intentos sigue sin avanzar, el agente de Claude se
    // encarga del formulario tal cual lo ve (campos raros, fechas, ubicaciones…).
    if (!avanzo && reintentos >= 1) {
      console.log('   🤖 El formulario no avanza: lo termina el agente de Claude')
      return solicitarEnWeb(pagina, oferta, { perfil, config, modo, preguntar, enLinkedIn: true })
    }
    if (errores.length || !avanzo) {
      if (!errores.length) errores = ['El formulario no avanzó al pulsar Siguiente: falta o es incorrecta alguna respuesta de este paso.']
      console.log(`   LinkedIn se queja: ${errores.join(' · ')}`)
      revisarTodo = true
      if (++reintentos > 2) {
        const vacias = (await li.leerCampos(modal)).filter((c) => c.tipo !== 'archivo' && !c.valorActual).map((c) => c.etiqueta)
        throw new Error(`el formulario no avanza: ${errores.join(' · ')}${vacias.length ? ` (sin responder: ${vacias.join(' | ')})` : ''}`)
      }
    } else {
      reintentos = 0
      revisarTodo = false
    }
  }
  throw new Error('demasiados pasos en el formulario')
}

/** Filtros baratos antes de gastar una llamada a Claude. */
function motivoParaSaltar(oferta, config) {
  if (oferta.yaSolicitada) return 'ya la solicitaste'
  if (oferta.cerrada) return 'ya no acepta solicitudes'
  const webEmpresa = config.webEmpresa ?? true
  if (!oferta.sencilla && !(oferta.externa && webEmpresa)) {
    return oferta.externa ? 'se solicita en la web de la empresa (webEmpresa está desactivado)' : 'no tiene botón para solicitar (¿ya solicitada?)'
  }
  const titulo = oferta.puesto.toLowerCase()
  const palabra = (config.excluirPalabrasEnTitulo ?? []).find((p) => titulo.includes(p.toLowerCase()))
  if (palabra) return `el título contiene "${palabra}"`
  const empresa = (config.excluirEmpresas ?? []).find((e) => oferta.empresa.toLowerCase().includes(e.toLowerCase()))
  if (empresa) return `empresa excluida (${empresa})`
  return null
}

async function main() {
  if (args[0] === 'informe') {
    const informe = await generarInforme()
    console.log(informe ? `📊 ${informe}` : 'Aún no hay ofertas evaluadas en registro/.')
    return
  }

  if (args[0] === 'login') {
    const navegador = (await leerConfig().catch(() => ({}))).navegador ?? 'brave'
    console.log(`Inicia sesión en LinkedIn en la ventana de ${navegador} que se ha abierto.`)
    console.log('Cuando veas tu inicio de LinkedIn, cierra esa ventana con Cmd+Q.')
    if (!(await li.abrirParaLogin(navegador))) {
      // Chromium de Playwright: no hay otra forma que abrirlo controlado.
      const { pagina, cerrar } = await li.abrirNavegador('chromium')
      await pagina.goto('https://www.linkedin.com/login')
      await pagina.waitForURL(/linkedin\.com\/feed/, { timeout: 5 * 60_000 })
      await cerrar()
    }
    console.log('✅ Sesión guardada en .sesion/. Ya puedes usar npm run prueba.')
    return
  }

  const config = await leerConfig()
  const respuestas = await cargarRespuestas()
  const vistas = await ofertasVistas()
  const [esperaMin, esperaMax] = config.segundosEntreOfertas ?? [20, 60]
  const max = config.maxPorEjecucion ?? 15

  const describirModo = {
    prueba: 'PRUEBA: rellena pero no envía nada',
    auto: 'AUTOMÁTICO: envía solo y salta las ofertas a las que les falten datos',
    revisar: config.confirmarEnvio === false ? 'NORMAL: envía sin preguntar; solo te pregunta los datos que falten' : 'NORMAL: te pide confirmación antes de cada envío',
  }[modo]
  console.log(`Modo ${describirModo}. Máximo ${max} solicitudes en esta ejecución.`)
  const { pagina, cerrar } = await li.abrirNavegador(config.navegador)
  cerrarNavegador = cerrar
  process.on('SIGINT', async () => {
    // Parar a mitad también deja el informe al día con lo evaluado hasta ahora.
    await cerrar().catch(() => {})
    await generarInforme().catch(() => {})
    process.exit(130)
  })

  if (!(await li.haySesion(pagina))) throw new Error('No hay sesión de LinkedIn. Ejecuta antes: npm run login')
  const perfil = await cargarPerfil(config, await perfilLinkedIn(() => li.leerMiPerfil(pagina)))

  let enviadas = 0
  // --oferta <id>: solo esa oferta, sin buscar (para repetir una concreta).
  const unaOferta = args.includes('--oferta') ? args[args.indexOf('--oferta') + 1] : null
  let busquedas = unaOferta ? [{ palabras: `oferta ${unaOferta}`, id: unaOferta }] : (config.busquedas ?? [])
  // "busquedas": "auto" → las propone Claude a partir de tu perfil (se guardan
  // en perfil/.busquedas.json; bórralo para que proponga otras).
  if (busquedas === 'auto') {
    const cache = 'perfil/.busquedas.json'
    let palabras = await readFile(cache, 'utf8').then(JSON.parse, () => null)
    if (!palabras) {
      palabras = await sugerirBusquedas(perfil)
      await writeFile(cache, JSON.stringify(palabras, null, 2))
    }
    console.log(`Búsquedas a partir de tu perfil: ${palabras.join(' · ')}`)
    busquedas = palabras.map((p) => ({ palabras: p, ubicacion: config.ubicacion ?? 'España' }))
  }

  buscar: for (const busqueda of busquedas) {
    console.log(`\n🔎 ${busqueda.palabras} — ${busqueda.ubicacion ?? ''}`)
    const ids = busqueda.id ? [busqueda.id] : await li.buscarOfertas(pagina, busqueda, {
      dias: config.soloUltimosDias,
      paginas: config.paginasPorBusqueda ?? 1,
      soloSencilla: config.webEmpresa === false,
      niveles: config.nivelExperiencia ?? [],
      orden: config.orden ?? 'relevancia',
    })
    const nuevas = unaOferta ? ids : ids.filter((id) => !vistas.has(id))
    console.log(`   ${ids.length} ofertas, ${nuevas.length} nuevas`)

    for (const id of nuevas) {
      if (enviadas >= max) break buscar
      vistas.add(id)
      const oferta = await li.leerOferta(pagina, id)
      console.log(`\n📄 ${oferta.puesto} · ${oferta.empresa}`)

      const salto = motivoParaSaltar(oferta, config)
      if (salto) {
        console.log(`   ⏭  ${salto}`)
        if (modo !== 'prueba') await anotar(oferta, 'omitida', salto)
        continue
      }

      // Todas se evalúan, aunque luego no se soliciten: el informe las necesita.
      oferta.evaluacion = await evaluarOferta(perfil, oferta).catch((e) => {
        console.warn(`   ⚠️  No pude evaluarla: ${e.message}`)
        return null
      })
      const puntuacion = oferta.evaluacion?.puntuacion
      if (oferta.evaluacion) console.log(`   Probabilidad ${puntuacion}/10: ${oferta.evaluacion.motivo}`)
      // Lo que decide es si tiene relación con lo que sabes, no la probabilidad:
      // una relacionada se solicita aunque tenga un 2.
      const noRelacionada = oferta.evaluacion && !oferta.evaluacion.relacionada
      const bajoMinimo = puntuacion != null && puntuacion < (config.puntuacionMinima ?? 0)
      if (noRelacionada || bajoMinimo) {
        const motivo = noRelacionada ? 'no tiene relación con lo que sabes' : `probabilidad ${puntuacion}/10, por debajo del mínimo`
        console.log(`   ⏭  ${motivo}`)
        await guardarOferta(oferta, { estado: 'omitida', motivo })
        if (modo !== 'prueba') await anotar(oferta, 'omitida', motivo)
        continue
      }

      let resultado
      if (oferta.sencilla) {
        oferta.via = 'LinkedIn'
        try {
          resultado = await solicitar(pagina, oferta, { perfil, respuestas, config })
        } catch (e) {
          await li.cerrarSolicitud(pagina).catch(() => {})
          resultado = { estado: 'error', motivo: e.message }
        }
      } else {
        oferta.via = 'web de la empresa'
        console.log('   🌐 Se solicita en la web de la empresa')
        let web
        try {
          web = await li.abrirWebExterna(pagina)
          oferta.webSolicitud = web.url()
          resultado = await solicitarEnWeb(web, oferta, { perfil, config, modo, preguntar })
        } catch (e) {
          resultado = { estado: 'error', motivo: e.message }
        } finally {
          if (web && web !== pagina) await web.close().catch(() => {})
        }
      }
      if (resultado.estado === 'parar') {
        await guardarOferta(oferta, { estado: 'sin solicitar', motivo: 'paraste antes de enviarla' })
        break buscar
      }

      const icono = { enviada: '✅', omitida: '⏭ ', error: '❌', prueba: '🧪', 'no enviada': '⏭ ', 'necesita ayuda': '✋' }[resultado.estado]
      console.log(`   ${icono} ${resultado.estado}${resultado.motivo ? `: ${resultado.motivo}` : ''}`)
      await guardarOferta(oferta, { estado: resultado.estado, motivo: resultado.motivo ?? '' })
      if (modo !== 'prueba') await anotar(oferta, resultado.estado, resultado.motivo)
      if (resultado.estado === 'enviada' || resultado.estado === 'prueba') {
        enviadas++
        await li.pausa(esperaMin * 1000, esperaMax * 1000)
      }
    }
  }

  console.log(`\nListo: ${enviadas} ${modo === 'prueba' ? 'formularios completados (sin enviar)' : 'solicitudes enviadas'}.`)
  terminal?.close()
  await cerrar()
  const informe = await generarInforme()
  if (informe) console.log(`📊 Informe de ofertas por probabilidad: ${informe}`)
}

let cerrarNavegador

// Que nunca termine en silencio: cualquier fallo no capturado se ve y se registra.
process.on('unhandledRejection', (e) => console.error(`\n❌ Error inesperado: ${e?.stack ?? e}`))
process.on('exit', (codigo) => { if (codigo) console.error(`(Linkd terminó con código ${codigo})`) })

main().catch(async (e) => {
  console.error(`\n❌ ${e.message}`)
  await cerrarNavegador?.().catch(() => {})
  terminal?.close()
  process.exit(1)
})

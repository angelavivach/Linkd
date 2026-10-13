import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { cargarPerfil } from './perfil.mjs'
import { evaluarOferta, responderCampos } from './claude.mjs'
import * as li from './linkedin.mjs'
import { ofertasVistas, anotar, guardarDetalle, cargarRespuestas } from './registro.mjs'

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
  terminal ??= createInterface({ input: process.stdin, output: process.stdout })
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
  const modal = await li.abrirSolicitud(pagina)
  const usadas = []
  let errores = []
  let reintentos = 0

  for (let paso = 0; paso < 20; paso++) {
    if ((await li.botonDisponible(modal)) === 'enviar') {
      await li.noSeguirEmpresa(modal)
      await guardarDetalle(oferta, usadas)

      if (modo === 'prueba') {
        console.log(`\n${await li.resumenRevision(modal)}\n`)
        await li.cerrarSolicitud(pagina)
        return { estado: 'prueba', motivo: 'llegó al último paso (no se envía en modo prueba)' }
      }
      if (modo === 'revisar') {
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
    if (errores.length && !pendientes.length) pendientes = campos.filter((c) => c.tipo !== 'archivo')

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
    await li.pulsarBoton(modal, siguiente)

    errores = await li.erroresVisibles(modal)
    if (errores.length) {
      console.log(`   LinkedIn se queja: ${errores.join(' · ')}`)
      if (++reintentos > 2) throw new Error(`el formulario no acepta las respuestas: ${errores.join(' · ')}`)
    } else {
      reintentos = 0
    }
  }
  throw new Error('demasiados pasos en el formulario')
}

/** Filtros baratos antes de gastar una llamada a Claude. */
function motivoParaSaltar(oferta, config) {
  if (!oferta.sencilla) return 'sin "Solicitud sencilla" (o ya solicitada)'
  const titulo = oferta.puesto.toLowerCase()
  const palabra = (config.excluirPalabrasEnTitulo ?? []).find((p) => titulo.includes(p.toLowerCase()))
  if (palabra) return `el título contiene "${palabra}"`
  const empresa = (config.excluirEmpresas ?? []).find((e) => oferta.empresa.toLowerCase().includes(e.toLowerCase()))
  if (empresa) return `empresa excluida (${empresa})`
  return null
}

async function main() {
  if (args[0] === 'login') {
    const { contexto, pagina } = await li.abrirNavegador()
    console.log('Inicia sesión en LinkedIn en la ventana que se ha abierto (tienes 5 minutos)…')
    await li.esperarLogin(pagina)
    console.log('✅ Sesión guardada en .sesion/. Ya puedes usar npm start.')
    await contexto.close()
    return
  }

  const config = await leerConfig()
  const perfil = await cargarPerfil(config)
  const respuestas = await cargarRespuestas()
  const vistas = await ofertasVistas()
  const [esperaMin, esperaMax] = config.segundosEntreOfertas ?? [20, 60]
  const max = config.maxPorEjecucion ?? 15

  console.log(`Modo: ${modo}. Máximo ${max} solicitudes en esta ejecución.`)
  const { contexto, pagina } = await li.abrirNavegador()
  process.on('SIGINT', async () => {
    await contexto.close().catch(() => {})
    process.exit(130)
  })

  if (!(await li.haySesion(pagina))) {
    if (modo === 'auto') throw new Error('No hay sesión de LinkedIn. Ejecuta antes: npm run login')
    console.log('No hay sesión de LinkedIn: inicia sesión en la ventana (tienes 5 minutos)…')
    await li.esperarLogin(pagina)
  }

  let enviadas = 0
  buscar: for (const busqueda of config.busquedas ?? []) {
    console.log(`\n🔎 ${busqueda.palabras} — ${busqueda.ubicacion ?? ''}`)
    const ids = await li.buscarOfertas(pagina, busqueda, {
      dias: config.soloUltimosDias,
      paginas: config.paginasPorBusqueda ?? 1,
    })
    const nuevas = ids.filter((id) => !vistas.has(id))
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

      if (config.puntuacionMinima > 0) {
        const { puntuacion, motivo } = await evaluarOferta(perfil, oferta)
        console.log(`   Encaje ${puntuacion}/10: ${motivo}`)
        if (puntuacion < config.puntuacionMinima) {
          if (modo !== 'prueba') await anotar(oferta, 'omitida', `encaje ${puntuacion}/10: ${motivo}`)
          continue
        }
      }

      let resultado
      try {
        resultado = await solicitar(pagina, oferta, { perfil, respuestas, config })
      } catch (e) {
        await li.cerrarSolicitud(pagina).catch(() => {})
        resultado = { estado: 'error', motivo: e.message }
      }
      if (resultado.estado === 'parar') break buscar

      const icono = { enviada: '✅', omitida: '⏭ ', error: '❌', prueba: '🧪' }[resultado.estado]
      console.log(`   ${icono} ${resultado.estado}${resultado.motivo ? `: ${resultado.motivo}` : ''}`)
      if (modo !== 'prueba') await anotar(oferta, resultado.estado, resultado.motivo)
      if (resultado.estado === 'enviada' || resultado.estado === 'prueba') {
        enviadas++
        await li.pausa(esperaMin * 1000, esperaMax * 1000)
      }
    }
  }

  console.log(`\nListo: ${enviadas} ${modo === 'prueba' ? 'formularios completados (sin enviar)' : 'solicitudes enviadas'}. Detalle en postulaciones.csv y registro/.`)
  terminal?.close()
  await contexto.close()
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`)
  terminal?.close()
  process.exit(1)
})

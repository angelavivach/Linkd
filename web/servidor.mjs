// Panel local de Linkd: `npm run panel`.
// Sirve el configurador en tu propio ordenador (solo 127.0.0.1) y añade dos
// botones que la versión web no tiene: guardar los archivos en la carpeta de
// Linkd y abrir una Terminal con el programa. Nada de esto sale de tu Mac.
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUERTO = 4321
const ORIGENES = [`127.0.0.1:${PUERTO}`, `localhost:${PUERTO}`]
const MAX = 200_000

let proceso = null
const historial = []
const clientes = new Set()

function emitir(trozo) {
  historial.push(trozo)
  if (historial.length > 4000) historial.shift()
  for (const c of clientes) c.write(`data: ${JSON.stringify(trozo)}\n\n`)
}

const responder = (res, codigo, cuerpo, tipo = 'application/json') => {
  res.writeHead(codigo, { 'content-type': tipo, 'cache-control': 'no-store' })
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo))
}

async function leerCuerpo(req) {
  let datos = ''
  for await (const trozo of req) {
    datos += trozo
    if (datos.length > MAX) throw new Error('demasiado grande')
  }
  return JSON.parse(datos)
}

// Solo acepta peticiones que vienen de esta misma página, no de otras webs.
const esLocal = (req) => ORIGENES.includes(req.headers.host) && (!req.headers.origin || ORIGENES.includes(new URL(req.headers.origin).host))

const servidor = createServer(async (req, res) => {
  if (!esLocal(req)) return responder(res, 403, { error: 'Solo desde este ordenador.' })

  if (req.method === 'GET' && req.url === '/') {
    return responder(res, 200, await readFile(join(RAIZ, 'web', 'index.html'), 'utf8'), 'text/html; charset=utf-8')
  }

  // Guarda los dos archivos en sus sitios fijos. No acepta rutas del cliente.
  if (req.method === 'POST' && req.url === '/guardar') {
    try {
      const { config, sobreMi } = await leerCuerpo(req)
      if (!config || typeof config !== 'object' || typeof sobreMi !== 'string') throw new Error('datos incorrectos')
      await writeFile(join(RAIZ, 'config.json'), JSON.stringify(config, null, 2) + '\n')
      await mkdir(join(RAIZ, 'perfil'), { recursive: true })
      await writeFile(join(RAIZ, 'perfil', 'sobre-mi.md'), sobreMi)
      return responder(res, 200, { ok: true })
    } catch (e) {
      return responder(res, 400, { error: e.message })
    }
  }

  // Ejecuta el programa dentro de este panel: su salida llega a la página y
  // sus preguntas se responden allí (por stdin).
  if (req.method === 'POST' && req.url === '/ejecutar') {
    if (proceso) return responder(res, 409, { error: 'Linkd ya está en marcha.' })
    proceso = spawn('node', ['src/index.mjs'], { cwd: RAIZ, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    emitir(`▶ Linkd arrancado (${new Date().toLocaleTimeString('es-ES')})\n`)
    proceso.stdout.on('data', (d) => emitir(d.toString()))
    proceso.stderr.on('data', (d) => emitir(d.toString()))
    proceso.on('exit', (codigo) => {
      emitir(`\n■ Linkd ha terminado${codigo ? ` (código ${codigo})` : ''}.\n`)
      proceso = null
    })
    return responder(res, 200, { ok: true })
  }

  // La salida en directo. Al conectarse, recibe lo que ya se había escrito.
  if (req.method === 'GET' && req.url === '/eventos') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    for (const trozo of historial) res.write(`data: ${JSON.stringify(trozo)}\n\n`)
    clientes.add(res)
    req.on('close', () => clientes.delete(res))
    return
  }

  // Tu respuesta a una pregunta de Linkd.
  if (req.method === 'POST' && req.url === '/responder') {
    try {
      const { texto } = await leerCuerpo(req)
      if (!proceso?.stdin.writable) return responder(res, 409, { error: 'Linkd no está esperando nada ahora mismo.' })
      proceso.stdin.write(`${texto ?? ''}\n`)
      emitir(`› ${texto ?? ''}\n`)
      return responder(res, 200, { ok: true })
    } catch (e) {
      return responder(res, 400, { error: e.message })
    }
  }

  // Para el programa como si pulsaras Ctrl+C (así guarda el informe).
  if (req.method === 'POST' && req.url === '/parar') {
    if (!proceso) return responder(res, 409, { error: 'Linkd no está en marcha.' })
    proceso.kill('SIGINT')
    return responder(res, 200, { ok: true })
  }

  responder(res, 404, { error: 'no encontrado' })
})

process.on('SIGINT', () => { proceso?.kill('SIGINT'); process.exit(0) })

servidor.listen(PUERTO, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PUERTO}/`
  console.log(`Panel de Linkd: ${url}`)
  console.log('Para cerrarlo, pulsa Ctrl+C aquí.')
  execFile('open', [url], () => {})
})

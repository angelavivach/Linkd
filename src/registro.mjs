import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises'

const CSV = 'postulaciones.csv'
const RESPUESTAS = 'respuestas.json'

const existe = (ruta) => access(ruta).then(() => true, () => false)
const celda = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

/**
 * IDs de ofertas que ya pasaron por aquí, para no repetirlas. Las que dieron
 * error, se quedaron en prueba o necesitaban ayuda no cuentan: se vuelven a
 * intentar en la siguiente ejecución.
 */
export async function ofertasVistas() {
  if (!(await existe(CSV))) return new Set()
  const filas = (await readFile(CSV, 'utf8')).split('\n').slice(1)
  const vistas = new Set()
  for (const fila of filas) {
    const [, id, , , estado] = [...fila.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1])
    if (id && !['error', 'prueba', 'necesita ayuda'].includes(estado)) vistas.add(id)
  }
  return vistas
}

/** Una línea en postulaciones.csv. estado: enviada | omitida | error | prueba */
export async function anotar(oferta, estado, motivo = '') {
  if (!(await existe(CSV))) await writeFile(CSV, 'fecha,id,empresa,puesto,estado,motivo,url\n')
  const fila = [new Date().toISOString(), oferta.id, oferta.empresa, oferta.puesto, estado, motivo, oferta.url]
  await appendFile(CSV, fila.map(celda).join(',') + '\n')
}

/**
 * registro/<id>.json: la oferta, su evaluación, el estado y lo que se respondió
 * (por si una empresa te llama). Cada llamada añade campos a lo que ya hay.
 * Es también de donde sale el informe.
 */
export async function guardarOferta(oferta, datos = {}) {
  await mkdir('registro', { recursive: true })
  const ruta = `registro/${oferta.id}.json`
  const previo = (await existe(ruta)) ? JSON.parse(await readFile(ruta, 'utf8')) : {}
  await writeFile(ruta, JSON.stringify({ ...previo, ...oferta, ...datos, fecha: new Date().toISOString() }, null, 2))
}

// ----------------------------------------------------- Respuestas sabidas --
// Preguntas que se repiten entre empresas ("¿Años de experiencia con React?",
// "¿Necesitas visado?"). Lo que confirmas tú, o Claude responde con seguridad,
// se guarda aquí y la próxima vez no hace falta preguntar. Puedes editarlo a mano.

const clave = (campo) =>
  [campo.tipo, campo.etiqueta.toLowerCase().replace(/[*?¿:]/g, '').replace(/\s+/g, ' ').trim(), ...(campo.opciones ?? [])].join(' | ')

/** Solo las respuestas cortas: una carta de motivación depende de cada oferta. */
const reutilizable = (campo, valor) => campo.tipo !== 'texto_largo' && String(valor).length <= 80

export async function cargarRespuestas() {
  const datos = (await existe(RESPUESTAS)) ? JSON.parse(await readFile(RESPUESTAS, 'utf8')) : {}
  return {
    buscar: (campo) => datos[clave(campo)],
    async guardar(campo, valor) {
      if (!reutilizable(campo, valor)) return
      datos[clave(campo)] = valor
      await writeFile(RESPUESTAS, JSON.stringify(datos, null, 2))
    },
  }
}

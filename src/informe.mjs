import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'

const SALIDA = 'informe.html'

const esc = (t) =>
  String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const ESTADOS = {
  enviada: 'Enviada',
  prueba: 'Rellenada (prueba)',
  omitida: 'No solicitada',
  'sin solicitar': 'No solicitada',
  error: 'Error al rellenar',
  'no enviada': 'No enviada (decidiste no enviarla)',
  'necesita ayuda': 'Necesita que la termines tú',
}

const GRUPOS = [
  { clave: 'alta', titulo: 'Probabilidad alta', min: 7 },
  { clave: 'media', titulo: 'Probabilidad media', min: 5 },
  { clave: 'baja', titulo: 'Probabilidad baja', min: 0 },
]
const grupoDe = (p) => GRUPOS.find((g) => p >= g.min).clave

function tarjeta(o) {
  const ev = o.evaluacion
  const dato = (etiqueta, valor) =>
    valor && valor !== 'no indicado' ? `<div><dt>${etiqueta}</dt><dd>${esc(valor)}</dd></div>` : ''
  return `
  <article class="oferta ${grupoDe(ev.puntuacion)}">
    <header>
      <div class="nota" aria-label="Probabilidad ${ev.puntuacion} de 10">${ev.puntuacion}<small>/10</small></div>
      <div class="titulo">
        <h3><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.puesto)}</a></h3>
        <p class="empresa">${esc(o.empresa)}</p>
      </div>
      <span class="estado e-${esc((o.estado ?? '').replace(/\s/g, '-'))}">${esc(ESTADOS[o.estado] ?? 'Evaluada')}</span>
    </header>
    <p class="resumen">${esc(ev.resumen)}</p>
    <dl class="datos">
      ${dato('Ubicación', o.ubicacion?.split('·')[0]?.trim())}
      ${dato('Modalidad', ev.modalidad)}
      ${dato('Salario', ev.salario)}
      ${dato('Experiencia', ev.experiencia)}
      ${dato('Se solicita en', o.via)}
    </dl>
    ${ev.tecnologias?.length ? `<ul class="tecnologias">${ev.tecnologias.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    <div class="encaje">
      ${ev.aFavor?.length ? `<div><h4>Cumples</h4><ul class="si">${ev.aFavor.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
      ${ev.enContra?.length ? `<div><h4>Te falta o no consta</h4><ul class="no">${ev.enContra.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
    </div>
    ${o.webSolicitud ? `<p class="motivo"><a href="${esc(o.webSolicitud)}" target="_blank" rel="noopener">Abrir la solicitud en su web</a></p>` : ''}
    <p class="motivo">${esc(ev.motivo)}${o.estado && o.estado !== 'enviada' && o.motivo ? ` <span>· ${esc(o.motivo)}</span>` : ''}</p>
  </article>`
}

function pagina(ofertas) {
  const cuenta = (f) => ofertas.filter(f).length
  const fecha = new Date().toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' })
  const resumen = [
    ['Ofertas evaluadas', ofertas.length],
    ['Probabilidad alta', cuenta((o) => grupoDe(o.evaluacion.puntuacion) === 'alta')],
    ['Enviadas', cuenta((o) => o.estado === 'enviada')],
    ['Rellenadas en prueba', cuenta((o) => o.estado === 'prueba')],
  ]
  const secciones = GRUPOS.map((g) => {
    const delGrupo = ofertas.filter((o) => grupoDe(o.evaluacion.puntuacion) === g.clave)
    if (!delGrupo.length) return ''
    return `<section><h2>${g.titulo} <span>${delGrupo.length}</span></h2>${delGrupo.map(tarjeta).join('')}</section>`
  }).join('')

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ofertas por probabilidad</title>
<style>
  :root {
    --fondo: #f6f5f2; --tarjeta: #ffffff; --texto: #1d1d1f; --suave: #6b6b70; --borde: #e3e1dc;
    --alta: #1f7a4d; --media: #a86a00; --baja: #8a8a8f; --si: #1f7a4d; --no: #b3261e; --chip: #efeee9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fondo: #141416; --tarjeta: #1d1d20; --texto: #ececee; --suave: #9a9aa0; --borde: #2e2e33;
      --alta: #4cc38a; --media: #e0a43a; --baja: #8a8a90; --si: #4cc38a; --no: #f2766b; --chip: #2a2a2e;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fondo); color: var(--texto); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .fecha { color: var(--suave); margin: 0 0 24px; }
  .cifras { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .cifras div { background: var(--tarjeta); border: 1px solid var(--borde); border-radius: 12px; padding: 14px 16px; }
  .cifras b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
  .cifras span { color: var(--suave); font-size: 13px; }
  h2 { font-size: 18px; margin: 32px 0 12px; }
  h2 span { color: var(--suave); font-weight: 400; }
  .oferta { background: var(--tarjeta); border: 1px solid var(--borde); border-left: 4px solid var(--baja); border-radius: 12px; padding: 18px 20px; margin-bottom: 14px; }
  .oferta.alta { border-left-color: var(--alta); }
  .oferta.media { border-left-color: var(--media); }
  .oferta header { display: flex; gap: 14px; align-items: flex-start; }
  .nota { font-size: 26px; font-weight: 700; line-height: 1; min-width: 52px; font-variant-numeric: tabular-nums; }
  .alta .nota { color: var(--alta); } .media .nota { color: var(--media); } .baja .nota { color: var(--baja); }
  .nota small { font-size: 13px; font-weight: 400; color: var(--suave); }
  .titulo { flex: 1; min-width: 0; }
  h3 { margin: 0; font-size: 17px; }
  h3 a { color: inherit; text-decoration: none; } h3 a:hover { text-decoration: underline; }
  .empresa { margin: 2px 0 0; color: var(--suave); }
  .estado { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: var(--chip); color: var(--suave); white-space: nowrap; }
  .e-enviada { background: var(--si); color: #fff; }
  .resumen { margin: 12px 0; }
  .datos { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 0 0 12px; }
  .datos dt { font-size: 12px; color: var(--suave); } .datos dd { margin: 0; }
  .tecnologias { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; padding: 0; margin: 0 0 12px; }
  .tecnologias li { background: var(--chip); border-radius: 6px; padding: 2px 8px; font-size: 13px; }
  .encaje { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  h4 { margin: 0 0 4px; font-size: 13px; color: var(--suave); font-weight: 600; }
  .encaje ul { margin: 0; padding: 0; list-style: none; }
  .encaje li { padding-left: 20px; position: relative; margin-bottom: 2px; }
  .si li::before { content: "✓"; position: absolute; left: 0; color: var(--si); }
  .no li::before { content: "✗"; position: absolute; left: 0; color: var(--no); }
  .motivo { margin: 12px 0 0; color: var(--suave); font-size: 14px; }
  @media (max-width: 520px) { .oferta header { flex-wrap: wrap; } .estado { order: -1; } }
</style>
</head>
<body>
<main>
  <h1>Ofertas por probabilidad</h1>
  <p class="fecha">Actualizado el ${esc(fecha)}. Probabilidad de pasar el primer filtro según tu CV, portfolio y sobre-mi.</p>
  <div class="cifras">${resumen.map(([t, n]) => `<div><b>${n}</b><span>${t}</span></div>`).join('')}</div>
  ${secciones}
</main>
</body>
</html>`
}

/**
 * informe.html con todas las ofertas evaluadas (de registro/), de más a menos
 * probabilidad, y lo abre. Devuelve la ruta, o null si aún no hay ninguna.
 */
export async function generarInforme({ abrir = true } = {}) {
  const archivos = (await readdir('registro').catch(() => [])).filter((f) => f.endsWith('.json'))
  const ofertas = []
  for (const f of archivos) {
    const o = JSON.parse(await readFile(`registro/${f}`, 'utf8'))
    if (o.evaluacion?.puntuacion != null) ofertas.push(o)
  }
  if (!ofertas.length) return null
  ofertas.sort((a, b) => b.evaluacion.puntuacion - a.evaluacion.puntuacion)
  await writeFile(SALIDA, pagina(ofertas))
  if (abrir && process.platform === 'darwin') execFile('open', [SALIDA])
  return resolve(SALIDA)
}

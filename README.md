# Linkd

Busca ofertas con **Solicitud sencilla** en LinkedIn, envía tu CV y responde las
preguntas de cada empresa con Claude, a partir de tu CV, tu portfolio y un
archivo con datos que el CV no tiene (salario, permiso de trabajo, preaviso…).

> ⚠️ Las condiciones de uso de LinkedIn prohíben automatizar su web. Si lo usas,
> LinkedIn puede limitar o suspender tu cuenta. Por eso Linkd va despacio, tiene
> un máximo de solicitudes por ejecución y, por defecto, te pide confirmación
> antes de enviar cada una. Úsalo con moderación.

## Qué hace

1. Abre un navegador con tu sesión de LinkedIn. Inicias sesión tú, a mano, una
   sola vez: tu contraseña nunca pasa por el programa.
2. Hace las búsquedas de `config.json`, solo con ofertas de **Solicitud sencilla**.
3. Salta las ofertas que ya vio, las de empresas o títulos excluidos y las que
   Claude puntúa por debajo de `puntuacionMinima` (de 0 a 10) frente a tu perfil.
4. Rellena el formulario paso a paso:
   - sube tu CV si no hay uno elegido;
   - las preguntas que ya respondiste antes salen de `respuestas.json`;
   - el resto las responde Claude. **No se inventa nada**: si un dato no está en
     tu perfil, te lo pregunta en la terminal (y lo recuerda para la próxima vez);
   - si LinkedIn rechaza una respuesta («introduce un número»), la corrige.
5. Desmarca «Seguir a la empresa», te enseña las respuestas y pregunta
   `¿Enviar? [s]í / [n]o / [p]arar`.
6. Lo apunta todo en `postulaciones.csv`, y lo que respondió en cada oferta en
   `registro/<id>.json` por si luego te llama la empresa.

## Puesta en marcha

Necesitas Node 22 o superior y una clave de la API de Claude.

```bash
npm install
```

```bash
npm run setup
```

1. Copia `.env.example` como `.env` y pon tu `ANTHROPIC_API_KEY`.
2. Copia `config.example.json` como `config.json` y cambia las búsquedas.
3. Pon tu CV en `perfil/cv.pdf` (PDF con texto, no escaneado).
4. Copia `perfil/sobre-mi.example.md` como `perfil/sobre-mi.md` y rellénalo.
   Cuanto más completo, menos te preguntará.
5. Inicia sesión en LinkedIn una vez:

```bash
npm run login
```

## Uso

Primero haz una prueba: rellena formularios hasta el último paso, te enseña el
resultado y **no envía nada**.

```bash
npm run prueba
```

Modo normal: te pregunta lo que no sabe y confirmas cada envío.

```bash
npm start
```

Modo automático: envía sin preguntar. Si falta algún dato, salta la oferta y
apunta en `postulaciones.csv` qué faltaba, para que lo añadas a `sobre-mi.md`.

```bash
npm run auto
```

## Configuración (`config.json`)

| Clave | Qué es |
| --- | --- |
| `cv` | Ruta al PDF del CV |
| `sobreMi` | Ruta a tus datos extra |
| `portfolio` | URL de tu portfolio. Se descarga una vez en `perfil/.portfolio.txt`; bórralo si lo actualizas |
| `busquedas` | Lista de `{ "palabras", "ubicacion" }` |
| `soloUltimosDias` | Solo ofertas publicadas en los últimos N días |
| `paginasPorBusqueda` | Páginas de 25 resultados por búsqueda |
| `maxPorEjecucion` | Solicitudes como máximo en cada ejecución |
| `puntuacionMinima` | Encaje mínimo (0–10) para solicitar. `0` = no evaluar |
| `excluirEmpresas` | Empresas que no quieres |
| `excluirPalabrasEnTitulo` | p. ej. `"senior"` |
| `segundosEntreOfertas` | Pausa aleatoria entre solicitudes, `[mín, máx]` |

## Archivos que genera (no se suben a GitHub)

- `.sesion/`: las cookies de tu sesión de LinkedIn. Quien tenga esta carpeta entra en tu cuenta.
- `postulaciones.csv`: una línea por oferta (enviada, omitida o error). Borra una línea para que vuelva a intentarla.
- `respuestas.json`: respuestas cortas reutilizables. Puedes editarlas a mano.
- `registro/`: lo respondido en cada oferta.

## Limitaciones

- Solo funciona con **Solicitud sencilla**. Las ofertas que llevan a la web de la empresa se saltan.
- LinkedIn cambia su web a menudo. Si deja de encontrar botones o campos, hay que
  ajustar los selectores de `src/linkedin.mjs`.
- Si LinkedIn te pide un captcha o una verificación, resuélvela tú en la ventana.

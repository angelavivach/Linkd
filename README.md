# Linkd

Busca ofertas en LinkedIn y las solicita: las de **Solicitud sencilla** dentro de
LinkedIn, y las que llevan a la **web de la empresa** también allí (creando cuenta
si hace falta). Envía tu CV y responde las preguntas de cada empresa con Claude, a partir de tu CV, tu portfolio y un
archivo con datos que el CV no tiene (salario, permiso de trabajo, preaviso…).

> ⚠️ Las condiciones de uso de LinkedIn prohíben automatizar su web. Si lo usas,
> LinkedIn puede limitar o suspender tu cuenta. Por eso Linkd va despacio, tiene
> un máximo de solicitudes por ejecución y, por defecto, te pide confirmación
> antes de enviar cada una. Úsalo con moderación.

## Qué hace

1. Abre un navegador con tu sesión de LinkedIn. Inicias sesión tú, a mano, una
   sola vez: tu contraseña nunca pasa por el programa.
2. Hace las búsquedas de `config.json`.
3. Claude lee tu CV, tu perfil de LinkedIn y tu portfolio, puntúa cada oferta de
   0 a 10 según la probabilidad de que pases el primer filtro y extrae sus
   características. **Solicita todas las que tienen relación con lo que sabes**,
   aunque la probabilidad sea baja; salta las de otro campo, las que ya vio y las
   de empresas o títulos excluidos. Tu perfil de LinkedIn se guarda en
   `perfil/.linkedin.txt` (bórralo para que lo vuelva a leer).
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
7. Al terminar abre **`informe.html`**: todas las ofertas evaluadas, de más a
   menos probabilidad, con modalidad, salario, experiencia que piden,
   tecnologías, qué cumples, qué te falta y si se envió. Para regenerarlo sin
   buscar nada: `npm run informe`.

### Ofertas que se solicitan en la web de la empresa

Cada web es distinta (Workday, Greenhouse, Lever, Personio…), así que ahí trabaja
un agente de Claude: mira la página, rellena, sube el CV y pulsa, con un juego de
herramientas limitado a ese navegador.

- **Cuenta:** si la web la pide, se registra con el `email` de `config.json` y una
  contraseña distinta y segura para cada web, que se guarda en el **Llavero de
  macOS** como «Linkd · nombre-de-la-web». Claude nunca ve la contraseña: el
  programa la escribe directamente. Las webs donde se creó cuenta quedan en
  `cuentas.json`.
- **Captchas, verificar el email, códigos:** los haces tú. El agente se para y te
  avisa en la terminal; pulsas Enter cuando acabes.
- **Consentimientos:** acepta solo la política de privacidad necesaria para la
  candidatura; nunca boletines ni marketing.
- **Antes de crear una cuenta y antes de enviar** te pregunta (modo normal). En
  modo prueba no crea cuentas ni envía. En modo automático lo hace solo, y si
  aparece un captcha o falta un dato, deja la oferta como «necesita ayuda» y
  sigue con la siguiente.
- El texto de las webs se trata como información, no como órdenes: si una página
  intenta que haga otra cosa, se para y te avisa.

## Puesta en marcha

Necesitas Node 22 o superior y **Claude Code con tu sesión iniciada** en este Mac
(como Odín). No hace falta clave de API ni pagar nada aparte: lo que use Linkd
cuenta dentro de tu suscripción de Claude. Si nunca has entrado en Claude Code,
ejecuta `claude` en una terminal una vez e inicia sesión.

```bash
npm install
```

```bash
npm run setup
```

1. Copia `config.example.json` como `config.json` y cambia las búsquedas.
2. Pon tu CV en `perfil/cv.pdf` (PDF con texto, no escaneado).
3. Copia `perfil/sobre-mi.example.md` como `perfil/sobre-mi.md` y rellénalo.
   Cuanto más completo, menos te preguntará.
4. Inicia sesión en LinkedIn una vez:

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
| `navegador` | `brave`, `chrome` o `chromium` |
| `email` | Tu email, para crear cuentas en las webs de las empresas |
| `webEmpresa` | `true`: solicita también en la web de la empresa. `false`: solo Solicitud sencilla |
| `cv` | Ruta al PDF del CV |
| `sobreMi` | Ruta a tus datos extra |
| `portfolio` | URL de tu portfolio. Se descarga una vez en `perfil/.portfolio.txt`; bórralo si lo actualizas |
| `objetivo` | El tipo de puesto que buscas. Lo que no tenga que ver puntúa como máximo 2 |
| `busquedas` | `"auto"`: las propone Claude a partir de tu perfil (se guardan en `perfil/.busquedas.json`; bórralo para que proponga otras). O una lista de `{ "palabras", "ubicacion" }` |
| `ubicacion` | Dónde buscar con `"busquedas": "auto"` |
| `nivelExperiencia` | Niveles de LinkedIn: `1` prácticas, `2` sin experiencia, `3` junior, `4` intermedio-senior |
| `orden` | `relevancia` o `fecha` |
| `soloUltimosDias` | Solo ofertas publicadas en los últimos N días |
| `paginasPorBusqueda` | Páginas de 25 resultados por búsqueda |
| `maxPorEjecucion` | Solicitudes como máximo en cada ejecución |
| `confirmarEnvio` | `false`: envía (y crea cuentas) sin preguntar s/n. Te sigue preguntando los datos que no estén en tu perfil |
| `puntuacionMinima` | Probabilidad mínima (0–10) además de que esté relacionada. Por defecto `2`: solo descarta las imposibles (1/10). `0` = todas las relacionadas |
| `excluirEmpresas` | Empresas que no quieres |
| `excluirPalabrasEnTitulo` | p. ej. `"senior"` |
| `segundosEntreOfertas` | Pausa aleatoria entre solicitudes, `[mín, máx]` |

## Modelo

Usa Claude Opus 5.5. Para otro, arranca con `LINKD_MODEL=claude-sonnet-5-5 npm start`.

## Archivos que genera (no se suben a GitHub)

- `.sesion/`: las cookies de tu sesión de LinkedIn. Quien tenga esta carpeta entra en tu cuenta.
- `postulaciones.csv`: una línea por oferta (enviada, omitida o error). Borra una línea para que vuelva a intentarla.
- `respuestas.json`: respuestas cortas reutilizables. Puedes editarlas a mano.
- `registro/`: la evaluación y lo respondido en cada oferta.
- `informe.html`: el informe de ofertas por probabilidad.
- `cuentas.json`: webs donde se creó cuenta y con qué email. Las contraseñas están en el Llavero (app «Acceso a Llaveros» o «Contraseñas», busca «Linkd»).

## Limitaciones

- En la web de la empresa cada solicitud lleva varios minutos y bastantes mensajes de Claude (cuenta en tu suscripción).
- LinkedIn cambia su web a menudo. Si deja de encontrar botones o campos, hay que
  ajustar los selectores de `src/linkedin.mjs`.
- Si LinkedIn te pide un captcha o una verificación, resuélvela tú en la ventana.

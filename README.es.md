<div align="center">

# looperators

[English](./README.md) | [中文](./README.zh-CN.md) | **Español**

### *Design the loop, not every prompt.*

**looperators pone tus agentes de código con IA sobre un canvas<br/>y los conecta en loops que corren solos.**

[![Release](https://img.shields.io/github/v/release/ObservedObserver/looperators?color=0A84FF&label=release)](https://github.com/ObservedObserver/looperators/releases/latest)
[![License](https://img.shields.io/github/license/ObservedObserver/looperators?color=8A2BE2)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-111111?logo=apple)
![Agents](https://img.shields.io/badge/agents-Claude%20Code%20·%20Codex%20·%20Grok%20Build-2ea44f)
![Status](https://img.shields.io/badge/status-alpha-orange)

[![Descargar para macOS](https://img.shields.io/badge/⬇_Descargar_para_macOS-Apple_Silicon-0A84FF?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ObservedObserver/looperators/releases/latest)
[![Primeros pasos](https://img.shields.io/badge/Primeros_pasos-3_pasos-30363D?style=for-the-badge)](#primeros-pasos)

</div>

Al apuntar la IA a una tarea de programación compleja, muchos acabamos usando
varios agentes a la vez: distintos modelos que redactan soluciones y las
debaten, o un Agent que escribe código mientras otro le hace Code Review,
ronda tras ronda. Pero cada Agent vive en su propia ventana, y quien acarrea
los mensajes entre ellos eres tú—pegar la salida de A en B, llevar el feedback
de B de vuelta a A, en cada ronda. Cuantos más Agents y más rondas, más te
conviertes en un middleware de copiar y pegar.

Ese papel de middleware son en realidad tres trabajos: mover contexto entre
Agents, disparar al Agent correcto en el momento correcto y decidir cuándo
termina el loop. looperators le entrega los tres al grafo. Los Agents se
colocan sobre un canvas, conectados por aristas—y las aristas no son un diagrama: se ejecutan.
Cuando un Agent termina, su salida viaja por la arista hasta el siguiente; la
conclusión del de abajo vuelve río arriba y despierta al Agent original para
que siga. Quién dispara a quién, qué contexto viaja y cuándo parar se define
en la arista. Dejas de hacer de mensajero; solo defines una vez las relaciones
y la condición de parada.

Y ese grafo no se monta a mano—**looperators no es una herramienta low-code.**
Habla con tus Agents como siempre; cuando en la conversación toma forma un
loop, el grafo correspondiente aparece en el canvas automáticamente, listo
para editar. Quien quiera diseñar loops directamente también puede hacerlo en
conversación normal—sin arrastrar cajas ni cables.

<img width="3202" height="1518" alt="looperators-2" src="https://github.com/user-attachments/assets/cf02610e-0c44-4a1b-91cf-cb23a1a9d2b8" />

Un patrón favorito: lanza el mismo problema a varios modelos a la vez—Codex,
Claude Code y Grok Build redactan cada uno una solución, se leen y se desafían
entre sí, y revisan hasta que la discusión converge en un consenso. Nadie
acarrea borradores; el grafo conduce cada ronda.

Code Review es otro anillo listo para usar: conecta un coder y un reviewer con
una condición de parada—"hasta que el review esté limpio, máximo 6 vueltas".
El trabajo terminado va a review automáticamente, los blocking issues vuelven
automáticamente, y una insignia sobre el anillo muestra la vuelta actual.
Cualquier Agent del grafo es una sesión real que puedes abrir en plena
ejecución como un chat normal: dile al reviewer "ignora el estilo, solo
lógica" y el loop sigue corriendo.

Eso es lo que significa **loop-native**—la apuesta sobre la que está construido
todo este workspace: las sesiones nacen dentro de relaciones, y los loops son
la lengua materna del sistema, no un parche montado sobre chats aislados.
Diseña el loop una vez; el canvas lo mantiene visible, acotado y bajo tu
control.

## Los Agents no deberían ser islas

La mayoría de las herramientas de code agents trata cada sesión como una isla,
contigo como ferry entre ellas. En looperators, las sesiones viven en
relaciones: pueden despertarse unas a otras, intercambiar contexto, revisarse
mutuamente, devolver trabajo río arriba y continuar hasta que se cumpla una
condición de parada real.

Dos preguntas dan forma al producto:

> Cuando te alejas, ¿el workflow sigue avanzando?
>
> Cuando vuelves, ¿puedes entender rápido qué pasó y por qué?

## No es otro workflow builder

Las herramientas de workflow tradicionales te piden montar el pipeline a mano
antes de poder empezar. looperators parte del resultado.

Elige un loop listo para usar o descríbele el objetivo a un Master Agent. El
sistema puede proponer los participantes, las relaciones, los permisos y las
condiciones de parada. Revisas la propuesta, la apruebas y usas el grafo para
entender o ajustar el workflow—no para dibujar cada paso desde cero.

| Workflow builder tradicional               | looperators                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Parte de un canvas vacío                   | Parte de un objetivo o de un loop listo para usar                        |
| Los nodos son actions sin estado           | Los nodos son sesiones de Agent de larga vida                            |
| Las aristas solo mueven datos hacia delante| Las relaciones llevan contexto, reviews, evidencia, reintentos y triggers|
| Optimizado para un DAG y su happy path     | Rechazo, reparación, devolución y verificación repetida son nativos      |
| El grafo describe un pipeline planificado  | El grafo sigue vivo mientras los Agents trabajan                         |

A diferencia de los sistemas que llaman a un modelo como un paso desechable,
cada nodo de looperators sigue siendo una sesión real. Ábrela como un chat
normal, inspecciona sus mensajes y su actividad de herramientas, interviene,
congela activaciones futuras o reanúdala (resume) con su historial intacto.

## El grafo define el loop; los prompts definen el trabajo

looperators no necesita una action integrada para cada tarea que un Agent pueda
realizar.

Code Review, testing, investigación, migraciones, triaje de issues, resúmenes y
análisis de seguridad se pueden expresar con prompts. El grafo aporta la
semántica de control reutilizable a su alrededor:

- qué evento dispara la siguiente sesión;
- qué contexto viaja con el handoff;
- si una transición es automática o requiere juicio;
- qué pasa cuando llega trabajo nuevo mientras un Agent está ocupado;
- qué resultado, objetivo, plazo o límite detiene el loop;
- qué relaciones siguen activas para eventos futuros.

"Review until clean" es, por tanto, un loop útil, no una frontera de lo que
looperators puede hacer. Cambia los prompts y la misma forma se convierte en
una auditoría de seguridad, un ciclo test-and-fix, un verificador de
migraciones o un workflow de validación.

## Loops que puedes construir

### Review until clean

Un Agent implementa un cambio. Otro lo revisa y devuelve los blocking issues.
Los hallazgos reactivan la sesión original, que repara el trabajo y lo envía a
otra pasada.

<img width="3840" height="1986" alt="looperators-review" src="https://github.com/user-attachments/assets/3af4c02e-aa7b-435c-b2e9-98997bae88d8" />

El loop solo se detiene cuando el Reviewer reporta clean o se alcanza una
barrera configurada. Cada vuelta, cada verdict y cada camino de retorno queda
visible.

### Planificación y debate multi-modelo

Ejecuta varios Agents o modelos como planificadores independientes, deja que se
lean y se desafíen entre sí, y sintetiza después el resultado más sólido.

<img width="3140" height="1532" alt="looperators-discuss2" src="https://github.com/user-attachments/assets/a1bb358a-0e07-486e-8d9b-350aa57ec29a" />

El **Plan Council** integrado conserva las propuestas, los desacuerdos, las
revisiones cruzadas y la ruta hasta la decisión final—no solo la respuesta
final. Los workflows de deliberación más complejos pueden seguir intercambiando
feedback hasta cumplir una regla de consenso o un límite de rondas.

### Dividir, verificar y reparar

Da a cada sesión una responsabilidad distinta: investigar, implementar,
revisar, testear y verificar. Las ramas independientes pueden trabajar en
paralelo y reunirse cuando estén listos todos los resultados, cualquiera de
ellos o un quórum.

Un verificador que falla puede enrutar su evidencia de vuelta a la sesión
responsable; un verdict aprobado puede liberar la siguiente etapa. La
verificación pasa a formar parte del workflow, en lugar de ser un prompt final
que alguien tiene que acordarse de ejecutar.

### Corre hasta que el objetivo esté realmente cumplido

Describe "hecho" en una frase y empareja un Worker con un Judge independiente.
El Judge puede usar evidencia ejecutable—tests, lint, métricas, búsquedas u
otras comprobaciones—y devolver un verdict estructurado.

Una comprobación fallida devuelve la evidencia al Worker. Una comprobación
superada detiene el loop. El Worker no puede declararse terminado solo porque
haya avanzado.

### Observa y reacciona

Un loop no tiene por qué empezar con una persona enviando un mensaje. Puede
despertar con un horario, un cambio en Git, el resultado de un script, un
webhook u otro evento registrado.

Úsalo para mantenimiento recurrente, respuesta a fallos de CI, review de
cambios de código, triaje de issues o resúmenes programados. Si omites la
condición de parada, la relación queda lista para el siguiente evento.

## Cómo funciona

### Sesiones de larga vida

Cada participante es una sesión real de code agent con su propio historial,
contexto, modelo, herramientas y estado del workspace. En cada vuelta, el loop
reanuda la sesión que ya conoce el trabajo, en lugar de recrear un Agent
desechable en cada paso.

### Relaciones ejecutables

Las relaciones definen quién reacciona a quién, qué despierta a la siguiente
sesión, qué contexto viaja, si hace falta aprobación y cuándo el trabajo vuelve
río arriba o se detiene. Son reglas duraderas, no líneas dibujadas después de
la ejecución.

### Creación outcome-first

Empieza con **Review until clean**, **Run until goal**, **Handoff** o **Plan
Council**, o descríbele un objetivo más complejo a un Master Agent. El Master
actúa como un compilador de intenciones: propone los participantes, las
relaciones, la política de seguridad y los cambios en el grafo, sin arrancar
trabajo en silencio.

Puedes revisar y bloquear la propuesta antes de aprobarla. Con un workflow
estable en marcha, el Master solo despierta para juicios, excepciones o
replanificación; no se sienta en medio de cada transición mecánica.

### Un grafo vivo con timeline

El grafo reúne tres vistas del mismo trabajo:

- **Intención:** las relaciones que dicen qué debería pasar a continuación.
- **Actividad:** los turnos, handoffs, triggers, verdicts y fallos que ya
  ocurrieron—y por qué.
- **Gobernanza:** las aprobaciones, los bloqueos, los scopes y los roles de
  Master que determinan quién puede cambiar el workflow.

Los loops aparecen como unidades legibles con su vuelta actual, estado,
condición de parada y timeline. Ve si un loop está corriendo, esperando un gate,
bloqueado, completo, congelado o detenido por una barrera, y abre la sesión o
el evento exacto que lo explica.

## Mecánica determinista, juicio agéntico

Los agent loops fiables necesitan ambas cosas.

looperators maneja las partes mecánicas de forma determinista: coincidencia de
eventos, entrega de contexto, activación, joins, reglas de parada,
comportamiento de concurrencia, persistencia, recuperación y límites de
recursos. Si llegan eventos nuevos mientras un Agent está ocupado, se pueden
fusionar (coalesce) para que procese una sola vez el estado acumulado más
reciente, en lugar de digerir una cola de trabajo intermedio obsoleto.

Los Agents manejan lo que requiere juicio: planificar, implementar, revisar,
sintetizar, diagnosticar y decidir si la evidencia satisface el objetivo.

Esa separación mantiene los loops flexibles sin pedirle a un modelo—ni a una
persona—que recuerde cómo enrutar cada turno.

## Hecho para dejarlo corriendo

La autonomía solo es útil cuando sus límites son explícitos. Según el loop,
looperators puede imponer:

- máximos de vueltas, plazos, fan-out, concurrencia y número de sesiones;
- gates de aprobación automáticos, del Master Agent o humanos;
- avisos de uso opcionales o presupuestos estrictos;
- coordinación del workspace para que escritores en paralelo no colisionen en
  silencio;
- estado del workflow, artefactos, decisiones e historial causal duraderos;
- controles de freeze, stop, retry y recuperación consistente.

El objetivo no es simplemente arrancar más Agents, sino hacer que la
colaboración de larga duración entre Agents sea **visible, acotada y lo
bastante segura como para confiar en ella**.

## Primeros pasos

looperators ofrece por ahora una build para macOS (Apple Silicon); en otras
plataformas, ejecútalo desde el código fuente.

1. **[Descarga la última release](https://github.com/ObservedObserver/looperators/releases/latest)**
   y arrastra looperators a Applications.
2. Instala y autentica al menos un code agent compatible—Claude Code, Codex o
   Grok Build.
3. Abre looperators y empieza con **New Workflow** para un loop listo para
   usar, o abre un chat de Master para describir un objetivo más complejo. El
   chat y el grafo de Agents siguen disponibles durante toda la ejecución.

Para ejecutar desde el código fuente:

```sh
npm install
npm run dev
```

## Estado del proyecto

looperators es una alpha temprana. Las interfaces, los contratos de
almacenamiento y los controles avanzados pueden evolucionar antes de una
versión estable.

La build actual incluye: chats directos con Agents, el grafo de Agents en vivo,
handoffs, loops de Review-until-clean, Goal loops, Plan Council, horarios y
triggers externos, timelines de loops, propuestas de workflow y replanificación
del Master, barriers, estado persistente, y controles de uso y concurrencia.

Reporta asperezas, instalaciones fallidas, conceptos confusos y los workflows
que te gustaría ejecutar. El feedback temprano dará forma directa al producto.

## Licencia

Con licencia [Apache License 2.0](./LICENSE).

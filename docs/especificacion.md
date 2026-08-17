# The Q Simulator — Especificación técnica completa

**Un laboratorio de circuitos cuánticos en el navegador, con cuentas, persistencia y ejecución en hardware real.**

- Versión del documento: 1.0
- Fecha: agosto 2026
- Nombre del producto: **The Q Simulator**

---

## 1. Resumen ejecutivo

The Q Simulator es una aplicación web donde cualquier persona puede construir circuitos cuánticos arrastrando compuertas sobre un lienzo, ver en tiempo real cómo evoluciona el estado del sistema, guardar y versionar sus circuitos, compartirlos públicamente, resolver retos, y —cuando quiera dar el salto— ejecutar el mismo circuito en un procesador cuántico real de IBM y comparar el resultado ideal contra el ruidoso.

El diferenciador no es "otro simulador". Es la combinación de tres cosas que normalmente están separadas:

1. **Un editor visual serio** con simulación instantánea y visualizaciones que explican, no solo decoran.
2. **Una capa social y persistente**: cuentas, versiones, galería pública, forks, colecciones. El circuito deja de ser un notebook perdido y pasa a ser un artefacto compartible con URL.
3. **Un puente al hardware real**: el mismo circuito corre en simulador ideal, en simulador con ruido, y en QPU real. Ver los tres lado a lado es la lección más valiosa de la computación cuántica actual (era NISQ).

### Por qué este proyecto

- **Como entregable de trabajo**: es una app full-stack completa (auth, DB, API, jobs asíncronos, WebSockets, integración con API externa) que además se demuestra en 30 segundos: arrastras una H y un CNOT y el entrelazamiento se ve solo.
- **Como pieza de portafolio**: combina un dominio técnico difícil (simulación cuántica) con ingeniería web sólida. Es el cruce exacto de un perfil "dev que además sabe cuántica", en lugar de competir con físicos en su terreno.
- **Como aprendizaje**: portar el motor de simulación a TypeScript obliga a entender la matemática mejor que cualquier notebook.

---

## 2. Audiencia y casos de uso

| Persona                    | Qué busca                                 | Qué le da The Q Simulator                                                       |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| **Estudiante de cuántica** | Entender qué hace realmente una compuerta | Simulación en vivo + visualizaciones + lecciones guiadas                        |
| **Desarrollador curioso**  | Probar sin instalar nada                  | Editor en el navegador, cero setup, exportar a Qiskit cuando quiera profundizar |
| **Docente**                | Material para clase                       | Circuitos públicos con URL, modo presentación, embeds                           |
| **Practicante NISQ**       | Comparar ideal vs. ruido vs. hardware     | Modo ruido y ejecución en IBM Quantum                                           |

El trabajo principal de la página de inicio: **que alguien que nunca ha visto un circuito cuántico entienda, en menos de un minuto, qué es la superposición y qué es el entrelazamiento.**

---

## 3. Alcance funcional

### 3.1 Editor de circuitos

- Lienzo con N qubits (1–20 en cliente, hasta 28 en servidor) y columnas de tiempo (_moments_).
- Paleta de compuertas arrastrables:
  - **1 qubit**: I, X, Y, Z, H, S, S†, T, T†, √X
  - **Parametrizadas**: Rx(θ), Ry(θ), Rz(θ), P(φ), U(θ, φ, λ) — con slider y campo numérico, y soporte de parámetros simbólicos (`theta`) para barridos.
  - **2 qubits**: CNOT, CZ, SWAP, iSWAP, CRz(θ), CP(φ)
  - **3 qubits**: Toffoli (CCX), Fredkin (CSWAP)
  - **Estructurales**: barrier, reset, medición (a registro clásico)
- **Controles arbitrarios**: cualquier compuerta de 1 qubit puede recibir uno o más controles (incluidos controles negativos).
- **Compuertas personalizadas / subcircuitos**: empaquetar un fragmento como bloque reutilizable con nombre e ícono. Se guardan por usuario y se pueden publicar.
- **Registro clásico** y compuertas condicionadas por bits clásicos (`if c == 1`), necesario para teletransportación.
- Undo/redo completo, copiar/pegar de fragmentos, atajos de teclado, drag para reordenar qubits.
- **Scrubber temporal**: una barra que recorre el circuito columna por columna y muestra el estado intermedio en cada punto. Esta es la función educativa más potente del editor.

**Qué es exactamente una compuerta personalizada (decidido en M2.3).** Cinco decisiones, y las cinco son visibles para quien las usa. La autoridad es `packages/schema/src/expand.ts` para la ejecución y `apps/web/src/features/circuit-editor/customGates.ts` para el editor.

1. **Se ensancha a parámetros, y solo a parámetros.** M1.1 dejó los bloques como cajas unitarias sin registro clásico, sin controles y sin parámetros propios. Los parámetros son la mitad que vale: un subcircuito que no admite un ángulo es una macro —empaquetas una QFT y necesitas una segunda copia para otra fase—, mientras que uno que sí lo admite es una compuerta en el mismo sentido que el resto del catálogo. Los nombres de `params` son **formales** y no ven los parámetros del circuito, ni aunque coincidan: es lo único que permite copiar una definición a otro documento, publicarla e instalarla sin que cambie de significado. Los controles siguen rechazados: controlar un bloque es controlar cada operación dentro de él, el kernel no tiene `iswap` controlado ni nada para un bloque anidado, y aceptar esa forma en el contrato sería aceptar algo que el motor rechaza por razones invisibles desde el punto de uso. Medir, hacer `reset` o condicionar dentro de una definición también se rechaza, con su propio código de validación: un bloque es unitario o no es un bloque.

2. **Se expande antes de simular; no se ejecuta recursivamente.** Una columna es un instante y tanto el scrubber (§3.1, decisión 1) como la caché de checkpoints (§5.6.3) están indexados por columna. Un bloque ejecutado recursivamente serían varios instantes dentro de una columna: o el scrubber no puede detenerse dentro de él —y una teleportación empaquetada se vuelve un salto ilegible, justo la lección que la función existe para mostrar— o la caché necesita una segunda coordenada y `invalidateFrom` deja de ser una comparación de enteros. Además el ruido se cobra por compuerta real (§3.3), y un bloque ejecutado como una sola operación se cobraría una vez. El precio de expandir es que las columnas del editor y las del motor dejan de ser el mismo eje, y se paga con un **mapa de columnas** en la costura que corre el circuito, en un solo archivo y en aritmética.

3. **`gateCount` y `depth` cuentan el circuito expandido.** Es un cambio respecto de M0.1, que contaba un bloque como una compuerta. La §3.6 ordena las tablas de posiciones por «menor número de compuertas, menor profundidad», así que un bloque que contara como uno haría que la jugada ganadora fuera empaquetar: cuarenta compuertas dentro, una reportada. Las cifras de la tarjeta de galería y las del reto son el número de primitivas que correría el hardware.

4. **Expandir es un límite de recursos (§11).** La detección de ciclos demuestra que el grafo de definiciones termina; no dice nada de su tamaño, porque las definiciones forman un DAG y un DAG se duplica. Veinte definiciones donde cada una usa dos veces la anterior son cuarenta operaciones de JSON y un millón de operaciones de circuito. Por eso el contrato tiene un techo de operaciones, uno de columnas y uno de anidamiento, y los aplica el propio expansor mientras emite — de modo que un documento así es un 400 del validador y no un contenedor sin memoria. `shapeOf` en `@qsim/jobs` cuenta operaciones expandidas por la misma razón.

5. **Una definición se comparte por referencia dentro de su documento, y por valor fuera de él.** Editar una definición cambia todos sus usos a la vez, sin forma de cambiar solo uno: eso es lo que hace útil un bloque frente a copiar y pegar, y es pérdida de datos para quien esperaba una copia. La decisión no se toma por el usuario, se le muestra: cada entrada del panel imprime cuántas veces se usa, el editor de definición mantiene en pantalla —no en un diálogo que ya se cerró— cuántos usos va a alterar, y «Duplicar» está al lado de «Editar definición» porque la respuesta a «quiero cambiar solo este uso» es otro bloque. Cambiar los qubits o los parámetros de una definición con usos colocados se **rechaza** en vez de repararse: no hay una conjetura honesta sobre a qué hilo iría uno nuevo. Fuera del documento no hay referencia ninguna: instalar un bloque publicado **copia** la definición al circuito, así que borrarlo, editarlo o volverlo privado no puede alcanzar el circuito de nadie más. Esa es la única lectura compatible con que una versión guardada sea inmutable (§3.4) y con que un circuito viaje dentro de una URL, donde no hay nada contra qué resolver una referencia. Lo que se pierde al copiar es la atribución, y se recupera en `CustomGate.forkedFromId`, igual que en `Circuit`.

**Cómo se comporta el scrubber (decidido en M0.8).** Cuatro decisiones, y las cuatro están escritas aquí porque las cuatro son visibles para quien lo usa (`apps/web/src/features/circuit-editor/timeline.ts` es la autoridad):

1. **Una posición es un corte, no una columna.** El motor responde «el estado una vez que corrieron todas las columnas hasta la _c_» (`stateAfterColumn`), así que lo que la barra señala es el hueco _después_ de una columna. Eso vuelve a `-1` una posición legítima —el estado antes de que corra nada, |0…0⟩— y no un caso borde: es donde arranca la reproducción, y ver la primera H convertir una barra en dos es exactamente la lección. El final del circuito, en cambio, se escribe como ausencia: no hay nada retenido, el panel corre el circuito entero igual que antes de que esta función existiera, y «el estado en la última columna» y «el estado final» quedan siendo la misma cosa escrita de una sola manera, incapaces de discrepar.

2. **Editar con el scrubber puesto no lo reinicia: lo acota.** Reiniciar al final destruiría el único bucle para el que sirve la función —pararse en la columna 3, cambiar la compuerta de la columna 3, ver cambiar el estado—, porque la propia edición que se está estudiando devolvería al lector al final. Conservar la posición sin acotarla falla cuando el circuito se acorta: en un circuito de cuatro columnas, una posición 9 nombra un corte que no existe, y el panel rotularía el estado final como «después de la columna 9». Acotar es conservar con la única corrección que el circuito más corto obliga, y se aplica **al leer**, no al escribir, así que deshacer devuelve el circuito _y_ la posición con él.

3. **La reproducción termina en el final y no da la vuelta**, porque un ciclo es un temporizador corriendo mientras la pestaña esté abierta, y el final de un circuito es un resultado y no una vuelta de pista. Con `prefers-reduced-motion` nada arranca solo: el arranque automático (que las lecciones de la Fase 3 querrán) queda rechazado de plano, mientras que pulsar «reproducir» sigue funcionando — la preferencia habla de lo que se mueve sin permiso, no de lo que se mueve cuando se lo piden.

4. **Espacio reproduce, y solo sobre la barra.** Dentro de la rejilla Espacio ya significa «levantar esta compuerta» (el arrastre por teclado de dnd-kit), y dos significados para una tecla en el mismo subárbol es como un editor termina haciendo dos cosas por pulsación. El aislamiento no es solo convención: el manejador de teclas del editor clasifica cada pulsación por su origen y deja pasar íntegro todo lo que nace dentro de un `input` (`originOf` en `useKeyboardGrid.ts`), que es también lo que mantiene las flechas de la barra fuera del cursor de la rejilla.

### 3.2 Panel de análisis (en vivo, mientras editas)

- **Histograma de probabilidades** de los estados base, con las barras coloreadas por la fase de la amplitud.
- **Tabla de amplitudes**: `|estado⟩ → a + bi`, magnitud, probabilidad, fase en radianes y grados.
- **Esferas de Bloch por qubit**, calculadas desde la matriz de densidad reducida. Detalle importante: cuando un qubit está entrelazado, su vector de Bloch se acorta (queda dentro de la esfera). Eso convierte al visualizador en un detector visual de entrelazamiento.
- **Q-sphere**: representación de todo el estado en una sola esfera, con radio proporcional a la amplitud y color por fase.
- **Métricas de entrelazamiento**: entropía de von Neumann de cada subsistema y concurrencia para pares de qubits.
- **Matriz de densidad** (modo avanzado): mapa de calor de la parte real e imaginaria.
- **Muestreo con shots**: histograma de conteos empíricos, configurable de 1 a 100,000 shots, con comparación contra la distribución teórica.

**Cuántas barras dibuja el histograma (decidido en M0.7b).** Veinte qubits son 1 048 576 estados base y ninguna pantalla los muestra. La regla que se implementa —`apps/web/src/features/analysis/histogram.ts` es la autoridad— tiene tres partes, y ninguna esconde nada en silencio:

1. Un estado sin probabilidad no es una barra. El piso es 1e-12 sobre |a|², que es residuo de Float64 y no física; es también lo que hace que un par de Bell sean exactamente dos barras y no dos barras y dos fantasmas.
2. Se dibujan como máximo **32 estados**, elegidos por probabilidad de mayor a menor. Treinta y dos es una pantalla a la altura de fila del gráfico y es además el espectro completo de un registro de cinco qubits, así que todo circuito lo bastante chico para ser un ejemplo de clase se dibuja entero y el tope solo actúa donde dibujarlo entero nunca fue posible.
3. **Lo que el tope deja fuera se dibuja igual, agregado**: una última barra con la masa de todo lo no mostrado, y una leyenda visible que dice cuántos estados son y qué fracción de la probabilidad tienen. Un histograma que se guarda la mitad de la distribución sin decirlo es una mentira dibujada.

La selección es por probabilidad, pero **el orden de dibujo es por estado base**, y esa diferencia es deliberada: la interferencia destructiva se ve como una barra que se encoge hasta desaparecer, y si las barras se reordenaran en cada movimiento del slider, el lector vería movimiento en lugar de cancelación.

**La tabla de amplitudes usa ese mismo tope, llamándolo (M0.7c).** `apps/web/src/features/analysis/amplitudes.ts` no reescribe las tres reglas: invoca `buildHistogram` y le agrega lo único que una barra no necesita, la amplitud misma. El gráfico y la tabla quedan uno debajo del otro y el lector los compara, así que una barra sin fila —o una fila sin barra— se leería como un defecto de la física en vez de como dos selecciones que no se pusieron de acuerdo. Compartir la selección las vuelve incapaces de discrepar. La tabla se ordena además por probabilidad a pedido (§3.2), y el orden por estado base sigue siendo el de entrada por la misma razón que en el histograma: una fila que conserva su dirección es una fila que se puede mirar cambiar.

**El control de shots (decidido en M0.7c).** Cuatro decisiones, todas por el mismo motivo educativo:

1. **El muestreo viaja con el estado, en un solo mensaje.** `sampleShots` corre en el worker sobre el estado que esa misma respuesta lleva (`apps/web/src/features/simulation/protocol.ts`). Pedirlo en un segundo viaje habría permitido que una edición cayera entre los dos, y el panel habría dibujado el histograma empírico de un circuito contra la distribución exacta de otro: una discrepancia idéntica al error de muestreo y que no lo es. Cien mil tiros sobre veinte qubits son un barrido de ocho megabytes y dos millones de comparaciones — en el hilo principal, una pestaña congelada.
2. **Está apagado hasta que alguien lo pide.** Una corrida analítica conoce todas las probabilidades de forma exacta, y el ruido de muestreo que nadie pidió es ruido (§5.3).
3. **El deslizador es logarítmico**: dieciséis paradas en progresión 1-2-5 por década, de 1 a 100 000. En una escala lineal todo el rango interesante —los primeros cientos de tiros, donde la muestra visiblemente discrepa— ocupa el primer medio por ciento de la barra, y la lección es justamente que el error cae como 1/√N.
4. **Una pista, dos marcas.** La barra es lo medido y la marca es donde la teoría dice que va; lo que el lector mira es la _distancia_ entre las dos, y esa distancia cerrándose. Dos barras lado a lado convertirían eso en una comparación de largos. Junto a la tabla se imprime el error típico, 1/(2√N), que es la desviación estándar de una frecuencia observada en su valor máximo (p = ½): con eso el lector puede verificar la regla en el siguiente arrastre en vez de adivinarla.

**Las esferas de Bloch (decidido en M1.6).** Cuatro decisiones, y las cuatro son visibles para quien mira el panel. La matemática vive en `packages/qsim/src/metrics.ts` (§5.5); `apps/web/src/features/analysis/bloch.ts` y `BlochScene.tsx` son la autoridad sobre lo que se dibuja.

1. **La flecha se dibuja con su longitud, nunca normalizada.** Es la decisión que no admite alternativa, porque la longitud _es_ la lectura. Una flecha de largo unitario pasara lo que pasara borraría la única cantidad que enseña el entrelazamiento, y encima afirmaría una dirección concreta para un qubit que no tiene ninguna.
2. **Un solo lienzo para toda la rejilla, no uno por qubit.** Los navegadores limitan el número de contextos WebGL vivos —Chrome alrededor de dieciséis— y matan el más viejo en silencio al crear uno nuevo, así que un registro de veinte qubits dibujaría sus últimas dieciséis esferas y dejaría las cuatro primeras en blanco. No hay tope de esferas y no hace falta: un registro tiene 2ⁿ estados base pero exactamente n qubits, de modo que lo que obligó al tope de barras del histograma aquí no existe.
3. **La tabla numérica es la representación accesible, y se ve.** El lienzo es `aria-hidden` igual que el del circuito, y los números al lado llevan el significado — pero a diferencia de la tabla del histograma esta no se esconde: una flecha en una proyección no es una longitud que nadie pueda comparar a ojo, y quien tiene baja visión sin lector de pantalla no tendría entonces ninguna representación. De ahí se sigue lo demás: como los números _son_ la representación, el dibujo puede fallar sin llevarse nada. Sin WebGL, con el contexto denegado, o perdido a mitad de sesión, el panel lo dice en una frase y conserva todos los datos. Las etiquetas de los ejes y de los polos `|0⟩`/`|1⟩` son SVG encima del lienzo y no texturas dentro de él, porque `Notation` es la única vía sancionada para la notación invariante (§1.1) y una textura no lo es.
4. **La escena gira despacio sobre el eje z, y con `prefers-reduced-motion` no gira.** Una esfera ortográfica quieta es ambigua: una flecha que se aleja del lector y otra que se le acerca se proyectan sobre la misma recta. El giro resuelve eso y no lleva información propia — a diferencia de los fasores, cuyo ángulo _era_ el dato (§10), aquí el dato es la dirección y la longitud, y un solo fotograma las dice enteras. Girar sobre z tiene además una consecuencia útil: `|0⟩` y `|1⟩` quedan clavados arriba y abajo de su esfera a cualquier azimut, así que solo las etiquetas de x e y siguen a la cámara.

### 3.3 Modo ruido

Simulación con matriz de densidad y canales de Kraus:

- Despolarizante, amplitude damping (T1), phase damping (T2), bit-flip, phase-flip.
- Error de lectura (readout error) configurable por qubit.
- Perfiles de ruido predefinidos que imitan hardware real, y perfil personalizado.
- Comparación lado a lado: distribución ideal vs. ruidosa, con métrica de fidelidad.

Límite: la matriz de densidad crece como 4ⁿ, así que este modo se topa alrededor de 10–12 qubits. Está bien: es un modo de estudio, no de escala.

### 3.4 Persistencia y colaboración

- **Cuentas** con OAuth de GitHub y Google, más email/contraseña.
- **Guardar circuitos** con título, descripción, tags y visibilidad (privado / con enlace / público).
- **Versionado**: cada guardado crea una versión inmutable. Historial navegable, diff visual entre versiones, restaurar.
- **Fork**: clonar el circuito de otra persona a tu cuenta, conservando la atribución.
- **Colecciones**: agrupar circuitos (ej. "Algoritmos de oráculo").
- **Galería pública**: explorar, buscar, filtrar por tags, ordenar por estrellas o recientes.
- **Estrellas y comentarios** en circuitos públicos.
- **Enlaces compartibles** y **embeds** (`<iframe>`) para blogs y material de clase, con opción de solo lectura.
- **Edición colaborativa en tiempo real** (entregada en la Fase 5): dos personas editando el mismo circuito, con CRDT y cursores visibles. Los seis bloques que siguen son las decisiones con las que se construyó — el relevo (M5.2), la presencia (M5.3), los comentarios anclados (M5.4), el transporte del navegador (M5.5) y dónde se monta (M5.6) — y describen lo que existe, no lo que se planea.

**Qué es exactamente un embed (decidido en la Fase 3).** Cinco decisiones, y
las cinco son de seguridad antes que de producto. La autoridad es
`apps/api/src/routes/embed.ts` para lo que se sirve y
`apps/web/src/embed/headers.ts` para cómo se sirve.

1. **Es un segundo documento, no una ruta más de la aplicación.** `embed.html`
   tiene su propio punto de entrada y su propio grafo de módulos: no alcanza el
   enrutador, ni el cliente de Supabase, ni React Query, ni dnd-kit, ni el
   almacén del documento con su historial de deshacer, ni three.js — y
   `.dependency-cruiser.cjs` rompe la compilación si alguna vez los alcanza.
   Esa frontera compra dos cosas a la vez. La primera es peso: quien incrusta
   seis circuitos en una entrada de blog no debe enviar seis copias del editor,
   y una ruta perezosa dentro de la entrada actual no habría bastado, porque el
   chunk de entrada construye la sesión y el cliente de API antes de dibujar
   nada. La segunda es que **no hay sesión que leer**: el marco corre en el
   origen de la app, así que un módulo capaz de leer la sesión enviaría el
   token de un lector desde dentro de la página de un tercero. `fetchEmbed.ts`
   tiene su propio transporte de once líneas con `credentials: 'omit'` y sin
   cabecera `Authorization` en ninguna parte.

2. **El servidor no consulta la cabecera `Authorization`.** `GET /embed/:handle`
   es `auth: 'public'` —la política que `plugins/auth.ts` define como «la
   identidad es irrelevante, y una rota también»— y no `auth: 'optional'` como
   `GET /circuits/:id`. La diferencia importa en un caso concreto: si el marco
   variara con el token de quien lo mira, la autora que previsualiza su propio
   embed vería su circuito PRIVADO renderizado y publicaría una página que
   muestra un 404 a todos los demás; y cualquier cambio posterior que hiciera
   la petición credencial publicaría el circuito mismo. La ruta necesita que la
   cabecera sea **ilegible**, no simplemente no leída, y eso solo lo garantiza
   una ruta distinta con otra política.

3. **Solo PUBLIC y UNLISTED son incrustables, y eso no es un `if`.** Es la forma
   del filtro: `findReadable(handle, null)` compone §11 dentro de la consulta,
   así que un slug alcanza PUBLIC y UNLISTED, un id alcanza solo PUBLIC, y todo
   lo demás vuelve `null` — el mismo `null` que devuelve un slug que nadie ha
   acuñado nunca. El manejador no puede distinguirlos y por lo tanto no puede
   decir cuál era: un `NOT_FOUND`, un estado, un cuerpo. Un 403 confirmaría que
   el identificador nombra algo, que es justo lo que protegen los 126 bits de
   un slug UNLISTED. La respuesta tampoco se cachea (`no-store`): retirar la
   visibilidad tiene que significar retirarla, y una caché es una copia de una
   decisión vieja.

4. **Las dos respuestas sobre el enmarcado son opuestas.** La aplicación
   ordinaria manda `X-Frame-Options: DENY` y `frame-ancestors 'none'`: sostiene
   una sesión, y `/settings` borra una cuenta con una pulsación — el perfil
   exacto del clickjacking. El embed manda `frame-ancestors *` y, sobre todo,
   **ninguna** `X-Frame-Options`: esa cabecera no tiene valor para «cualquier
   origen» y un `SAMEORIGIN` heredado de una regla demasiado amplia rompería
   todos los embeds del mundo pareciendo un endurecimiento. Por eso la regla de
   cabeceras del despliegue excluye `/embed` con un _negative lookahead_ en vez
   de sobrescribirlo después. El embed además manda `Referrer-Policy:
no-referrer` —su propia ruta _es_ el slug— y `Cross-Origin-Resource-Policy:
cross-origin`, para que una página que ya optó por COEP pueda enmarcarlo.

5. **El embed renuncia a `SharedArrayBuffer`, y por eso no manda COOP ni COEP.**
   El aislamiento de origen cruzado es una propiedad de todo el árbol de marcos:
   un documento enmarcado solo está aislado si lo está el documento de nivel
   superior, y ese pertenece al sitio de quien incrusta. Así que un embed nunca
   está aislado, mande lo que mande, y COEP solo añadiría una forma de romperse
   —cualquier subrecurso futuro sin CORP— a cambio de un beneficio que no puede
   cobrarse. Mandar ninguna de las dos tiene además la consecuencia buena: el
   marco se comporta igual abierto directamente que incrustado, así que lo que
   se prueba es lo que se sirve. Lo que corre es el **camino de transferencia**
   ya documentado en §5.6 (`encodeState`), porque `useEmbedSimulation` pregunta
   por la capacidad (`sharedMemoryAvailable()`) en lugar de suponerla. Un
   circuito por encima del techo del navegador **no** se despacha al servidor
   como haría el editor (§4): un marco anónimo en un origen arbitrario sería una
   forma de gastar el cómputo del proyecto al ritmo al que se carguen las
   páginas que lo incrustan, así que se dibuja el diagrama y se imprime el
   techo en una frase.

**El relevo de sincronización (decidido en la Fase 5, M5.2).** El canal
`circuit:<id>` de §8 vive en el mismo socket `/ws` que el progreso de las
corridas, no en uno propio: ese socket ya autentica, ya sostiene un caché de
autorización que expira, ya mide frames y ya sabe cerrarse. La autoridad es
`apps/api/src/ws/documents.ts` para el documento y `apps/api/src/ws/session.ts`
para el canal. Cuatro decisiones, y las cuatro son de seguridad o de producto
antes que de transporte.

1. **Quién escribe y quién mira son dos preguntas con una respuesta cada una.**
   Escribir es `canEditCircuit`: la dueña, y nadie más — §11 hace que la
   visibilidad no diga nada sobre el permiso de escritura, así que no existe
   ningún estado en el que una desconocida pueda mandar una actualización.
   Mirar es `findReadable`, el mismo filtro que aplica `GET /circuits/:id`, y eso
   **sí** admite a quien solo puede leer. La consecuencia se escribe aquí porque
   es real: entrar a la sesión viva de un circuito PUBLIC o UNLISTED muestra
   ediciones que su autora no ha guardado. Se acepta a propósito — la
   alternativa, que solo entre quien escribe, dejaría sin sentido los cursores
   compartidos, porque hoy un circuito tiene exactamente una escritora — y queda
   acotada por el filtro que admite: el único lector de un circuito PRIVATE es su
   dueña. El modo de solo lectura se aplica **en el servidor y en cada frame**,
   no dejando de dibujar un botón.

2. **Una actualización CRDT es binario opaco de un cliente que no se controla.**
   Se acota por tamaño (`MAX_COLLAB_UPDATE_BYTES`, 64 KiB) y por ritmo, con un
   presupuesto propio en dos dimensiones —frames y bytes— separado del general,
   porque arrastrar un deslizador son decenas de commits por segundo y cobrarlos
   contra un presupuesto dimensionado para consultas a Postgres cerraría el
   socket de quien está usando el producto. Después se **decodifica antes de
   integrarse**: `Y.decodeUpdate` revienta con basura sin tocar ningún documento,
   y esa es la diferencia entre negar una actualización y reportar un documento
   ya dañado — el del navegador es de una persona, este es de toda la sesión.
   Solo entonces se aplica, se proyecta y se valida con `validateCircuit`; una
   proyección que el contrato rechace hace que el relevo **suelte el documento**
   y pida a todos volver a entrar, en lugar de repararlo, porque un lector que
   escribe es exactamente cómo un CRDT divergiría (véase `project.ts`).

3. **El documento vivo es una fila mutable, y no una versión.** Vive en
   `CircuitSession` —una fila por circuito, el estado Yjs en `bytea`— y la
   tensión con §3.4 se resuelve diciendo que son cosas de distinta naturaleza:
   una versión es inmutable, numerada, lleva mensaje, se navega, se compara y se
   restaura, y existe porque alguien decidió que su circuito llegó a un estado
   digno de nombre; una sesión es un flujo continuo sin ese momento dentro.
   Materializarla en versiones por temporizador llenaría un historial visible de
   filas que nadie eligió y volvería «restaurar» un sinónimo de «retroceder
   cuatro segundos». Lo que la fila compra es lo único que una sesión necesita de
   una base de datos: **el documento sobrevive a que todos se vayan**. Se escribe
   con retardo (2 s de silencio, 15 s como techo) y siempre al irse el último
   par; y `appendVersion` la borra en la misma transacción que escribe la
   versión, que es lo que hace que restaurar la versión 3 no se deshaga solo.

4. **Dos réplicas.** El abanico entre instancias va por el Redis que ya existe,
   en el canal `circuit:<id>` bajo el prefijo del despliegue, con dos mensajes:
   la actualización tal como llegó, y un `sync` que cierra el único hueco que un
   abanico puro deja — una réplica que arma el documento desde la fila puede
   estar detrás de la memoria de otra, y un delta que dependa de ese hueco se
   queda en la cola de pendientes de Yjs para siempre. Lo que **no** está
   resuelto, dicho sin adornos: el pub/sub de Redis es a-lo-más-una-vez, así que
   un mensaje perdido puede dejar dos réplicas separadas hasta el siguiente
   `sync`. Hoy el servicio corre una sola réplica; si algún día corre varias en
   serio, la respuesta es enrutar los sockets de un circuito a una réplica o
   intercambiar vectores de estado periódicamente entre ellas.

**Quién está aquí y hacia dónde mira (decidido en la Fase 5, M5.3).** La
presencia es estado efímero que no forma parte del documento: el cursor, la
selección, el nombre y el color de cada par. La autoridad es
`packages/contract/src/socket.ts` para los frames,
`apps/api/src/ws/presence.ts` para el padrón de una sesión y
`apps/web/src/features/collab/` para lo que se dibuja y lo que se dice. Cinco
decisiones.

1. **El par dice dónde mira; el servidor dice quién es.** Yjs modela esto con
   la _awareness_ de `y-protocols`: un mensaje binario opaco por par, con reloj
   propio y latido. Ese modelo se conserva entero salvo la opacidad, y la razón
   es una frase de §11 — **la presencia lleva identidad**. Un blob que compone
   el cliente significa que el nombre que llega a todos los demás navegadores es
   el que el emisor haya puesto: su propio correo, el nombre de otra persona, un
   kilobyte de marcado; y un relevo que no puede leer el campo no puede
   rechazarlo. Así que el frame es tipado: el cliente manda una _posición_
   (celda, selección y una cuenta de sus propias ediciones) y el relevo le
   compone encima `name` y `access` a partir de la identidad que ese socket
   probó. `name` es `displayName ?? username` —ambos ya públicos— y
   `User.email` no tiene ningún camino hasta este frame, porque la proyección
   que lo resuelve (`publicUserSelect`) ni siquiera selecciona la columna.
   Decodificar el blob para reescribir un campo habría significado mantener el
   parser de un segundo formato de cable en el camino caliente, que es el mismo
   argumento por el que M5.2 no adoptó `y-protocols`.

   **`y-protocols` no es una dependencia de este proyecto, y es a propósito.**
   No aparece en ningún `package.json`; lo único que se usa de Yjs es `yjs`
   mismo, en `packages/collab`, `apps/web` y `apps/api`. Sus dos aportaciones
   son el protocolo de sincronización (`y-protocols/sync`) y la _awareness_, y
   ninguna de las dos encaja aquí. El de sincronización supone un canal binario
   propio con su propio saludo; este proyecto ya tiene un socket tipado que
   autentica, autoriza, mide frames y sabe cerrarse (§8), y meter un segundo
   protocolo dentro de él habría significado dos vocabularios de cable en una
   conexión y una autorización que no puede leer uno de ellos. La _awareness_ es
   el blob opaco que el párrafo anterior rechaza: §11 exige que la identidad la
   componga el servidor. Lo que sí se conserva de `y-protocols` son sus
   **números** —el plazo de 30 s— y su forma de pensar el problema: un vector de
   estado en `collab:join`, la diferencia de vuelta, y una concesión con latido
   para la presencia. Tomamos el diseño y no el paquete.

2. **Un cursor caduca; no espera a que lo recojan.** La desconexión no es un
   evento que nada garantice: una tapa que se cierra, una pestaña que muere, un
   teléfono que cambia de red — ninguno manda frame de cierre, y la capa de
   socket solo lo nota en su propio ciclo de ping, hasta un minuto después. Un
   cursor que se queda un minuto no es un cursor degradado, es una afirmación
   falsa sobre dónde está una persona. Así que la presencia es una **concesión
   con plazo**: cada par la reafirma cada `PRESENCE_HEARTBEAT_MS` (10 s) y se
   descarta lo que no se reafirmó en `PRESENCE_TIMEOUT_MS` (30 s, el mismo
   número que usa `y-protocols`). El plazo se aplica en **los dos extremos y
   ninguno depende del otro**: el relevo caduca al fantasma para no entregárselo
   a quien entra, y cada cliente caduca al fantasma cuyo _servidor_ se fue. La
   caducidad del relevo es perezosa —ocurre cuando alguien publica y cuando
   alguien pide el padrón— porque un temporizador por documento son sesenta y
   cuatro temporizadores calculando algo que nadie preguntó.

3. **Quien solo lee puede ser visto, y eso no debilita el modo de solo
   lectura.** La presencia no escribe nada: ni documento, ni fila, ni nada que
   sobreviva a la conexión. Un espectador invisible dejaría los cursores
   compartidos de §3.4 como una función que solo aprovecha quien ya es la única
   escritora del circuito. Lo que sí se aplica es el enganche: a un par al que
   se le retira el permiso de lectura se le deja de relevar —y de contar dónde
   está nadie— dentro de `AUTHORISATION_TTL_MS`. El camino de entrega es
   deliberadamente distinto al de una actualización: una actualización **nunca
   puede descartarse** (un documento es la fusión de todas), y una presencia
   **nunca puede encolarse** (la siguiente la reemplaza). Así que la presencia
   se manda al instante o se descarta, y lo que sustituye a la re-verificación
   por entrega es una prueba de _vejez_ sobre la decisión en caché.

4. **Un color de colaborador no sale de la rueda de fase.** §10 dice que la fase
   _es_ color, y todo lo demás que ha necesitado color en esta aplicación ha
   tomado prestada esa rueda (los cuatro estados del diff, las dos direcciones
   del ruido) porque vive en vistas donde no se dibuja ninguna fase. Un cursor
   no: se dibuja **sobre el lienzo, al lado del histograma**, y un caret en
   `hsl(200, 85%, 66%)` no es «un color parecido» al de una amplitud, es el
   color de la amplitud de fase 3.5 rad, junto a ella, significando otra cosa.
   La separación va por los dos ejes que la rueda no usa: saturación 55 % y
   luminosidad 78 % contra 85 % y 66 %, es decir pálido y claro donde un dato es
   vivo y medio, como un lápiz frente a tinta impresa. Los ocho matices están a
   45° y arrancan en 27.5°, desplazamiento **derivado** —es el que maximiza la
   distancia al matiz más cercano que ya significa algo, y da 17.5°— y
   `apps/web/src/lib/collab-colour.test.ts` lo vuelve a derivar en cada corrida.
   Cada matiz mide al menos 7.18:1 sobre las tres superficies, más del doble de
   lo que se le exige a la rueda de fase, y a propósito: una marca de presencia
   es un contorno de un píxel y no una barra de decenas. El tercer separador no
   es un color: **el color de un colaborador nunca rellena una forma**, dibuja
   contorno, caret y etiqueta, y la etiqueta lleva siempre el nombre — ocho
   colores no pueden distinguir dieciséis pares, y no son ellos los que
   distinguen. El color lo deriva el cliente del `peerId` con un hash, así que
   todos coinciden en quién es azul y el color de nadie cambia cuando otro se va.

5. **«Ana está editando la columna 4» llega a quien no puede verlo, y sin
   parlotear.** El lienzo es `aria-hidden` y va emparejado con una rejilla ARIA
   descrita; la capa de cursores encima es más de los mismos píxeles, así que
   también es `aria-hidden`. La presencia llega entonces por **dos superficies
   con distinta cortesía**: una **lista** que se lee cuando se quiere (cada par
   con su nombre, si edita o mira, y en qué qubit y columna está), y una región
   `role="status"` reservada a las tres cosas por las que vale interrumpir a
   alguien — **llegadas, salidas y ediciones**. Nunca movimiento: una región que
   anunciara cada desplazamiento del cursor sería inservible, y un lector de
   pantalla que no se calla es un lector de pantalla que se apaga. Como una
   actualización CRDT no lleva autor, la edición se detecta con la cuenta que el
   propio par publica; es cosmética por construcción y el documento sigue siendo
   la única autoridad sobre lo que contiene. La región se monta desde el primer
   render, vacía: una región viva insertada junto con su primer contenido a
   menudo no se anuncia. Y el rendimiento se resuelve con la misma decisión que
   la accesibilidad: la capa se suscribe sola a su almacén, así que un cursor que
   se mueve ocho veces por segundo redibuja una capa posicionada y no las dos mil
   celdas de la rejilla, en la pestaña de quien está escribiendo.

   Tres detalles de esa región se corrigieron después de medirla con un lector
   real, y los tres son la diferencia entre «está implementada» y «sirve»:

   - **Un gesto es una edición, y lo dice quien lo hace.** Arrastrar un
     deslizador son decenas de commits, así que la cuenta crecía decenas de
     veces y el receptor no podía distinguir eso de alguien colocando ocho
     compuertas. Intentarlo por ritmo —un tope de dos segundos por par— falló en
     las dos direcciones a la vez: un arrastre de nueve segundos repetía la misma
     frase tres o cuatro veces y seis de ocho ediciones deliberadas no se
     anunciaban nunca. Quien arrastra **sí** sabe que es un gesto, porque el
     almacén ya lo agrupa para deshacer, así que la cuenta sube **una vez por
     gesto** y el receptor anuncia cuando el crecimiento llega tras una pausa de
     al menos `2 × PRESENCE_THROTTLE_MS`. Un arrastre de cualquier longitud es
     una frase; dos ediciones separadas por un segundo son dos.
   - **Dos personas que se van a la vez se anuncian las dos.** La salida
     ordenada del relevo son dos frames `collab:presence` con `state: null`, uno
     por par, en macrotareas distintas — medidos a 1 ms y 17 ms de distancia. Una
     región `role="status"` es atómica, así que dos mutaciones dentro del mismo
     turno del lector se leen **una vez**, con el contenido final: se perdía una
     de las dos salidas. Las frases se **retienen** un segundo en lugar de
     reemplazarse, de modo que lo que se produjo junto se lee junto.
   - **Dos personas con el mismo nombre se distinguen sin color.** Un
     `displayName` no es único, y una persona en dos pestañas produce dos pares
     con el mismo. La fila era nombre + acceso + lugar, y lo único que separaba a
     los dos era el matiz de una muestra que —correctamente— es `aria-hidden`.
     Un nombre que comparten varios pares se numera, en la lista y en cada frase
     de la región.

**Un comentario anclado a una compuerta (decidido en la Fase 5, M5.4).** Un
comentario dice algo sobre «la `H` de q0 en la columna 3», y un ancla **sobrevive
a lo que señala**. La autoridad es `packages/contract/src/comments.ts` para el
ancla y el hilo, `packages/db/src/comments.ts` para las consultas,
`apps/api/src/routes/comments.ts` para quién puede qué y
`apps/web/src/features/comments/` para lo que se dibuja y lo que se dice. Seis
decisiones.

1. **El ancla es `operations[].id`, y ninguna otra cosa es admisible.** Lo obvio
   es guardar la coordenada, y está mal de una forma **peor que perder el
   comentario**: se inserta una columna antes y el ancla pasa a señalar lo que se
   movió a esa celda. Nada falla, nada queda vacío — simplemente se le muestra a
   quien lee la frase de un desconocido sobre la compuerta que tiene delante,
   atribuida a alguien que nunca la dijo. Un comentario desaparecido es una
   molestia; un comentario que cambió de sujeto en silencio es una mentira. Así
   que el ancla es el id que §6 ya le da a cada operación, y lo que lo vuelve
   seguro y no solo cómodo es una propiedad del almacén del editor: `moveOperation`
   lo conserva, `addQubit`, `removeQubit` y `reorderQubits` remapean coordenadas y
   lo conservan, y **un id nunca se recicla** (`idAllocator` salta los ocupados y
   `paste` siempre acuña nuevos). Un ancla puede no resolver; no puede resolver a
   otra compuerta. `apps/web/src/features/comments/anchors.test.ts` conduce el
   almacén real por las cinco mutaciones que §14 nombra, y afirma sobre la
   **celda** y no sobre la mera presencia — «el ancla sigue resolviendo» lo
   cumpliría también una implementación que resolviera a la compuerta equivocada.

2. **«¿Sigue ahí la compuerta?» no se responde en la base de datos.** No hay
   columna `orphaned` ni campo `orphaned` en ninguna respuesta, porque la orfandad
   no es una propiedad del comentario: es una propiedad del **par** (comentario,
   documento que se está mostrando), y los documentos difieren — la versión
   cabeza, una versión antigua, la sesión viva de M5.2 que ningún `GET` ha
   devuelto nunca, y el borrador sin guardar que solo existe en una pestaña. Un
   booleano guardado sería una afirmación sobre uno de los cuatro publicada como
   hecho sobre los cuatro. Así que el servidor manda `anchorOpId` y el cliente lo
   resuelve contra lo que dibuja, en cada render. Esa decisión es además la que
   vuelve **gratis el caso más difícil**: borrar la compuerta y pulsar deshacer la
   devuelve con el mismo id, ninguna petición se envió, ninguna fila cambió y el
   comentario se vuelve a enganchar solo. Un indicador guardado habría necesitado
   una escritura compensatoria que nadie mandaría, porque el editor no habla con
   la API en cada pulsación.

3. **A un huérfano se lo conserva, se lo muestra y se lo etiqueta.** Había tres
   respuestas y esta es la tercera. _Esconderlo_ destruye el valor de la función
   —«lo discutimos y decidimos» es lo que vale la pena guardar— y lo destruye de
   forma invisible: nadie puede ir a buscar algo que no puede notar que falta.
   _Borrarlo_ es una escritura destructiva disparada por una edición que es ella
   misma deshacible; la compuerta vuelve, la conversación no. _Conservarlo y
   decirlo_: el hilo se queda en el panel, listado contra el circuito en vez de
   fijado a una celda, con la nota de que la operación de la que hablaba ya no
   está en este documento. Es la única de las tres que sobrevive a
   borrar-y-deshacer sin costo y la única en la que a quien lee nunca se lo
   engaña. En el lienzo **no se dibuja nada** para un huérfano: no hay celda donde
   dibujarlo, y dibujarlo en una vecina es otra vez el error de la coordenada.
   Dos consecuencias parecen defectos y no lo son: explotar la llamada a una
   compuerta personalizada (`inlineOperation`) deja huérfanos sus comentarios, y
   pegar una copia de una compuerta comentada no copia sus comentarios — la
   llamada de la que se hablaba ya no existe, y una compuerta pegada es otra
   compuerta de la que nadie ha dicho nada todavía.

4. **Un hilo tiene dos niveles, y la forma es lo que lo impone.**
   `CommentThreadResponse` es una raíz más un arreglo plano de respuestas, y una
   respuesta no lleva `replies` propias: una conversación sobre una compuerta, en
   un panel lateral, no tiene uso para un cuarto nivel de sangría, y la versión
   lista-negra de esta regla («rechaza una respuesta cuyo padre tiene padre») es
   una comprobación que alguien puede olvidar. Esta forma **no puede expresar lo
   que prohíbe**, que es el mismo movimiento que hace §6 con `column`. La
   resolución pertenece a la raíz por la misma razón: es una afirmación sobre la
   conversación, no sobre una frase dentro de ella. Resolver **no es esconder** —
   un hilo resuelto lo devuelve el listado igual que uno abierto, con `resolvedAt`
   y con quién lo cerró, y las dos cuentas viajan en cada respuesta para que
   «resuelto» sea un filtro con un número encima y no un cajón donde las cosas
   desaparecen. Puede resolver quien abrió el hilo o quien es dueño del circuito,
   y quién puede qué lo **calcula el servidor** y viaja en la respuesta
   (`viewerCanResolve`, `viewerCanDelete`, `viewerCanReply`): el cliente podría
   derivarlo, pero eso sería una segunda implementación de una regla de
   autorización, y el modo de fallo de una segunda implementación es un botón que
   produce un 403 — o, peor, un botón que le falta a quien sí tenía derecho.
   Tampoco hay `PATCH`: un comentario no se edita, porque «lo discutimos y
   decidimos» deja de significar algo si lo dicho puede reescribirse después de
   que alguien respondió o resolvió sobre esa base. Los remedios son responder, o
   borrar y volver a decirlo.

5. **El cuerpo es contenido de usuario, y la lista de permitidos tiene dos
   producciones.** La respuesta habitual es un sanitizador, y un sanitizador es
   una lista negra se llame como se llame: es una promesa sobre todo lo que un
   parser de HTML llegue a aceptar. Este proyecto no hace esa promesa. El formato
   no es «markdown menos lo peligroso», es un formato con dos producciones: un
   salto de línea, que es un párrafo, y un tramo entre acentos graves, que se
   vuelve `Notation` — la misma convención de las lecciones, que a partir de este
   hito vive en `apps/web/src/lib/prose.ts` porque ya la usan tres funciones. Todo
   lo demás es un carácter: `<script>` en un comentario son palabras que se ven,
   porque React pinta una cadena como texto y **no hay `dangerouslySetInnerHTML`
   en este camino** — `CommentBody.test.tsx` lo comprueba leyendo el archivo, no
   confiando en la revisión que lo notó. Lo demás son cotas: 2 000 caracteres por
   cuerpo, 200 hilos por circuito y 100 respuestas por hilo (una fila que un
   desconocido puede escribir en cualquier circuito PUBLIC necesita techo, no solo
   ritmo), y `POST` corre con el presupuesto **estricto** del limitador, el mismo
   que `POST /circuits`. Escribir exige sesión y `findReadable`, no
   `canEditCircuit`: una actualización del documento cambia el circuito, un
   comentario es una opinión **sobre** él, y §3.4 pide comentarios en circuitos
   públicos — lo que acota la superficie es que un comentario nunca puede cambiar
   lo que el circuito computa y que su dueña puede borrar cualquiera.

6. **En la interfaz: una insignia que es decoración, y un panel que es el
   índice.** La insignia sobre la compuerta anclada va en una capa
   `aria-hidden` con `pointer-events: none` y **no es un botón**, por dos razones
   y la segunda decide: un control enfocable dentro de `aria-hidden` es un fallo
   de WCAG, y una insignia sobre la esquina de una celda que es a la vez destino
   de arrastre y asa de la compuerta volvería más difícil mover justo las
   compuertas comentadas — la función degradando el editor para los documentos
   que más la usan. Lo que llega a quien lee es el par que este proyecto ya usa
   para el lienzo: píxeles allí, **frases** en el panel. Y el panel es el índice:
   cada hilo nombra su compuerta en palabras («Sobre `H` en q0, columna 3»,
   con el símbolo y el nombre del cable marcados como notación), el filtro lleva
   las dos cuentas, y cada hilo trae un botón que **selecciona** su compuerta en
   el lienzo — sin gesto nuevo, porque la selección ya existe, ya se alcanza por
   teclado y ya es lo que el lienzo rodea. Comentar una compuerta es
   seleccionarla: el compositor dice a qué se va a anclar **antes** de escribir, y
   con más de una seleccionada vuelve al circuito, porque un comentario sobre dos
   compuertas no es representable y tomar la primera de ellas anclaría una frase a
   una compuerta que nadie eligió. La **notificación queda fuera de alcance a
   propósito**: §14 no la pide y no sale gratis de nada de esto —necesita un
   medio de entrega que este proyecto no tiene, una preferencia para apagarla y un
   resumen para que un hilo activo no sean treinta mensajes—, y lo que sí sale
   gratis es la cuenta, que está en el filtro.

**El navegador entra al canal, y donde se monta eso es la función (decidido en
la Fase 5, M5.5 y M5.6).** Los tres bloques anteriores describen un relevo real,
una presencia real y unos comentarios reales — y durante un commit entero **nada
del producto abrió el canal**. `bridgeCircuitDocument` solo lo importaban los
ayudantes de verificación, `createSharedUndo` nadie, y ninguna ruta mandaba ni
recibía un frame `collab:*`: ninguna acción de ninguna persona podía escribir una
fila `CircuitSession`. Todas las suites estaban verdes, porque cada una conducía
su propia capa directamente. Es la misma forma del defecto de la Fase 1, donde
`useSimulation` no tenía importador y el editor no simulaba nada. La autoridad de
esta mitad es `apps/web/src/features/collab/collabSession.ts` para el transporte,
`useCollabSession.ts` para su vida útil y `apps/web/src/routes/editor.tsx` para el
montaje. Siete decisiones.

1. **Quien edita sola no paga nada, y eso es una propiedad de este archivo.**
   Casi todas las sesiones tienen una persona dentro y el editor que se publicó
   en la Fase 0 es el caso común, así que la regla es una sola frase: **nada toca
   el almacén hasta que se aplica un `collab:joined`**. El puente es lo que
   escribe el almacén y lo que le quita el deshacer (`attachHistory`), y se
   construye en un único lugar: la primera entrada exitosa. Un circuito sin
   guardar (no hay id que unir), una compilación sin API (no hay socket que
   abrir, y por lo tanto no hay objeto de sesión), una API caída, una entrada
   rechazada con `NOT_FOUND`, un despliegue con la colaboración apagada — todos
   terminan en una sesión que nunca existió y un editor que nadie molestó. Con
   `status: 'off'` el panel dibuja exactamente un elemento: la región viva vacía.

2. **Entrar no puede borrar trabajo que la sesión nunca vio.** La primera versión
   adoptaba el documento del relevo y ahí terminaba, y eso perdía trabajo de tres
   maneras que en realidad eran una: una compuerta colocada en el segundo que hay
   entre pintar el lienzo y aterrizar la entrada (la lectura de autorización sola
   mide 273–547 ms contra este mismo repositorio en localhost), una recarga de
   `/c/:slug?c=…` —donde el borrador **es** la URL y §3.4 dice que ese pago
   siempre gana—, y un par que editó con el socket caído, cerró la pestaña y
   volvió a abrir la dirección que le quedó. En los tres casos el almacén tenía
   operaciones que no estaban en ningún documento, así que al adoptar no las
   sobrescribía: **no existían en ninguna parte**, ni en un par, ni en una fila,
   ni en una pila de deshacer. Ahora entrar las **lleva consigo**, con una regla
   deliberadamente asimétrica: el documento gana en todo lo que ya conoce, y el
   almacén aporta solo lo que el documento nunca tuvo. Aditivo, así que nada de
   lo que escribió otro par se borra — que es lo que descarta escribir el
   circuito del almacén tal cual, porque `writeCircuit` es una diferencia y
   borraría cada operación que este almacén no tenga. Y filtrado contra la
   **versión guardada** de la que el lienzo partió, para no resucitar lo que un
   par borró: ausente del documento y presente en la versión guardada es un
   borrado ajeno; ausente de las dos es trabajo de esta pestaña. La escritura
   ocurre después de crear el gestor de deshacer, así que aterriza como **un
   paso** que se puede deshacer de una pulsación.

3. **Un final se lleva el transporte, no el historial.** `attachHistory(null)`
   vacía el historial, y el argumento del almacén para vaciarlo es sobre _otras
   personas_. No aplica a lo que acumuló una sesión: `sharedUndo` registra las
   transacciones **de este cliente y de nadie más** —eso es `trackedOrigins`— así
   que cada paso de esa pila es trabajo de quien lo pulsaría. Desconectar el
   puente al terminar hacía lo único que esta función prometió no hacer: un frame
   del relevo que nadie pidió —`collab:left unauthorised`, un `NOT_FOUND`, un
   documento que la proyección rechaza— vaciaba la pila de deshacer de quien
   editaba sola mientras sus compuertas seguían en el lienzo. Así que un final
   **conserva** el puente y el documento pasa a ser de esta pestaña: el almacén
   sigue confirmando a través de él, deshacer sigue caminando los pasos de este
   cliente, y lo único que se detuvo es el transporte. El puente se libera al
   desmontar, que es el único momento en que el historial se va de todas formas.

4. **`access` sobrevive a un socket caído.** La página dibuja el modo de solo
   lectura desde `access === 'read'`, y borrarlo en cada cierre le entregaba a un
   **espectador** un editor plenamente escribible durante toda la reconexión:
   deshacer habilitado, paleta de vuelta, y la compuerta que colocaba entonces
   entraba en su propio Y.Doc y en el de nadie más —`flush` y `reconcile` exigen
   acceso de escritura— con la reentrada restaurando el aviso y dejando la
   divergencia puesta para siempre. Una reconexión conserva el último acceso que
   el relevo declaró: es la mejor respuesta disponible a «¿puedo escribir?»
   mientras la sesión vuelve, y se equivoca hacia no invitar a una edición que se
   va a descartar. Solo un **final** lo borra. Nada del transporte confía en él
   para decidir: cada envío está además condicionado a `joined`, que un cierre
   apaga. Esto no debilita §11 — el rechazo sigue siendo del servidor y en cada
   frame.

5. **La sesión se direcciona por _slug_, no por id.** El relevo resuelve
   cualquiera de los dos manejadores al mismo documento, pero `findReadable` no
   admite los dos para todo circuito: un id alcanza solo lo que un listado puede
   mostrar (`idAddressableCircuitFilter`), y §11 deja UNLISTED deliberadamente
   fuera de eso — **el slug es el control de acceso de un circuito no listado y
   por lo tanto el único manejador que lo direcciona**. Unir por id funcionaba
   para la dueña de cualquier cosa y para quien lee un PUBLIC, y contestaba
   `NOT_FOUND` justo en el caso para el que §3.4 construyó los espectadores: a
   quien le mandaron un enlace no listado. La suite de dos navegadores lo
   encontró; es el primer test de este repositorio donde los dos pares son dos
   personas distintas y no un documento abierto dos veces.

6. **La credencial es parte de lo que una sesión _es_.** El relevo decide
   `access` con la identidad que se le presenta al entrar y no existe ningún
   frame que la revise después. Una página cuya sesión de Supabase todavía no se
   había restaurado cuando el socket abrió entraba **anónima**: el relevo
   concedía `read` sobre un circuito PUBLIC o UNLISTED en lugar de negarse, y a la
   **dueña** del circuito se le decía «estás observando esta sesión» sin más
   salida que recargar. Así que la identidad es una dependencia del efecto que
   crea la sesión: cambia, y la sesión se vuelve a abrir presentando la
   credencial.

7. **Lo que impide que esto vuelva a pasar son dos gates, no un comentario.**
   `apps/web/src/routes/editor.test.tsx` monta la **ruta** con un `fetch` que
   resuelve un circuito real y un `WebSocket` que habla los frames reales de §8, y
   afirma sobre los siete montajes que la ruta alimenta —incluido el contenido del
   frame de presencia, porque `presence.length > 0` lo satisfacía el saludo de
   `announce()` sin ningún cableado de cursor. Y
   `apps/web/src/verification/reachability/` camina el grafo de importación real
   desde los puntos de entrada que el navegador carga y **nombra** cualquier módulo
   de `src/features` o `src/routes` que solo alcancen sus propios tests: la regla
   que faltaba no era «¿alguien importa esto?» —los siete archivos de la Fase 5
   tenían importadores— sino «¿se llega a esto desde algo que un navegador abre?».
   `no-orphans` de dependency-cruiser no puede responder eso: es `severity: 'warn'`
   y su predicado es «nadie lo importa».

### 3.5 Interoperabilidad

- **Exportar**: OpenQASM 3, código Python de Qiskit, JSON nativo, PNG/SVG del diagrama, PDF.
- **Importar**: OpenQASM 2 y 3, JSON nativo.
- **API pública** con API keys: crear circuitos, correr simulaciones y consultar resultados desde fuera.

### 3.6 Aprendizaje

- **Lecciones guiadas**: recorridos interactivos que combinan texto, circuito precargado y objetivos. Cubren: superposición, entrelazamiento, interferencia, Deutsch–Jozsa, Grover, teletransportación, codificación superdensa, BB84, QPE.
- **Modo reto**: se te da un estado objetivo (o una tabla de verdad) y debes construir el circuito que lo produce. Validación en el servidor comparando fidelidad contra el objetivo, con umbral configurable y límite opcional de compuertas.
- **Tabla de posiciones** por reto: menor número de compuertas, menor profundidad.

**Qué es exactamente una tabla de posiciones (decidido en M3.3).** Cinco decisiones. La autoridad es `packages/db/src/challenges.ts` para la consulta y `apps/web/src/features/challenges/ChallengeLeaderboard.tsx` para lo que se dibuja.

1. **Una fila por persona, y es su mejor intento.** Una tabla de intentos ordenada es un registro de quién pulsó más veces el botón: quien envía cuarenta veces la misma respuesta de tres compuertas ocuparía los cuarenta primeros puestos, y quien busca «quién resolvió esto con menos compuertas» leería un nombre repetido. La consulta es un `DISTINCT ON ("userId")` bajo el mismo orden con el que después se clasifica, así que la fila que se conserva de cada persona es exactamente la que la tabla usaría para compararla con las demás.

2. **El orden es total, no solo el que pide esta sección.** «Menor número de compuertas, menor profundidad» empata con frecuencia —los conteos de compuertas se agrupan mucho en un reto cuya respuesta son tres—, así que se desempata por `createdAt`, que favorece a quien llegó primero y es el único criterio que no cambia cuando envía una tercera persona. Y después por `id`: una marca de tiempo son milisegundos, dos intentos pueden compartir uno, y un comparador que pueda terminar en empate le deja la última palabra al plan de consulta — es decir, una clasificación que se baraja entre dos peticiones idénticas y sin defecto que encontrar después.

3. **Se clasifica lo que calculó el servidor, nunca lo que afirmó el cliente.** `gateCount` y `depth` son las columnas que escribió el validador tras simular (riesgo 5), sobre el circuito **expandido** (§3.1, decisión 3). El cuerpo de la petición no llega a esta consulta por ningún camino, y `apps/api/src/routes/challenges.test.ts` lo comprueba desde fuera: envía un circuito correcto envuelto en la afirmación de que mide una compuerta y comprueba que la tabla lo coloca por su longitud real.

4. **Se puede pedir no aparecer, y ocultarse no mueve a nadie más.** Una tabla de posiciones es el único listado público de **personas** del producto: un circuito tiene visibilidad y un reto resuelto no, así que nada de lo que ya existía podía expresar «clasifícame, pero no publiques mi nombre». Lo hace `User.leaderboardOptOut`, y el filtro se aplica **después** de asignar la posición. La consecuencia es la que justifica la función: retirar el nombre no asciende a quien viene detrás —si lo hiciera, subir puestos sería cuestión de convencer a otros de esconderse— y quien se retiró sigue viendo dónde está. El precio visible es que la columna de posiciones puede saltarse un número, y ese hueco es la declaración honesta: dice «aquí hay alguien» sin decir quién.

5. **El circuito ganador no se publica.** Sería publicar la respuesta, que es exactamente la fuga de la que se protege el objetivo, un intento más tarde y de parte de quien mejor resolvió el reto. Una fila es un nombre y dos números, y el esquema de respuesta no tiene campo donde poner otra cosa.

### 3.7 Hardware real

- El usuario aporta su propio token de IBM Quantum (hay un plan abierto gratuito).
- El token se cifra en reposo y **nunca** se expone al frontend; el backend actúa de proxy.
- Selección de backend disponible, envío de trabajo, seguimiento de estado (queued → running → done), y resultados guardados junto al circuito.
- Vista comparativa de tres columnas: **ideal | con ruido | hardware real**.

---

## 4. Arquitectura

```
┌───────────────────────────────────────────────────────────────┐
│                        NAVEGADOR                              │
│                                                               │
│  React + TypeScript (Vite)                                    │
│  ├── Editor de circuitos (SVG + dnd-kit)                      │
│  ├── Panel de análisis (Recharts + three.js)                  │
│  ├── Estado: Zustand (circuito) + React Query (servidor)      │
│  └── Web Worker ──► Motor de simulación (TS, y WASM opcional) │
│                     • statevector hasta ~20 qubits            │
│                     • density matrix hasta ~10 qubits         │
└──────────────────────────┬────────────────────────────────────┘
                           │ HTTPS (REST) + WebSocket
┌──────────────────────────▼────────────────────────────────────┐
│                        BACKEND                                │
│  Node 22 + Fastify + TypeScript                               │
│  ├── Auth (verifica JWT de Supabase Auth)                     │
│  ├── API REST (circuitos, versiones, galería, retos)          │
│  ├── WebSocket (progreso de jobs, colaboración)               │
│  ├── Validador de retos (simulación autoritativa)             │
│  └── Cliente IBM Quantum (proxy de credenciales)              │
│                                                               │
│  Worker (proceso aparte)                                      │
│  └── BullMQ ──► simulaciones grandes (hasta ~28 qubits)       │
│                 y polling de jobs de hardware                 │
└───────────┬────────────────────────┬──────────────────────────┘
            │                        │
    ┌───────▼────────┐      ┌────────▼────────┐
    │  SUPABASE      │      │  Redis          │
    │  Postgres      │      │  (cola + cache) │
    │  + Auth        │      │  Railway        │
    │  + Storage     │      │                 │
    │  (vía Prisma)  │      │                 │
    └────────────────┘      └─────────────────┘
```

### Principio de diseño clave: simulación en dos niveles

La mayoría de las simulaciones (< 20 qubits) corren **en el navegador**, dentro de un Web Worker. Esto da retroalimentación instantánea mientras editas, sin costo de servidor y sin latencia de red. El servidor solo entra cuando:

- El circuito excede el límite del cliente.
- Se necesita una simulación **autoritativa** (validar un reto, evitar trampa).
- Se ejecuta en hardware real.

Es la decisión arquitectónica más importante del proyecto: hace que la app se sienta instantánea y que la infraestructura sea barata.

---

## 5. Motor de simulación

Esta es la pieza técnica central. Vale la pena implementarla con cuidado porque es lo que distingue al proyecto.

### 5.1 Representación del estado

Un sistema de _n_ qubits vive en un espacio de 2ⁿ dimensiones. El estado es un vector de 2ⁿ amplitudes complejas:

```
|ψ⟩ = Σ aᵢ |i⟩,   con Σ |aᵢ|² = 1
```

En memoria se guarda como **dos `Float64Array` paralelos** (parte real y parte imaginaria) en lugar de un arreglo de objetos. Esto evita presión sobre el recolector de basura y permite usar `SharedArrayBuffer` entre el hilo principal y el worker.

Consumo de memoria: `2ⁿ × 16 bytes`.

| Qubits | Amplitudes  | Memoria |
| ------ | ----------- | ------- |
| 10     | 1,024       | 16 KB   |
| 16     | 65,536      | 1 MB    |
| 20     | 1,048,576   | 16 MB   |
| 24     | 16,777,216  | 256 MB  |
| 28     | 268,435,456 | 4 GB    |

De ahí salen los límites: ~20 qubits es cómodo en navegador, ~28 es el techo razonable en servidor.

### 5.2 Aplicación de compuertas (lo importante)

La forma ingenua de aplicar una compuerta a un qubit dentro de un sistema de _n_ qubits es construir la matriz completa con productos de Kronecker:

```
I ⊗ I ⊗ H ⊗ I  →  matriz de 2ⁿ × 2ⁿ
```

**No hagas eso.** Esa matriz tiene 4ⁿ entradas y es casi toda ceros. Aplicarla cuesta O(4ⁿ).

El enfoque correcto es actualizar el statevector **en sitio, por pares de índices**. Aplicar una compuerta de 1 qubit al qubit _t_ significa recorrer todos los índices donde el bit _t_ vale 0, emparejarlos con el índice donde ese bit vale 1, y aplicar la matriz 2×2 a ese par:

```ts
const stride = 1 << target
for (let base = 0; base < size; base += stride << 1) {
  for (let offset = 0; offset < stride; offset++) {
    const i0 = base + offset // bit target = 0
    const i1 = i0 + stride // bit target = 1
    // [a0', a1'] = M · [a0, a1]
  }
}
```

Costo: **O(2ⁿ)** por compuerta, sin asignar memoria adicional. Un circuito de 20 qubits con 200 compuertas son ~200 millones de operaciones: fracciones de segundo.

Para compuertas controladas, la única diferencia es saltar los índices donde el bit de control no cumple la condición. Para compuertas de 2 qubits sin estructura de control, se agrupan cuatro índices en lugar de dos.

### 5.3 Medición

**Probabilidades**: regla de Born, `P(i) = |aᵢ|²`. Para la probabilidad marginal de un qubit, se suman las probabilidades de todos los estados base donde ese bit vale 1.

**Muestreo de shots**: se construye la distribución acumulada una vez y se muestrea con búsqueda binaria — O(2ⁿ + shots·n). Para volúmenes altos de shots conviene el método _alias_ (O(1) por muestra).

**Medición a mitad de circuito**: colapsa el estado. Se elige un resultado según la probabilidad, se anulan las amplitudes incompatibles y se renormaliza el vector. Como el resultado es aleatorio, un circuito con medición intermedia **no tiene un único estado final**: para obtener estadísticas hay que correr trayectorias independientes (una por shot). El motor debe distinguir claramente el modo "estado final analítico" del modo "trayectorias muestreadas".

### 5.4 Matrices de densidad y ruido

Para simular ruido no basta el statevector: hay que usar la matriz de densidad ρ, de tamaño 2ⁿ × 2ⁿ (4ⁿ entradas complejas). Las compuertas actúan como `ρ → UρU†` y los canales de ruido como sumas de Kraus:

```
ρ → Σₖ Kₖ ρ Kₖ†
```

Ejemplos de operadores de Kraus:

- **Despolarizante** con probabilidad p: `√(1-3p/4)·I, √(p/4)·X, √(p/4)·Y, √(p/4)·Z`
- **Amplitude damping** con γ: `K₀ = [[1,0],[0,√(1-γ)]]`, `K₁ = [[0,√γ],[0,0]]`

Alternativa más escalable para circuitos grandes: **trayectorias de Monte Carlo cuántico**, donde se mantiene un statevector y se aplican errores aleatorios por shot. Cuesta más shots pero usa memoria de 2ⁿ en lugar de 4ⁿ.

### 5.5 Vector de Bloch desde la densidad reducida

Para dibujar la esfera de Bloch del qubit _q_ en un sistema entrelazado, se calcula la traza parcial sobre los demás qubits para obtener ρ_q (2×2), y de ahí:

```
rx = 2·Re(ρ₀₁),  ry = 2·Im(ρ₁₀),  rz = ρ₀₀ − ρ₁₁
```

La longitud del vector `|r|` vale 1 para un estado puro y menos de 1 para un estado mixto. En un par de Bell, cada qubit por separado tiene `|r| = 0`: el vector colapsa al centro de la esfera. Mostrar eso visualmente enseña entrelazamiento mejor que cualquier ecuación.

### 5.6 Estrategia de rendimiento

1. **Fase 1 — TypeScript puro en Web Worker.** Suficiente hasta ~20 qubits. Simple, sin toolchain extra.
2. **Fase 2 — WASM en Rust** para el núcleo numérico, con SIMD. Da entre 3× y 10× de mejora y permite subir el techo. Es además un buen punto de conversación técnica en el portafolio.
3. **Caché incremental.** Al editar un circuito, guardar el statevector en checkpoints cada K columnas; si editas la columna 30 de 40, se re-simula solo desde el checkpoint anterior en vez de desde cero.
4. **Debounce** de 150 ms en la simulación en vivo, y cancelación del trabajo anterior si llega una edición nueva.

---

## 6. Formato de circuito (el contrato central)

Todo el sistema gira alrededor de un JSON. Debe ser estable, versionado y validado con Zod tanto en cliente como en servidor.

```jsonc
{
  "schemaVersion": 1,
  "qubits": 3,
  "clbits": 2,
  "qubitLabels": ["alice", "shared", "bob"],
  "parameters": [{ "name": "theta", "value": 0.7853981634 }],
  "operations": [
    { "id": "op_1", "gate": "h", "targets": [0], "column": 0 },
    {
      "id": "op_2",
      "gate": "cx",
      "targets": [2],
      "controls": [1],
      "column": 1,
    },
    {
      "id": "op_3",
      "gate": "rz",
      "targets": [0],
      "params": ["theta"],
      "column": 2,
    },
    {
      "id": "op_4",
      "gate": "measure",
      "targets": [0],
      "clbitTargets": [0],
      "column": 3,
    },
    {
      "id": "op_5",
      "gate": "x",
      "targets": [2],
      "column": 4,
      "condition": { "clbit": 0, "equals": 1 },
    },
  ],
  "customGates": {
    "bellPair": {
      "qubits": 2,
      "operations": [/* ... */],
    },
  },
}
```

Reglas del formato:

- `column` define el orden temporal; operaciones en la misma columna son simultáneas y **no pueden compartir qubits**.
- Los `controls` negativos se expresan como `{ "qubit": 1, "state": 0 }`.
- Los parámetros pueden ser números literales o referencias simbólicas por nombre.
- `schemaVersion` permite migraciones futuras sin romper circuitos guardados.

---

## 7. Modelo de datos (Prisma / PostgreSQL)

```prisma
model User {
  id            String   @id @default(cuid())
  email         String   @unique
  username      String   @unique
  displayName   String?
  avatarUrl     String?
  passwordHash  String?
  createdAt     DateTime @default(now())

  accounts      Account[]
  circuits      Circuit[]
  stars         Star[]
  comments      Comment[]
  collections   Collection[]
  submissions   ChallengeSubmission[]
  credentials   HardwareCredential[]
  apiKeys       ApiKey[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  provider          String  // "github" | "google"
  providerAccountId String
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
}

model Circuit {
  id             String      @id @default(cuid())
  ownerId        String
  title          String
  description    String?     @db.Text
  visibility     Visibility  @default(PRIVATE)
  slug           String      @unique
  qubitCount     Int
  gateCount      Int
  depth          Int
  forkedFromId   String?
  starCount      Int         @default(0)
  viewCount      Int         @default(0)
  preview        Json?       // miniatura del diagrama, derivada al escribir (M1.5b)
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  owner          User             @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  forkedFrom     Circuit?         @relation("Forks", fields: [forkedFromId], references: [id])
  forks          Circuit[]        @relation("Forks")
  versions       CircuitVersion[]
  runs           SimulationRun[]
  hardwareJobs   HardwareJob[]
  stars          Star[]
  comments       Comment[]
  tags           CircuitTag[]

  @@index([visibility, starCount])
  @@index([ownerId, updatedAt])
}

model CircuitVersion {
  id          String   @id @default(cuid())
  circuitId   String
  versionNum  Int
  data        Json     // el JSON del circuito
  message     String?
  createdAt   DateTime @default(now())

  circuit     Circuit  @relation(fields: [circuitId], references: [id], onDelete: Cascade)

  @@unique([circuitId, versionNum])
}

model SimulationRun {
  id           String    @id @default(cuid())
  circuitId    String?
  userId       String?
  mode         SimMode   // STATEVECTOR | DENSITY_MATRIX | TRAJECTORIES
  shots        Int?
  noiseProfile Json?
  status       RunStatus @default(QUEUED)
  result       Json?     // probabilidades, conteos, métricas
  errorMessage String?
  durationMs   Int?
  createdAt    DateTime  @default(now())

  circuit      Circuit?  @relation(fields: [circuitId], references: [id], onDelete: SetNull)

  @@index([userId, createdAt])
}

model HardwareCredential {
  id            String   @id @default(cuid())
  userId        String
  provider      String   // "ibm_quantum"
  encryptedToken Bytes   // AES-256-GCM
  iv            Bytes
  label         String?
  createdAt     DateTime @default(now())

  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model HardwareJob {
  id             String    @id @default(cuid())
  circuitId      String
  userId         String
  provider       String
  backendName    String
  providerJobId  String?
  shots          Int
  status         JobStatus @default(SUBMITTED)
  queuePosition  Int?
  result         Json?
  errorMessage   String?
  submittedAt    DateTime  @default(now())
  completedAt    DateTime?

  circuit        Circuit   @relation(fields: [circuitId], references: [id], onDelete: Cascade)

  @@index([userId, status])
}

model Challenge {
  id            String   @id @default(cuid())
  slug          String   @unique
  title         String
  prompt        String   @db.Text
  difficulty    Int
  qubitCount    Int
  targetType    String   // "state" | "unitary" | "truth_table"
  targetData    Json
  allowedGates  String[]
  maxGates      Int?
  fidelityThreshold Float @default(0.99)
  orderIndex    Int

  submissions   ChallengeSubmission[]
}

model ChallengeSubmission {
  id           String   @id @default(cuid())
  challengeId  String
  userId       String
  circuitData  Json
  passed       Boolean
  fidelity     Float
  gateCount    Int
  depth        Int
  createdAt    DateTime @default(now())

  challenge    Challenge @relation(fields: [challengeId], references: [id], onDelete: Cascade)
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([challengeId, passed, gateCount])
}

model Collection {
  id          String   @id @default(cuid())
  ownerId     String
  title       String
  description String?
  visibility  Visibility @default(PRIVATE)

  owner       User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  items       CollectionItem[]
}

model CollectionItem {
  collectionId String
  circuitId    String
  orderIndex   Int

  collection   Collection @relation(fields: [collectionId], references: [id], onDelete: Cascade)

  @@id([collectionId, circuitId])
}

model Star {
  userId    String
  circuitId String
  createdAt DateTime @default(now())

  user      User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  circuit   Circuit @relation(fields: [circuitId], references: [id], onDelete: Cascade)

  @@id([userId, circuitId])
}

model Comment {
  id        String   @id @default(cuid())
  circuitId String
  userId    String
  body      String   @db.Text
  parentId  String?
  createdAt DateTime @default(now())

  circuit   Circuit  @relation(fields: [circuitId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Tag {
  id       String       @id @default(cuid())
  name     String       @unique
  circuits CircuitTag[]
}

model CircuitTag {
  circuitId String
  tagId     String

  circuit   Circuit @relation(fields: [circuitId], references: [id], onDelete: Cascade)
  tag       Tag     @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([circuitId, tagId])
}

model ApiKey {
  id         String   @id @default(cuid())
  userId     String
  name       String
  keyHash    String   @unique
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime @default(now())

  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

enum Visibility { PRIVATE UNLISTED PUBLIC }
enum SimMode    { STATEVECTOR DENSITY_MATRIX TRAJECTORIES }
enum RunStatus  { QUEUED RUNNING DONE FAILED }
enum JobStatus  { SUBMITTED QUEUED RUNNING DONE FAILED CANCELLED }
```

Notas de diseño:

- El circuito vive en `CircuitVersion.data` como JSON, no normalizado en tablas de compuertas. Normalizarlo no aporta nada (nunca se consulta por compuerta individual) y complicaría enormemente lecturas y escrituras.
- `Circuit` guarda métricas denormalizadas (`gateCount`, `depth`, `starCount`) para poder ordenar la galería sin joins costosos.
- **Ajuste M2.3**: §7 no tiene modelo para las compuertas personalizadas que pide §3.1 («se guardan por usuario y se pueden publicar»), así que se añade `CustomGate` — el único modelo que excede la especificación. Es una **biblioteca, no un grafo de dependencias**: ningún `CircuitVersion.data` apunta a una fila de esta tabla, instalar un bloque publicado copia la definición al documento, y por eso borrar, editar o despublicar una entrada no puede romper el circuito de nadie. Las reglas de visibilidad son las mismas que las de `Circuit` (`listableCustomGateFilter` y `customGateHandleFilter` en `packages/db/src/custom-gates.ts`), con la misma asimetría que `Collection`: el id alcanza un bloque UNLISTED porque es el único identificador que tiene. Una entrada guardada debe bastarse a sí misma —su cuerpo no puede nombrar otro bloque—, que es lo que impide que una fila dependa de otra fila.
- **Ajuste M1.5b**: `Circuit.preview` guarda, por la misma razón, la miniatura que dibuja cada tarjeta de la galería — una versión acotada del circuito (unos pocos hilos y columnas, sin parámetros ni etiquetas) derivada por `previewOf` en las dos únicas escrituras que guardan un documento. Sin ella, pintar cincuenta miniaturas obligaría a leer cincuenta `CircuitVersion.data` de hasta 256 KiB cada uno en la ruta anónima más visitada del producto. Es anulable y se lee siempre con `safeParsePreview`: una imagen jamás vale un 500.
- **Ajuste M3.3**: `User` gana una columna, `leaderboardOptOut Boolean @default(false)`, porque §3.6 publica una tabla de **personas** y §7 no tenía dónde decir «clasifícame, pero no publiques mi nombre» — la visibilidad de un circuito no habla de un reto resuelto. Se llama por la **decisión** y no por el listado a propósito: con un `showOnLeaderboard` por omisión `true`, «nunca expresó una preferencia» y «pidió aparecer» serían el mismo valor, y cambiar el valor por omisión reescribiría en silencio la preferencia declarada de quien sí tenía una. No viaja en `publicUserSelect`: una preferencia no es un hecho público sobre alguien, y ahí acompañaría a la firma de cada circuito de la galería. La lee `accountSelect`, que es `publicUserSelect` **extendido con un spread** —de modo que sigue habiendo un solo sitio donde se enumeran columnas de `User` y ninguna de las dos proyecciones puede ganar un `email` sin que lo gane la otra— y solo la usan las tres rutas donde quien consulta es el sujeto: `GET`, `PATCH` y `DELETE /me`. La segunda migración de este hito añade además el índice `[challengeId, passed, userId, gateCount, depth, createdAt, id]`, que es el orden exacto del `DISTINCT ON` de la tabla; los tres índices anteriores se conservan, porque ninguno lo sirve y borrar uno es justo la sentencia destructiva que el tripwire de migraciones rechaza.
- `HardwareCredential` guarda el token cifrado en `Bytes`, nunca en texto plano, y jamás se devuelve por la API.
- **Ajuste por Supabase Auth**: como la autenticación la maneja Supabase, los modelos `Account` y el campo `passwordHash` de `User` **se eliminan** — Supabase ya los cubre en su esquema `auth`. `User.id` deja de ser `cuid()` y pasa a ser el UUID que emite Supabase (`@id @db.Uuid`), y la fila se crea al primer login mediante un trigger en Postgres sobre `auth.users` o desde el backend en el primer request autenticado. Prisma solo administra el esquema `public`; nunca toca `auth`.

---

## 8. API REST

Base: `/api/v1`

**Autenticación**

```
POST   /auth/register
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
GET    /auth/oauth/:provider
GET    /auth/me
```

**Circuitos**

```
GET    /circuits                  # los míos, paginado
POST   /circuits
GET    /circuits/:slug
PATCH  /circuits/:id
DELETE /circuits/:id
POST   /circuits/:id/fork
GET    /circuits/:id/versions
POST   /circuits/:id/versions     # guardar nueva versión
GET    /circuits/:id/versions/:n
POST   /circuits/:id/star
DELETE /circuits/:id/star
```

**Galería**

```
GET    /gallery?sort=stars|recent&tag=&q=&cursor=&limit=
GET    /users/:username/circuits?sort=&tag=&q=&cursor=&limit=
```

Dos ajustes frente a lo escrito arriba, ambos de M1.5:

- `?page=` es `?cursor=`. El orden por omisión es una columna que otras
  personas cambian mientras alguien lee, y un `OFFSET` sobre un orden que se
  mueve repite o salta filas sin que el cliente pueda notarlo. El argumento
  completo está en `GalleryCursor` (`packages/db/src/gallery.ts`).
- La respuesta es `{ items, nextCursor, limit, starred }`. `starred` son los
  ids de _esta página_ que quien consulta ha marcado con estrella, vacío para
  una llamada anónima: es una propiedad del par (circuito, espectador), no del
  circuito, así que viaja en el sobre y no en la tarjeta — la misma razón por
  la que `GET /circuits/:id` responde `{ circuit, version, starred }`.

**Cuenta, perfiles y colecciones** (M1.9; §8 original no los enumeraba)

```
GET    /me                        # la fila del propio usuario
PATCH  /me                        # displayName, username, avatar
DELETE /me                        # destructivo, confirmado con el username
GET    /users/:username           # perfil público: usuario y dos conteos
GET    /users/:username/collections?page=&perPage=

GET    /collections               # las mías
POST   /collections
GET    /collections/:id           # la colección y lo que este espectador ve
PATCH  /collections/:id
DELETE /collections/:id
POST   /collections/:id/items     # { circuit: <slug o id> }
DELETE /collections/:id/items/:circuitId
GET    /circuits/:id/collections  # cuáles de MIS colecciones lo contienen
```

Cuatro decisiones de M1.9, escritas aquí para que el documento y el código no
se contradigan:

- **La visibilidad de una colección gobierna la colección, nunca su
  contenido.** Los ítems se leen con `listableCircuitFilter` y el espectador
  de la petición, igual que cualquier otro listado: una colección PÚBLICA que
  contiene un circuito PRIVADO no lo publica. La respuesta es
  `{ collection, items, withheldItemCount, starred }` — `withheldItemCount` es
  cuántos ítems se ocultaron, y es un número y jamás un identificador. Sin él,
  una colección de cinco que muestra dos sería indistinguible de una de dos, y
  eso es una mentira sobre el trabajo de alguien. Consecuencia deliberada: un
  circuito UNLISTED dentro de una colección pública tampoco se muestra —
  «reachable by whoever holds the link» y un listado es descubrimiento.
- **Un conteo es un listado.** `circuitCount` y `collectionCount` del perfil
  pasan por los mismos filtros que las listas correspondientes, así que el
  número que ve un extraño es el número de tarjetas que obtendría paginando
  hasta el final.
- **`GET /me` responde con `publicUserSelect`**, sin `email`. No existe una
  segunda proyección de `User` en el sistema: quien consulta ya conoce su
  propia dirección — es un claim del token con el que se autenticó.
- **No hay endpoint de disponibilidad de username.** El índice único decide en
  la escritura (`USERNAME_TAKEN`, 409); un endpoint de consulta sería un
  oráculo barato y scriptable sobre toda la tabla. Y `DELETE /me` destruye
  todas las filas de `public` de esa persona, incluidos los huérfanos que
  ninguna clave foránea alcanza (§7 deja cuatro columnas sin FK a propósito),
  pero **no** la identidad en `auth.users`: eso exigiría la service-role key en
  el proceso, una credencial que este servicio deliberadamente nunca ha tenido
  (§11 solo verifica JWT contra un JWKS público).

**Simulación**

```
POST   /simulate                  # síncrono si es chico, encolado si es grande
GET    /simulate/:runId
```

**Hardware**

```
GET    /hardware/backends
POST   /hardware/credentials
DELETE /hardware/credentials/:id
POST   /hardware/jobs
GET    /hardware/jobs/:id
DELETE /hardware/jobs/:id         # cancelar
```

**Retos**

```
GET    /challenges
GET    /challenges/:slug
POST   /challenges/:slug/submit
GET    /challenges/:slug/leaderboard?limit=
```

Tres precisiones de M3.3, escritas aquí para que el documento y el código no se
contradigan:

- La respuesta del leaderboard es `{ entries, standing }`. `standing` es dónde
  está **quien consulta** —posición, compuertas, profundidad y si su nombre
  aparece— y viaja en el sobre y no en una entrada por la misma razón que
  `starred` y `solved`: es una propiedad del par (reto, espectador). Es `null`
  para una llamada anónima y para quien todavía no ha resuelto el reto, que son
  la misma respuesta a «dónde estás». Existe porque una tabla de diez contesta
  «quién va ganando» y nunca «cómo voy yo», que es la pregunta que hace volver a
  alguien a acortar un circuito.
- `entries[].rank` es una posición sobre **todo el mundo**, asignada antes de
  retirar a quien pidió no aparecer, así que puede saltarse un número. No se
  renumera en el cliente: hacerlo permitiría ganar puestos convenciendo a otro de
  esconderse, y haría que la tabla contradijese el `standing` impreso debajo.
- `PATCH /me` acepta `leaderboardOptOut`, y `GET`/`PATCH /me` responden
  `{ user, leaderboardOptOut }` — el ajuste es hermano de `user` y no un campo
  suyo, porque `PublicUserResponse` es la forma por la que se serializa cada
  firma de circuito y una preferencia dentro de ella se publicaría a cualquier
  desconocido que abra la galería.

**Embeds** (Fase 3, §3.4)

```
GET    /embed/:handle             # anónimo SIEMPRE; solo PUBLIC y UNLISTED
```

Una ruta aparte y no un parámetro de `GET /circuits/:id`, porque la diferencia
es la política de autenticación y no la forma de la respuesta: esta es
`auth: 'public'`, así que la cabecera `Authorization` no se consulta nunca —ni
siquiera para su propia dueña— y un circuito PRIVADO responde el mismo 404 que
un slug que nadie acuñó. La respuesta es una proyección deliberadamente
estrecha: `{ embed: { slug, title, qubitCount, gateCount, depth, author:
{ username }, circuit } }`. No lleva `id` (un identificador en una respuesta es
un identificador suelto), ni `visibility` (publicaría la decisión de la autora
sobre quién debe encontrar su trabajo), ni `description`, ni `avatarUrl` (sería
una petición a un tercero, y una dirección IP, por cada lector), ni contadores
sociales, ni marcas de tiempo. El argumento completo de cada omisión está en
`packages/contract/src/embed.ts`.

**Interoperabilidad**

```
POST   /convert/qasm-to-json
POST   /convert/json-to-qasm
POST   /convert/json-to-qiskit
```

**WebSocket** en `/ws`: eventos `run:progress`, `run:complete`, `job:status`, y canal de colaboración `circuit:<id>`.

El canal de colaboración son cuatro frames de cliente (`collab:join`,
`collab:update`, `collab:presence`, `collab:leave`) y cinco de servidor
(`collab:joined`, `collab:update`, `collab:presence`, `collab:left`,
`collab:error`) sobre el mismo socket, con la actualización CRDT en base64 dentro
del JSON. `collab:join` lleva un vector de estado opcional —«esto ya lo tengo»— y
el servidor contesta con la diferencia, que es lo que hace que reconectar sea
barato y, más importante, correcto: quien editó sin conexión conserva sus
ediciones y recibe solo lo que le faltaba. `collab:presence` es el único frame
del canal que **no** es binario opaco: lleva una posición tipada del cliente y
vuelve con el nombre y el permiso que compone el servidor, por la razón que da
§3.4 (decisión 1 de M5.3). El vocabulario completo, con sus techos y el argumento
de cada uno, está en `packages/contract/src/socket.ts`; las decisiones del relevo
y de la presencia están en §3.4.

---

## 9. Frontend

### Estructura

```
apps/web/src/
├── main.tsx
├── routes/
│   ├── landing.tsx
│   ├── editor.tsx            # /c/:slug y /new
│   ├── gallery.tsx
│   ├── challenges.tsx
│   ├── lessons.tsx
│   ├── profile.tsx
│   └── settings.tsx
├── features/
│   ├── circuit-editor/
│   │   ├── CircuitCanvas.tsx      # rejilla SVG
│   │   ├── GatePalette.tsx
│   │   ├── GateNode.tsx
│   │   ├── QubitWire.tsx
│   │   ├── TimelineScrubber.tsx
│   │   └── useCircuitStore.ts     # Zustand + undo/redo
│   ├── analysis/
│   │   ├── ProbabilityHistogram.tsx
│   │   ├── AmplitudeTable.tsx
│   │   ├── BlochSphere.tsx        # three.js
│   │   ├── QSphere.tsx
│   │   ├── DensityHeatmap.tsx
│   │   └── EntanglementPanel.tsx
│   ├── simulation/
│   │   ├── useSimulation.ts       # orquesta worker vs. servidor
│   │   └── simulation.worker.ts
│   ├── gallery/
│   ├── challenges/
│   └── hardware/
├── lib/
│   ├── qsim/                  # motor de simulación en TS
│   │   ├── statevector.ts
│   │   ├── gates.ts
│   │   ├── apply.ts           # el kernel de aplicación de compuertas
│   │   ├── density.ts
│   │   ├── noise.ts
│   │   ├── measure.ts
│   │   └── metrics.ts         # entropía, concurrencia, Bloch
│   ├── qasm/                  # parser y serializador
│   ├── schema/                # tipos + validadores Zod
│   └── api/                   # cliente con React Query
└── components/ui/             # shadcn/ui
```

### Decisiones de implementación

- **SVG, no canvas**, para el lienzo del circuito: los circuitos rara vez pasan de unos cientos de elementos, y SVG da accesibilidad, selección y exportación gratis.
- **dnd-kit** para arrastrar y soltar (mejor soporte táctil y de teclado que las alternativas).
- **Zustand** para el estado del circuito, con middleware de historial para undo/redo; **React Query** para todo lo que viene del servidor. No mezclar ambos.
- **three.js** solo para las esferas de Bloch y la Q-sphere, cargado con `lazy()` para no penalizar el bundle inicial.
- El motor `qsim` se escribe **sin dependencias de React ni del DOM**, de forma que corre igual en el worker del navegador y en Node dentro del backend. Un solo motor, dos entornos.

---

## 10. Sistema de diseño

La estética sale del tema, no de una plantilla. La idea rectora: **la fase es color**.

En cuántica, cada amplitud tiene magnitud y fase. La fase es lo que la mayoría de los visualizadores tiran a la basura, y es justamente lo que produce la interferencia. Aquí la paleta funcional se deriva del círculo de fase: el color de una amplitud es su fase, mapeada a matiz.

```
hue = fase · 180/π      color = hsl(hue, 85%, 66%)
```

Los cuatro anclajes de referencia:

| Fase | Muestra de esta sección | Derivado de la fórmula |
| ---- | ----------------------- | ---------------------- |
| 0    | `#F5445E`               | `#F25F5F`              |
| π/2  | `#7BE04A`               | `#A8F25F`              |
| π    | `#33D6D6`               | `#5FF2F2`              |
| 3π/2 | `#A24AE0`               | `#A85FF2`              |

**Dos correcciones medidas en M0.7a**, ambas escritas aquí para que el documento y el código no se contradigan (`apps/web/src/lib/phase-colour.ts` es la autoridad, y `apps/web/src/verification/design/token-contrast.test.ts` vuelve a derivar cada número en cada corrida):

1. **La luminosidad es 66%, no 62%.** Barriendo el círculo completo en pasos de un cuarto de grado, con 62% el matiz peor (240°, fase 4π/3) da 2.98:1 sobre `--bg-panel` y 2.66:1 sobre `--bg-elevated`, por debajo del 3:1 que la WCAG 2.2 SC 1.4.11 exige. Una barra del histograma califica dos veces: su matiz lleva la fase, y su borde contra el panel es lo que hace legible su altura, o sea la probabilidad. Con 66% el peor matiz mide 4.02:1 sobre `--bg-deep`, 3.65:1 sobre `--bg-panel` y 3.26:1 sobre `--bg-elevated`. Es la misma corrección que ya se hizo con `--wire`: se conservan el matiz y la saturación, se sube la luminosidad hasta que mide, y se escribe por qué. Nótese que la tabla de cuatro anclajes no podía detectar esto: la región que falla está cerca de 240° y ningún anclaje cae ahí.

2. **Las cuatro muestras de arriba estaban ajustadas a mano, no derivadas.** Medidas, son `hsl(351.2, 90%, 61%)`, `hsl(100.4, 71%, 58%)`, `hsl(180.0, 67%, 52%)` y `hsl(275.2, 71%, 58%)`: la misma familia de color, dentro de 11° de matiz, pero con saturación y luminosidad propias. Lo que se implementa es la regla generativa, no la interpolación entre las cuatro: un estado de _n_ qubits tiene 2ⁿ amplitudes y por lo tanto un continuo de fases, no cuatro, y un mapeo que se pegara a las muestras en las fases cardinales haría que la saturación y la luminosidad saltaran alrededor del círculo — dos amplitudes separadas por una centésima de radián se verían con distinto peso visual sin razón física. Una sola saturación y una sola luminosidad para todo el círculo es lo que hace que diferencias iguales de fase se vean iguales.

**Un colaborador no es un dato, y por eso no toma prestada esta rueda (M5.3).**
Los cuatro estados del diff y las dos direcciones del ruido sí la toman: son
matices puros a la saturación y luminosidad de la fase, y heredan la barrida de
contraste que las cubre a todas. El cursor de otra persona no puede, porque se
dibuja sobre el lienzo al mismo tiempo que el histograma — un caret a 85 %/66 %
no es «parecido» al color de una amplitud, es el color de una fase concreta,
junto a ella. Los colores de colaborador se separan por los dos ejes que la rueda
no usa (saturación 55 %, luminosidad 78 %: pálido y claro donde un dato es vivo y
medio), sus ocho matices están a 45° empezando en 27.5° —el desplazamiento que
maximiza la distancia a todo matiz que ya significa algo— y nunca rellenan una
forma: contorno, caret y etiqueta con el nombre. La autoridad es
`apps/web/src/lib/collab-colour.ts` y las mediciones se rederivan en
`apps/web/src/verification/design/token-contrast.test.ts`; el argumento completo
está en §3.4, decisión 4 de M5.3.

**El color nunca es el único portador de la fase.** Una rueda de matices es justamente lo que una persona con daltonismo no puede leer, y el círculo de fase pasa un tercio de su arco en esa confusión. El orden de codificación es: primero la **dirección** del fasor (legible sin visión de color, y es lo que hace visible la cancelación de dos fasores opuestos como geometría), después el **ángulo numérico** en radianes y grados, formateado con `Intl.NumberFormat` del idioma activo, y solo entonces el **matiz**, como refuerzo. De ahí se sigue el comportamiento bajo `prefers-reduced-motion`: los fasores dejan de girar pero siguen apuntando, porque la información está en hacia dónde apuntan y la rotación era solo la animación del cambio.

**Paleta de interfaz** (fría, de laboratorio criogénico, para que los colores de fase resalten):

```
--bg-deep     #0B0E1F
--bg-panel    #141833
--bg-elevated #1C2145
--wire        #5A65AA
--text        #E8EAF6
--text-muted  #8B93C4
--accent      #5AC8FA
```

`--wire` se escribió originalmente como `#3A4170`, pero medido contra la superficie sobre la que siempre se dibuja —`--bg-panel` `#141833`— ese valor da un contraste de 1.80:1, y la WCAG 1.4.11 exige 3:1 para «las partes de los gráficos necesarias para comprender el contenido»: un hilo de qubit no es decoración, es lo que dice qué compuertas comparten un qubit y por dónde corre la línea de tiempo, y el SVG es `aria-hidden`, así que una persona con baja visión que no use lector de pantalla no tiene una segunda representación a la que recurrir. El valor que se envía conserva el mismo matiz (232°) y la misma saturación, aclarado hasta pasar la medición: 3.21:1 sobre `--bg-panel` y 3.53:1 sobre `--bg-deep`. El mismo token dibuja los bordes de las fichas de la paleta y de la barra de herramientas, que son interactivos y deben ese mismo 3:1.

**Tipografía**

- Display: **Space Grotesk** — geométrica con letras ligeramente extrañas, técnica sin ser fría.
- Cuerpo: **Inter**.
- Datos y código: **IBM Plex Mono** — un guiño deliberado al linaje de IBM Quantum, y necesaria para alinear tablas de amplitudes.

Se **auto-hospedan** con `@fontsource` (M0.7a), no con un `<link>` a Google Fonts: `pnpm dev` tiene que funcionar sin red, y una página desplegada no debe entregarle a un tercero una petición —y una dirección IP— por cada visitante. Cada familia se declara a mano contra un archivo explícito del subconjunto `latin` en lugar de importar la hoja del paquete, que declara los siete subconjuntos y haría que Vite emitiera todos como assets. Costo enviado, subconjunto latin, woff2:

| Familia                           |   Peso |
| --------------------------------- | -----: |
| Inter (variable, 100–900)         | 47.1 K |
| Space Grotesk (variable, 300–700) | 21.8 K |
| IBM Plex Mono (estático, 400)     | 14.4 K |
| **Total** (tres archivos)         | 83.3 K |

Las versiones variables son lo que abarata esto: un archivo cubre todos los pesos, así que un encabezado semibold no cuesta nada extra. IBM Plex Mono no tiene versión variable en fontsource, de modo que un segundo peso ahí serían otros 14.5 K.

**Lo que el subconjunto latin no cubre — y ningún otro subconjunto tampoco:** la notación matemática. `√` (U+221A), `⟩` (U+27E9), `⋮` (U+22EE), `π` y `θ` aparecen en símbolos de compuerta y en la notación de kets, y están ausentes de todos los subconjuntos que Google Fonts publica para estas tres familias — IBM Plex Mono no publica subconjunto griego en absoluto. Esos caracteres vienen del fallback del sistema sin importar cómo subconjuntemos, que es precisamente por qué subconjuntear a latin no cuesta nada: `†` (U+2020, en latin-ext) es el único glifo que un subconjunto más ancho compraría, y comprarlo solo dejaría `S†` alineado mientras `√X` sigue sin estarlo. Relevante para la tabla de amplitudes: el `⟩` de `|01⟩` no será IBM Plex Mono, así que la columna monoespaciada no debe depender de su ancho.

**Elemento firma: los fasores.** Las barras del histograma no son barras planas de un solo color: cada una lleva un pequeño vector rotante que apunta en la dirección de su fase. Cuando mueves el slider de una compuerta Rz, las flechas giran. Cuando dos caminos interfieren destructivamente, ves dos fasores opuestos cancelarse antes de que la barra desaparezca. Esa es la única animación importante de la app, y explica en dos segundos algo que normalmente toma un capítulo.

**Restricciones de calidad**: responsivo hasta móvil (el editor pasa a modo lectura/scroll en pantallas chicas), foco de teclado visible, `prefers-reduced-motion` respetado (los fasores se congelan y muestran el ángulo numérico).

---

## 11. Seguridad

- **Autenticación delegada a Supabase Auth**: hashing de contraseñas, OAuth de GitHub y Google, verificación de correo, recuperación y rotación de refresh tokens los maneja Supabase. El backend solo **verifica** el JWT entrante contra `SUPABASE_JWT_SECRET` y extrae el `sub` (UUID del usuario). No se implementa auth propia.
- **Credenciales de hardware** cifradas con AES-256-GCM; la llave maestra vive en variable de entorno o KMS, nunca en la base. El endpoint de lectura devuelve solo metadatos (proveedor, etiqueta, fecha), jamás el token.
- **Rate limiting** por IP y por usuario, más agresivo en `/simulate` y en autenticación.
- **Límites de recursos** en simulación de servidor: máximo de qubits, máximo de compuertas, timeout duro, y ejecución en un worker aislado que se puede matar.
- **Validación estricta con Zod** de todo circuito entrante, antes de tocar el motor. Un circuito malformado no debe poder provocar un bucle infinito ni una asignación de memoria gigante.
- **Sanitización** de contenido generado por usuarios (títulos, descripciones, comentarios) contra XSS; renderizado de markdown con lista blanca.
- **Embeds** servidos con CSP restrictiva y en modo solo lectura. La política
  es `default-src 'none'` con `script-src 'self'` (sin `'unsafe-inline'` y sin
  `'unsafe-eval'`), `form-action 'none'`, `base-uri 'none'` y
  `frame-ancestors *`. `style-src` sí lleva `'unsafe-inline'` y no puede
  evitarlo: el largo de una barra y el ángulo de un fasor son atributos `style`
  en línea, y un nonce no cubre un atributo. `connect-src` nombra un esquema
  (`'self' https:`) y no un host, porque el origen de la API es una variable de
  compilación que un archivo de cabeceras estático no puede nombrar; la
  alternativa estrecha fallaría cerrada justo en los despliegues sobre los que
  se equivoca. Las cabeceras viven en un solo módulo (`apps/web/src/embed/
headers.ts`) que el servidor de desarrollo lee directamente y contra el que un
  verificador compara `vercel.json`, porque una cabecera que solo se cumple en
  desarrollo no se cumple en ninguna parte.
- Circuitos `UNLISTED` con slug generado por `nanoid` de suficiente entropía; `PRIVATE` verificado siempre en servidor, nunca solo en el cliente.

---

## 12. Repositorio, infraestructura y despliegue

### 12.1 Cuántos repos y por qué

**Un solo repositorio: un monorepo con pnpm workspaces.**

La razón no es preferencia de estilo, es una restricción dura del proyecto: los paquetes `qsim` (motor de simulación) y `schema` (tipos y validadores) los consumen **tanto el frontend como el backend**, y tienen que ser exactamente la misma implementación. El cliente simula para dar retroalimentación instantánea; el servidor simula para validar retos de forma autoritativa. Si esas dos implementaciones divergen aunque sea en un signo, un usuario puede ver "resuelto" en su pantalla y "fallido" en el servidor, y el bug sería casi imposible de rastrear.

Separar en varios repos obligaría a publicar `qsim` como paquete privado en npm y a versionarlo en cada cambio, o a usar submódulos de git. Eso es fricción diaria a cambio de ningún beneficio, porque los tres despliegues (Vercel, Railway API, Railway worker) soportan sin problema apuntar a subdirectorios distintos del mismo repo.

**Excepción planeada, no ahora:** cuando `qsim` esté estable (fase 2 o 3), conviene extraerlo a su propio repositorio público y publicarlo en npm. Un motor de simulación cuántica en TypeScript con README serio, CI y tests es una pieza de portafolio por sí sola. Pero hacerlo mientras su API cambia a diario cuesta más de lo que rinde. Regla: extraer solo cuando pasen dos semanas sin cambios de API.

**Repositorios totales del proyecto:** 1 (más, opcionalmente, un segundo en fase avanzada para `qsim` como librería pública).

### 12.2 Estructura del monorepo

```
the-q-simulator/
├── pnpm-workspace.yaml
├── package.json              # scripts raíz + devDependencies compartidas
├── turbo.json                # orquestación de builds y caché
├── tsconfig.base.json        # config de TS que heredan todos los paquetes
├── .env.example
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── e2e.yml
├── apps/
│   ├── web/                  # React + Vite          → Vercel
│   ├── api/                  # Fastify               → Railway (servicio 1)
│   └── worker/               # BullMQ                → Railway (servicio 2)
├── packages/
│   ├── qsim/                 # motor de simulación   (compartido)
│   ├── schema/               # tipos + Zod           (compartido)
│   ├── qasm/                 # parser OpenQASM       (compartido)
│   ├── db/                   # Prisma client + schema (api + worker)
│   └── config/               # eslint, tsconfig, tailwind preset
└── docs/
    └── especificacion.md
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### 12.3 Reglas de dependencia entre paquetes

Esta es la disciplina que mantiene sano el monorepo. Las flechas indican "puede importar de":

```
apps/web    ──►  packages/qsim, schema, qasm, config
apps/api    ──►  packages/qsim, schema, qasm, db, config
apps/worker ──►  packages/qsim, schema, db, config

packages/qsim   ──►  (nada; cero dependencias)
packages/schema ──►  zod
packages/qasm   ──►  packages/schema
packages/db     ──►  packages/schema, prisma
```

Reglas que no se rompen:

1. **`packages/*` nunca importa de `apps/*`.** Si un paquete necesita algo de una app, ese algo está en el lugar equivocado.
2. **Los paquetes compartidos no tocan DOM ni React ni Node APIs.** `qsim` debe correr idéntico en un Web Worker del navegador y en un proceso de Node. Nada de `window`, nada de `fs`.
3. **`apps/web` nunca importa `packages/db`.** El frontend no habla con Postgres; habla con la API.
4. **Las apps no se importan entre sí.** Si `api` y `worker` comparten lógica, esa lógica sube a un paquete.

Vale la pena hacer cumplir esto con `eslint-plugin-boundaries` o con las restricciones de `dependency-cruiser` en CI, porque en un monorepo estas violaciones se cuelan solas.

### 12.4 Mapa de despliegue

| Servicio                            | Plataforma          | Root directory | Comando de build                   | Comando de arranque   |
| ----------------------------------- | ------------------- | -------------- | ---------------------------------- | --------------------- |
| Frontend                            | Vercel              | `apps/web`     | `pnpm turbo build --filter=web`    | (estático)            |
| API                                 | Railway             | `apps/api`     | `pnpm turbo build --filter=api`    | `node dist/server.js` |
| Worker                              | Railway             | `apps/worker`  | `pnpm turbo build --filter=worker` | `node dist/worker.js` |
| PostgreSQL                          | Supabase            | —              | —                                  | —                     |
| Redis                               | Railway (o Upstash) | —              | —                                  | —                     |
| Auth                                | Supabase Auth       | —              | —                                  | —                     |
| Almacenamiento (avatares, previews) | Supabase Storage    | —              | —                                  | —                     |
| Observabilidad                      | Sentry + pino       | —              | —                                  | —                     |

**Watch paths.** Configura cada servicio para que solo se redespliegue cuando cambian sus rutas relevantes; si no, cada commit rebuildea las tres apps.

- Vercel → `apps/web/**`, `packages/qsim/**`, `packages/schema/**`, `packages/qasm/**`
- Railway API → `apps/api/**`, `packages/**`
- Railway worker → `apps/worker/**`, `packages/**`

**Instalación en monorepo.** Tanto Vercel como Railway deben ejecutar `pnpm install` desde la **raíz**, no desde el subdirectorio, o no resolverán los workspaces. En Vercel se configura el Install Command en `pnpm install --frozen-lockfile` con "Include files outside the root directory" activado. En Railway conviene un `nixpacks.toml` o un Dockerfile por servicio que copie la raíz completa.

### 12.5 Variables de entorno

Ninguna variable vive en el repo. `.env.example` documenta la forma; los valores viven en Vercel, Railway y Supabase.

**`apps/web` (Vercel) — todo esto es público por diseño:**

```bash
VITE_API_URL=
VITE_WS_URL=
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=      # sb_publishable_...
VITE_SENTRY_DSN=
```

Cualquier variable con prefijo `VITE_` termina dentro del bundle y es visible para cualquiera. Nunca debe aparecer ahí una llave secreta.

**`apps/api` (Railway):**

```bash
NODE_ENV=production
PORT=8080
WEB_URL=                            # origen permitido para CORS
DATABASE_URL=                       # pooler de Supabase, puerto 6543, ?pgbouncer=true&connection_limit=1
DIRECT_URL=                         # conexión directa, puerto 5432, solo para migraciones
SUPABASE_URL=
SUPABASE_SECRET_KEY=                # sb_secret_... — jamás al frontend
SUPABASE_JWT_SECRET=                # para verificar los JWT de usuario
REDIS_URL=
ENCRYPTION_KEY=                     # 32 bytes base64: openssl rand -base64 32
SENTRY_DSN=
```

**`apps/worker` (Railway):** las mismas menos `PORT` y `WEB_URL`.

**Credenciales que NO viven en variables de entorno:**

- Los Client ID y Client Secret de GitHub y Google se cargan en el dashboard de Supabase (Authentication → Providers). El código nunca los ve.
- Los tokens de IBM Quantum los aporta cada usuario y se guardan cifrados en la tabla `HardwareCredential`. No existe una credencial de hardware a nivel proyecto.

### 12.6 Prisma con Supabase

Supabase enruta las conexiones a través de un pooler, y `prisma migrate` no funciona a través de él. Por eso se necesitan dos URLs:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // pooler, puerto 6543
  directUrl = env("DIRECT_URL")     // directa, puerto 5432
}
```

`DATABASE_URL` debe llevar `?pgbouncer=true&connection_limit=1`. Sin eso, Prisma intenta usar prepared statements que pgBouncer en modo transacción no soporta, y aparecen errores intermitentes muy difíciles de diagnosticar.

Prisma administra **solo el esquema `public`**. El esquema `auth` es de Supabase y no debe incluirse en las migraciones.

### 12.7 Flujo de trabajo con git

- **Ramas**: `main` siempre desplegable. Trabajo en ramas `feat/...`, `fix/...`, `chore/...`. Sin rama `develop`; no aporta nada con un solo desarrollador.
- **Commits**: Conventional Commits con scope de paquete — `feat(qsim): add controlled gate support`, `fix(web): correct bloch vector sign`. El scope hace que el historial del monorepo siga siendo legible.
- **PRs**: aunque trabajes solo, abre PR contra `main`. Da preview deploy en Vercel y ejecuta el CI antes de mezclar. Además el historial de PRs es material de portafolio.
- **Convención de idioma**: código, comentarios, docstrings, README y mensajes de commit en **inglés**. Este documento y las notas internas, en español.

### 12.8 CI (GitHub Actions)

**`ci.yml`** — en cada push y PR:

1. `pnpm install --frozen-lockfile`
2. `pnpm turbo lint typecheck test --filter=...[origin/main]` — el filtro hace que solo se prueben los paquetes afectados por el cambio y sus dependientes.
3. `pnpm turbo build` para verificar que todo compila.
4. Verificación de límites de dependencias entre paquetes.

**`e2e.yml`** — solo en `main`: levanta Postgres efímero en un service container, aplica migraciones y corre Playwright.

Los tests de `packages/qsim` son los que más importan y deben correr en **cada** cambio, sin importar el filtro: un error de física no lanza excepción, simplemente devuelve el resultado equivocado en silencio.

**Migraciones**: se aplican como paso de despliegue en Railway (`prisma migrate deploy`) antes de arrancar el servidor, usando `DIRECT_URL`.

### 12.9 Desarrollo local

```bash
pnpm install
pnpm db:push          # aplica el esquema a una DB de desarrollo de Supabase
pnpm dev              # levanta web + api + worker en paralelo con turbo
```

Conviene un proyecto de Supabase separado para desarrollo (el tier gratuito permite varios) en lugar de compartir la base de producción. Redis local con Docker.

---

## 13. Estrategia de pruebas

- **Motor (`qsim`)**: es la parte donde los tests importan más, porque los errores son silenciosos — un signo equivocado no lanza excepción, solo da física incorrecta. Verificar contra resultados analíticos conocidos:
  - Bell: `[1/√2, 0, 0, 1/√2]`
  - GHZ de 3 qubits: `[1/√2, 0, 0, 0, 0, 0, 0, 1/√2]`
  - Grover con 3 qubits: probabilidad del elemento marcado > 0.94 tras 2 iteraciones
  - Teletransportación: fidelidad 1.0 para estados de entrada aleatorios
  - Identidades: `H·H = I`, `X·Y·Z = iI`, `T⁸ = I`
  - Normalización preservada tras cada compuerta (dentro de tolerancia de punto flotante)
- **Propiedad (property-based)**: para unitarias aleatorias, verificar que la norma se conserva y que aplicar `U` seguido de `U†` regresa al estado inicial.
- **Round-trip de QASM**: JSON → QASM → JSON produce un circuito equivalente.
- **API**: tests de integración con base de datos efímera.
- **E2E**: arrastrar H + CNOT y verificar que el histograma muestra dos barras de 50%.

---

## 14. Roadmap por fases

### Fase 0 — Núcleo jugable (el MVP demostrable)

Motor de statevector en TS, editor con compuertas básicas, histograma y tabla de amplitudes, presets de Bell y GHZ. Sin cuentas, sin backend: todo en el navegador, estado del circuito serializado en la URL. **Ya es demostrable ante cualquiera.**

### Fase 1 — Producto real

Backend + Postgres + auth. Guardar, versionar, galería pública, forks, estrellas. Esferas de Bloch. Exportar a QASM y Qiskit. Compartir por URL.

### Fase 2 — Profundidad técnica

Modo ruido con matriz de densidad. Simulación en servidor con cola para circuitos grandes. Compuertas personalizadas y subcircuitos. Q-sphere y métricas de entrelazamiento. Importar QASM.

### Fase 3 — Aprendizaje

Lecciones guiadas. Modo reto con validación en servidor y tablas de posiciones. Embeds para docentes.

### Fase 4 — Hardware y escala

Integración con IBM Quantum. Vista comparativa ideal/ruido/real. Motor en WASM (Rust). API pública con API keys.

### Fase 5 — Colaboración

Edición en tiempo real con CRDT (Yjs), cursores compartidos, comentarios anclados a compuertas específicas.

Para el entregable de trabajo, **Fase 0 + Fase 1 ya constituyen una app completa y defendible**. Lo demás es crecimiento natural.

---

## 15. Qué necesitas saber en cada módulo

| Módulo                   | Teoría requerida                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Statevector y compuertas | Álgebra lineal compleja, producto tensorial, unitariedad, matrices de las compuertas estándar                                          |
| Kernel de aplicación     | Indexación por bits, cómo el bit _t_ del índice mapea al qubit _t_, orden endian (documéntalo explícitamente: es la fuente #1 de bugs) |
| Medición                 | Regla de Born, colapso, probabilidades marginales, renormalización                                                                     |
| Esfera de Bloch          | Parametrización (θ, φ), traza parcial, matriz de densidad reducida, fase global vs. relativa                                           |
| Entrelazamiento          | Estados producto vs. entrelazados, entropía de von Neumann, concurrencia                                                               |
| Ruido                    | Formalismo de operadores de Kraus, canales cuánticos, T1/T2, fidelidad                                                                 |
| QASM                     | Gramática de OpenQASM 3, mapeo a tu representación interna                                                                             |
| Hardware                 | Transpilación, conectividad de qubits, gate set nativo, mitigación de error básica                                                     |

El orden en que los necesitas coincide con el orden de las fases, así que el proyecto te va enseñando en secuencia.

---

## 16. Riesgos y decisiones abiertas

1. **Alcance.** Este documento describe una visión de varios meses. El riesgo real es intentar la Fase 3 antes de terminar la Fase 0. Recomendación: congelar el alcance de la Fase 0 por escrito y no tocarlo hasta que esté desplegada.
2. **Orden de bits (endianness).** Qiskit usa convención little-endian, donde el qubit 0 es el bit menos significativo. Si tu motor usa otra convención, la exportación a Qiskit dará resultados invertidos y será un bug muy confuso de rastrear. Decídelo el primer día y ponlo en el README.
3. **Precisión de punto flotante.** Con Float64 y circuitos largos, la norma se aleja de 1. Renormalizar periódicamente y usar tolerancias explícitas en los tests (`1e-10`).
4. **Costo de hardware real.** El plan abierto de IBM tiene minutos limitados por mes. Que cada usuario traiga su propio token evita que ese costo caiga sobre el proyecto.
5. **Trampa en retos.** Por eso la validación es autoritativa en el servidor, con el mismo motor compartido.
6. **Móvil.** Un editor de arrastrar y soltar en pantalla de 380px es difícil. Decisión propuesta: en móvil, modo lectura + interacción por toque (tocar celda → elegir compuerta), no arrastre.

---

## 17. Dónde la implementación eligió distinto de esta especificación

Este documento se escribió antes del código y en tres lugares el código tenía
razón. Se registran aquí, con el argumento, en vez de corregir el texto de arriba
en silencio: alguien que lea la sección original merece encontrar el desacuerdo y
no una versión limpia de la historia. En los tres casos la autoridad es el código
citado.

1. **La galería pagina por cursor, no por número de página.** §8 escribe
   `GET /gallery?…&cursor=&limit=` en la tabla de rutas y `?page=` en la prosa que
   la acompaña; el código implementa un _keyset_ y la autoridad es
   `GalleryCursor` en `@qsim/db` con el argumento en la cabecera de
   `apps/api/src/routes/gallery.ts`. El orden por omisión es una columna que otras
   personas cambian mientras alguien lee —las estrellas— y un desplazamiento
   dentro de un orden que se mueve repite o se salta filas sin decirlo: quien
   pasa a la página 2 ve otra vez un circuito que subió, o nunca ve el que bajó.
   Un cursor pregunta algo estable («lo siguiente después de _esta_ fila en _este_
   orden»), y por eso también es lo que se le devuelve al cliente en lugar de un
   número. Un cursor que no decodifica se contesta con 400 y no ignorando: servir
   la página 1 a quien pidió la 4 es la misma clase de mentira silenciosa.

2. **Los JWT de usuario se verifican contra un JWKS público, no contra un
   secreto compartido.** §11 dice «verifica el JWT entrante contra
   `SUPABASE_JWT_SECRET`» y §12 lo lista en el `.env`; eso es el esquema
   simétrico HS256 heredado y este proyecto no lo usa. Supabase firma con una
   clave asimétrica —ES256 sobre la curva P-256— y publica la mitad **pública**
   en `SUPABASE_JWKS_URL`. La diferencia no es cosmética y es la razón por la que
   el texto de §11 **no debe «arreglarse» de vuelta**: bajo HS256 la clave que
   verifica un token es la clave que acuña uno, así que quien pueda leer el
   entorno de la API —un log de `process.env`, un artefacto de build filtrado, una
   sesión de dashboard comprometida— puede falsificar un token de cualquier
   usuario. Bajo ES256 la API no sostiene nada capaz de firmar. La autoridad es
   `apps/api/src/auth/jwks.ts`, que además acota el refetch para que un `kid`
   desconocido no convierta a cualquiera en un amplificador de tráfico contra el
   endpoint del que depende autenticar a todo el mundo.

3. **El transpilador se niega en vez de enrutar.** §14 pide transpilación para la
   Fase 4 y §15 la nombra como teoría requerida; lo que ninguno dice es qué hacer
   cuando el grafo de interacción del circuito no cabe en el mapa de acoplamiento
   del dispositivo. La respuesta de libro es insertar SWAPs. Este proyecto
   **rechaza el circuito y dice qué necesitaría**, y la autoridad es
   `packages/transpile/src/placement.ts`. Un SWAP son tres CNOT y un CNOT es la
   instrucción más ruidosa que hace el dispositivo, así que un enrutador ingenuo
   convierte una demostración en ruido y no se lo cuenta a nadie: el circuito
   «corre», el resultado no significa nada, y la persona que lo mira no tiene
   forma de saber en qué momento dejó de significar algo. Un Heron ofrece el
   1.46 % de la conectividad que supone un circuito dibujado, así que esto no es
   un caso raro. Una negativa que nombra lo que el circuito pide y lo que el
   dispositivo tiene dice algo verdadero sobre la era NISQ; un resultado ruidoso
   presentado como resultado, no.

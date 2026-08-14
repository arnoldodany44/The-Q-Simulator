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

| Persona | Qué busca | Qué le da The Q Simulator |
|---|---|---|
| **Estudiante de cuántica** | Entender qué hace realmente una compuerta | Simulación en vivo + visualizaciones + lecciones guiadas |
| **Desarrollador curioso** | Probar sin instalar nada | Editor en el navegador, cero setup, exportar a Qiskit cuando quiera profundizar |
| **Docente** | Material para clase | Circuitos públicos con URL, modo presentación, embeds |
| **Practicante NISQ** | Comparar ideal vs. ruido vs. hardware | Modo ruido y ejecución en IBM Quantum |

El trabajo principal de la página de inicio: **que alguien que nunca ha visto un circuito cuántico entienda, en menos de un minuto, qué es la superposición y qué es el entrelazamiento.**

---

## 3. Alcance funcional

### 3.1 Editor de circuitos

- Lienzo con N qubits (1–20 en cliente, hasta 28 en servidor) y columnas de tiempo (*moments*).
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

### 3.2 Panel de análisis (en vivo, mientras editas)

- **Histograma de probabilidades** de los estados base, con las barras coloreadas por la fase de la amplitud.
- **Tabla de amplitudes**: `|estado⟩ → a + bi`, magnitud, probabilidad, fase en radianes y grados.
- **Esferas de Bloch por qubit**, calculadas desde la matriz de densidad reducida. Detalle importante: cuando un qubit está entrelazado, su vector de Bloch se acorta (queda dentro de la esfera). Eso convierte al visualizador en un detector visual de entrelazamiento.
- **Q-sphere**: representación de todo el estado en una sola esfera, con radio proporcional a la amplitud y color por fase.
- **Métricas de entrelazamiento**: entropía de von Neumann de cada subsistema y concurrencia para pares de qubits.
- **Matriz de densidad** (modo avanzado): mapa de calor de la parte real e imaginaria.
- **Muestreo con shots**: histograma de conteos empíricos, configurable de 1 a 100,000 shots, con comparación contra la distribución teórica.

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
- **Edición colaborativa en tiempo real** (fase avanzada): dos personas editando el mismo circuito, con CRDT y cursores visibles.

### 3.5 Interoperabilidad

- **Exportar**: OpenQASM 3, código Python de Qiskit, JSON nativo, PNG/SVG del diagrama, PDF.
- **Importar**: OpenQASM 2 y 3, JSON nativo.
- **API pública** con API keys: crear circuitos, correr simulaciones y consultar resultados desde fuera.

### 3.6 Aprendizaje

- **Lecciones guiadas**: recorridos interactivos que combinan texto, circuito precargado y objetivos. Cubren: superposición, entrelazamiento, interferencia, Deutsch–Jozsa, Grover, teletransportación, codificación superdensa, BB84, QPE.
- **Modo reto**: se te da un estado objetivo (o una tabla de verdad) y debes construir el circuito que lo produce. Validación en el servidor comparando fidelidad contra el objetivo, con umbral configurable y límite opcional de compuertas.
- **Tabla de posiciones** por reto: menor número de compuertas, menor profundidad.

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

Un sistema de *n* qubits vive en un espacio de 2ⁿ dimensiones. El estado es un vector de 2ⁿ amplitudes complejas:

```
|ψ⟩ = Σ aᵢ |i⟩,   con Σ |aᵢ|² = 1
```

En memoria se guarda como **dos `Float64Array` paralelos** (parte real y parte imaginaria) en lugar de un arreglo de objetos. Esto evita presión sobre el recolector de basura y permite usar `SharedArrayBuffer` entre el hilo principal y el worker.

Consumo de memoria: `2ⁿ × 16 bytes`.

| Qubits | Amplitudes | Memoria |
|---|---|---|
| 10 | 1,024 | 16 KB |
| 16 | 65,536 | 1 MB |
| 20 | 1,048,576 | 16 MB |
| 24 | 16,777,216 | 256 MB |
| 28 | 268,435,456 | 4 GB |

De ahí salen los límites: ~20 qubits es cómodo en navegador, ~28 es el techo razonable en servidor.

### 5.2 Aplicación de compuertas (lo importante)

La forma ingenua de aplicar una compuerta a un qubit dentro de un sistema de *n* qubits es construir la matriz completa con productos de Kronecker:

```
I ⊗ I ⊗ H ⊗ I  →  matriz de 2ⁿ × 2ⁿ
```

**No hagas eso.** Esa matriz tiene 4ⁿ entradas y es casi toda ceros. Aplicarla cuesta O(4ⁿ).

El enfoque correcto es actualizar el statevector **en sitio, por pares de índices**. Aplicar una compuerta de 1 qubit al qubit *t* significa recorrer todos los índices donde el bit *t* vale 0, emparejarlos con el índice donde ese bit vale 1, y aplicar la matriz 2×2 a ese par:

```ts
const stride = 1 << target;
for (let base = 0; base < size; base += stride << 1) {
  for (let offset = 0; offset < stride; offset++) {
    const i0 = base + offset;        // bit target = 0
    const i1 = i0 + stride;          // bit target = 1
    // [a0', a1'] = M · [a0, a1]
  }
}
```

Costo: **O(2ⁿ)** por compuerta, sin asignar memoria adicional. Un circuito de 20 qubits con 200 compuertas son ~200 millones de operaciones: fracciones de segundo.

Para compuertas controladas, la única diferencia es saltar los índices donde el bit de control no cumple la condición. Para compuertas de 2 qubits sin estructura de control, se agrupan cuatro índices en lugar de dos.

### 5.3 Medición

**Probabilidades**: regla de Born, `P(i) = |aᵢ|²`. Para la probabilidad marginal de un qubit, se suman las probabilidades de todos los estados base donde ese bit vale 1.

**Muestreo de shots**: se construye la distribución acumulada una vez y se muestrea con búsqueda binaria — O(2ⁿ + shots·n). Para volúmenes altos de shots conviene el método *alias* (O(1) por muestra).

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

Para dibujar la esfera de Bloch del qubit *q* en un sistema entrelazado, se calcula la traza parcial sobre los demás qubits para obtener ρ_q (2×2), y de ahí:

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
  "parameters": [
    { "name": "theta", "value": 0.7853981634 }
  ],
  "operations": [
    { "id": "op_1", "gate": "h",  "targets": [0], "column": 0 },
    { "id": "op_2", "gate": "cx", "targets": [2], "controls": [1], "column": 1 },
    {
      "id": "op_3",
      "gate": "rz",
      "targets": [0],
      "params": ["theta"],
      "column": 2
    },
    {
      "id": "op_4",
      "gate": "measure",
      "targets": [0],
      "clbitTargets": [0],
      "column": 3
    },
    {
      "id": "op_5",
      "gate": "x",
      "targets": [2],
      "column": 4,
      "condition": { "clbit": 0, "equals": 1 }
    }
  ],
  "customGates": {
    "bellPair": {
      "qubits": 2,
      "operations": [ /* ... */ ]
    }
  }
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
GET    /gallery?sort=stars|recent&tag=&q=&page=
GET    /users/:username/circuits
```

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
GET    /challenges/:slug/leaderboard
```

**Interoperabilidad**

```
POST   /convert/qasm-to-json
POST   /convert/json-to-qasm
POST   /convert/json-to-qiskit
```

**WebSocket** en `/ws`: eventos `run:progress`, `run:complete`, `job:status`, y canal de colaboración `circuit:<id>`.

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
hue = fase · 180/π      color = hsl(hue, 85%, 62%)
```

De esa fórmula salen los cuatro anclajes:

| Fase | Color |
|---|---|
| 0 | `#F5445E` |
| π/2 | `#7BE04A` |
| π | `#33D6D6` |
| 3π/2 | `#A24AE0` |

**Paleta de interfaz** (fría, de laboratorio criogénico, para que los colores de fase resalten):

```
--bg-deep     #0B0E1F
--bg-panel    #141833
--bg-elevated #1C2145
--wire        #3A4170
--text        #E8EAF6
--text-muted  #8B93C4
--accent      #5AC8FA
```

**Tipografía**

- Display: **Space Grotesk** — geométrica con letras ligeramente extrañas, técnica sin ser fría.
- Cuerpo: **Inter**.
- Datos y código: **IBM Plex Mono** — un guiño deliberado al linaje de IBM Quantum, y necesaria para alinear tablas de amplitudes.

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
- **Embeds** servidos con CSP restrictiva y en modo solo lectura.
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
  - "apps/*"
  - "packages/*"
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

| Servicio | Plataforma | Root directory | Comando de build | Comando de arranque |
|---|---|---|---|---|
| Frontend | Vercel | `apps/web` | `pnpm turbo build --filter=web` | (estático) |
| API | Railway | `apps/api` | `pnpm turbo build --filter=api` | `node dist/server.js` |
| Worker | Railway | `apps/worker` | `pnpm turbo build --filter=worker` | `node dist/worker.js` |
| PostgreSQL | Supabase | — | — | — |
| Redis | Railway (o Upstash) | — | — | — |
| Auth | Supabase Auth | — | — | — |
| Almacenamiento (avatares, previews) | Supabase Storage | — | — | — |
| Observabilidad | Sentry + pino | — | — | — |

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

| Módulo | Teoría requerida |
|---|---|
| Statevector y compuertas | Álgebra lineal compleja, producto tensorial, unitariedad, matrices de las compuertas estándar |
| Kernel de aplicación | Indexación por bits, cómo el bit *t* del índice mapea al qubit *t*, orden endian (documéntalo explícitamente: es la fuente #1 de bugs) |
| Medición | Regla de Born, colapso, probabilidades marginales, renormalización |
| Esfera de Bloch | Parametrización (θ, φ), traza parcial, matriz de densidad reducida, fase global vs. relativa |
| Entrelazamiento | Estados producto vs. entrelazados, entropía de von Neumann, concurrencia |
| Ruido | Formalismo de operadores de Kraus, canales cuánticos, T1/T2, fidelidad |
| QASM | Gramática de OpenQASM 3, mapeo a tu representación interna |
| Hardware | Transpilación, conectividad de qubits, gate set nativo, mitigación de error básica |

El orden en que los necesitas coincide con el orden de las fases, así que el proyecto te va enseñando en secuencia.

---

## 16. Riesgos y decisiones abiertas

1. **Alcance.** Este documento describe una visión de varios meses. El riesgo real es intentar la Fase 3 antes de terminar la Fase 0. Recomendación: congelar el alcance de la Fase 0 por escrito y no tocarlo hasta que esté desplegada.
2. **Orden de bits (endianness).** Qiskit usa convención little-endian, donde el qubit 0 es el bit menos significativo. Si tu motor usa otra convención, la exportación a Qiskit dará resultados invertidos y será un bug muy confuso de rastrear. Decídelo el primer día y ponlo en el README.
3. **Precisión de punto flotante.** Con Float64 y circuitos largos, la norma se aleja de 1. Renormalizar periódicamente y usar tolerancias explícitas en los tests (`1e-10`).
4. **Costo de hardware real.** El plan abierto de IBM tiene minutos limitados por mes. Que cada usuario traiga su propio token evita que ese costo caiga sobre el proyecto.
5. **Trampa en retos.** Por eso la validación es autoritativa en el servidor, con el mismo motor compartido.
6. **Móvil.** Un editor de arrastrar y soltar en pantalla de 380px es difícil. Decisión propuesta: en móvil, modo lectura + interacción por toque (tocar celda → elegir compuerta), no arrastre.

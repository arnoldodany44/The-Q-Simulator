# Desplegar la API en Railway (M1.8)

Lo que hay que hacer en el dashboard de Railway, y por qué. Todo lo que se puede
resolver desde el repositorio ya está en `railway.json`; esto es lo que solo se
puede hacer desde su interfaz.

---

## 1. Ajustes del servicio

**Root Directory: déjalo VACÍO.**

Es contraintuitivo y es la trampa clásica de los monorepos. Si lo pones en
`apps/api`, Railway ejecuta `pnpm install` dentro de esa carpeta, donde no hay
`pnpm-workspace.yaml`, y no resuelve `@qsim/core`, `@qsim/schema`, `@qsim/db` ni
`@qsim/contract`. El build falla con un error que habla de paquetes que no
existen en npm, y la causa real —el directorio raíz— no aparece por ningún lado.

`railway.json` ya lleva el comando de build filtrado con turbo, así que la
instalación pasa por la raíz y solo se construye lo que la API necesita.

**Wait for CI: enciéndelo.**

Con `main` como rama de producción, sin esto Railway despliega aunque GitHub
Actions esté en rojo.

**Auto deploys: enciéndelo cuando este documento deje de ser necesario**, es
decir, cuando `apps/api` exista en `main`. Antes de eso cada push produce un
build fallido que no significa nada.

---

## 2. Variables de entorno

Cópialas desde tu `.env` local, salvo las tres que cambian de valor en
producción. **Ninguna pasa por el repositorio.**

| Variable              | Valor                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `production`                                                                                 |
| `PORT`                | déjala sin definir — Railway la inyecta                                                      |
| `HOST`                | `0.0.0.0`                                                                                    |
| `WEB_URL`             | `https://the-q-simulator.vercel.app`                                                         |
| `TRUST_PROXY`         | `1`                                                                                          |
| `DATABASE_URL`        | igual que en local (pooler de transacciones, 6543, con `?pgbouncer=true&connection_limit=1`) |
| `DIRECT_URL`          | igual que en local (pooler de sesión, 5432)                                                  |
| `SUPABASE_URL`        | igual que en local                                                                           |
| `SUPABASE_JWKS_URL`   | igual que en local                                                                           |
| `SUPABASE_SECRET_KEY` | igual que en local                                                                           |
| `REDIS_URL`           | igual que en local — hace falta desde la Fase 2                                              |
| `ENCRYPTION_KEY`      | igual que en local                                                                           |

### Las tres que cambian, y por qué

**`WEB_URL`** es la lista de orígenes que CORS acepta, y es una lista exacta, no
un comodín. Si queda en `http://localhost:5173`, el navegador bloquea cada
petición desde el sitio publicado y el error habla de CORS sin decir que la
variable está mal.

**`TRUST_PROXY=1`** decide qué considera la API que es `request.ip`, y ese valor
es la clave del límite de peticiones para cada visitante anónimo. Detrás del
borde de Railway tiene que ser exactamente `1` —un salto—: en `false` todos los
anónimos comparten la dirección del proxy y el límite por IP se convierte en uno
global que cualquiera puede agotar para todos. En `true` se confía en toda la
cadena reenviada y cualquiera puede inventarse una identidad nueva por petición.

**`PORT`** la inyecta Railway. Definirla a mano es la forma más común de que el
healthcheck falle: el servicio escucha en un puerto y el balanceador pregunta en
otro.

---

## 3. Después del primer despliegue

`railway.json` corre `prisma migrate deploy` antes de arrancar el servidor.
`migrate deploy` solo aplica migraciones hacia adelante y **nunca** reinicia la
base, que es la razón de que sea seguro tenerlo en el arranque con una sola base
compartida entre desarrollo y producción.

Comprueba, en este orden:

1. `GET /health` responde `200` con `database.reachable: true`
2. `GET /api/v1/gallery` responde `200`
3. `GET /api/v1/circuits` **sin token** responde `401`

El tercero es el que importa: si responde `200`, la verificación de tokens no
está funcionando y la API está abierta.

---

## 4. Y en Vercel

Añade `VITE_API_URL` apuntando al dominio que Railway asigne, y vuelve a
desplegar el frontend. Sin eso el sitio publicado sigue hablándole a
`http://localhost:8080`, que en el navegador de otra persona no existe.

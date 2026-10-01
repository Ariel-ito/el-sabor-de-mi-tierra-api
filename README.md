# El Sabor de Mi Tierra — API

Backend privado de la distribuidora de lácteos de Ariel y María José. NestJS 11, TypeScript, Prisma 6 y PostgreSQL. Es independiente de Leiras: repositorio, base de datos, usuarios y despliegue propios. La web de Leiras solo lo aloja bajo `/lacteos/*` (ver `leiras-kitchen-web/src/lacteos`).

Reglas de negocio acordadas: [`docs/domain-roadmap.md`](docs/domain-roadmap.md).

## Qué hace hoy

- **Catálogos:** clientes y proveedores con teléfono y código de país (por defecto `+504`); los proveedores tienen además un contacto de entrega. Productos con precio de venta, costo estimado y proveedor habitual.
- **Ciclos (rondas):** agrupan encargos. Un ciclo cerrado ya no acepta encargos nuevos ni ediciones. Cerrarlo no liquida el inventario ni las deudas.
- **Encargos:** cantidades en libras y medias libras. Cada línea es `PREORDER` (se compra al proveedor) o `STOCK` (se vende del inventario libre). Cada línea guarda su precio y su costo estimado del momento, así que cambiar el catálogo no altera encargos existentes. Si se envía `totalAmount`, se respeta ese total exacto y el precio unitario se deriva de él. Las ediciones requieren `version`.
- **Compras a proveedores:** una compra pertenece a un ciclo y a un proveedor. Puede recibirse en varias recepciones parciales, cada una con factura, descuento por libra y descuento global. El descuento global se reparte en centavos exactos por mayor residuo. Cada línea recibida es un **lote** con su costo efectivo. Una recepción del proveedor habitual actualiza el costo estimado del producto; las de proveedores alternos no.
- **Inventario por lote:** muestra por cada lote lo recibido, lo reservado, lo entregado, lo libre y lo que hay en existencia. Las reservas se asignan automáticamente al encargo más antiguo: las líneas `PREORDER` solo toman lotes de su ciclo, y las `STOCK` toman de cualquier ciclo. Las salidas que no son venta (`SAMPLE`, `PERSONAL`, `LOSS`) solo pueden usar libras libres.
- **Entregas:** un encargo puede tener varias entregas parciales, que consumen las reservas del lote más antiguo al más reciente. No se puede entregar producto que aún no se ha recibido, ni con fecha futura.
- **Pagos:** abonos en `CASH` o `TRANSFER`, sin superar el saldo pendiente. Anular un pago guarda el motivo y conserva el historial. Cada encargo expone `total`, `paid`, `balance`, `credit`, `paymentStatus` (`UNPAID/PARTIAL/PAID`) y `deliveryStatus` (`ORDERED/PARTIAL/DELIVERED`), que son independientes entre sí.
- **Lista para proveedores:** agrupa lo que falta comprar por proveedor (`pendingToBuy`), descontando lo ya reservado y lo ya pedido pero no recibido. Las líneas `STOCK` quedan fuera.
- **Estadísticas e historial de costos:** ventas, costo y ganancia **estimados**, margen, ranking de productos y clientes, en total y por ciclo. Si alguna línea no tiene costo, `estimatedProfit` queda en `null` y `partial` da la ganancia de las líneas con costo junto con su cobertura (`coverage`, en % de las ventas); nunca se toma un costo faltante como cero. Cobranza por período: `collected`, `outstanding`, `credit` y `debtors` (saldo pendiente por cliente, de mayor a menor). El historial de costos de un producto se construye con sus lotes.
- **Costo por ciclo y producto** (`costing` y `productCosts` en cada ciclo de `/statistics`): precio de venta, costo y margen por libra. Regla acordada en `src/costing.ts`: las libras con lote asignado usan el costo real de ese lote; las demás usan el costo promedio de compra del ciclo (mismo producto y proveedor) y, si no hubo compra, el costo estimado guardado en la línea. `costSources` indica cuántas libras salieron de cada fuente.

**Todavía no existe:** gastos operativos, ganancia real en la tarjeta de rentabilidad (sigue siendo estimada), devoluciones o saldo a favor gestionado, datos de conservación del lote (vencimiento, temperatura) ni recordatorios.

## Reglas técnicas

- Importes y cantidades viajan como **strings decimales**. Dinero en HNL, redondeo half-up a dos decimales por línea; el total es la suma de las líneas ya redondeadas.
- Fechas en ISO UTC; la interfaz las muestra en America/Tegucigalpa.
- Todo lo que toca inventario, encargos, entregas o pagos se hace en una transacción que toma un lock global (`pg_advisory_xact_lock`), lo que evita sobreventas entre ciclos.
- Compras, recepciones, entregas, pagos y salidas llevan un `id` UUID generado por el cliente: si se reintenta la misma operación, no se duplica.
- Una `version` desactualizada devuelve 409. Los cambios quedan en `AuditLog`, con quién los hizo y el antes y el después.

## Estructura de `src/`

| Archivo | Contenido |
|---|---|
| `app.ts`, `main.ts` | Módulo Nest y arranque (CORS, helmet, validación, Swagger) |
| `core.ts` | Cliente Prisma, `AuthGuard`, `audit()`, `lockRound()` |
| `errors.ts` | Filtro global de errores |
| `*.controller.ts` | Rutas por dominio: `health`, `auth`, `catalog`, `rounds` (con lista para proveedores y estadísticas), `orders` (con entregas y pagos), `purchases`, `inventory` |
| `inventory.ts`, `purchases.ts`, `math.ts` | Lógica sin HTTP: reservas, recepciones y descuentos, dinero, serialización y métricas |
| `dto.ts`, `security.ts` | Validación de entrada y hashing de contraseñas y tokens |

## Desarrollo local

Requisitos: Node 20.19+ o 22, y Docker.

```bash
cp .env.example .env          # completa POSTGRES_PASSWORD y la misma contraseña en DATABASE_URL
npm ci && npm run prisma:generate
docker compose up -d db       # Postgres propio en el puerto local 55433
npm run db:migrate            # con las variables de .env cargadas en el shell
npm run dev                   # API en http://localhost:4100, recarga al guardar
```

También puedes usar `docker compose up --build`, que migra y levanta la API. No uses `docker compose down -v` si quieres conservar los datos.

La web necesita `VITE_LACTEOS_API_URL=http://localhost:4100/api/v1`, y aquí `CORS_ORIGINS` debe incluir el origen exacto de la web (por defecto `http://localhost:5173`).

### Usuarios

No hay registro público ni usuarios predeterminados. Para crear uno, define `DATABASE_URL`, `USER_EMAIL`, `USER_NAME` y `USER_PASSWORD` (8–256 caracteres) y ejecuta `npm run user:create`. Si el correo ya existe, se rechaza; el comando no modifica usuarios existentes.

Las sesiones duran 8 horas y `logout` las revoca. El login se limita a 10 intentos por IP y por correo cada 15 minutos. Ese límite vive en memoria, así que solo sirve con **una réplica**.

## Endpoints

Prefijo `/api/v1`. Todo requiere `Authorization: Bearer <token>`, excepto `health` y `auth/login`. Las respuestas no llevan envoltorio; los errores tienen la forma `{statusCode, message}`.

| Área | Rutas |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| Catálogos | `GET/POST /customers`, `/suppliers`, `/products`; `PATCH /customers/:id`, `/suppliers/:id`, `/products/:id` |
| Ciclos | `GET/POST /rounds`, `PATCH /rounds/:id`, `GET /rounds/:id/purchase-summary` |
| Encargos | `GET /orders?roundId=`, `POST /orders`, `PATCH /orders/:id` |
| Entregas y pagos | `POST /orders/:id/deliveries`, `POST /orders/:id/payments`, `POST /orders/:id/payments/:paymentId/void` |
| Compras | `GET /purchases?roundId=`, `POST /purchases`, `PATCH /purchases/:id` (solo con el ciclo abierto; no baja ni quita lo ya recibido), `POST /purchases/:id/receipts` |
| Inventario | `GET /inventory`, `POST /inventory/withdrawals` |
| Reportes | `GET /statistics`, `GET /products/:id/cost-history` |
| Salud | `GET /health`, `GET /health/ready` (verifica PostgreSQL) |

Con `ENABLE_API_DOCS=true` se publica OpenAPI en `/api/docs` (y el JSON en `/api/docs-json`).

## Pruebas

```bash
npm run build && npm test     # decimales, redondeo, descuentos, estadísticas, contraseñas/tokens
```

Las pruebas HTTP necesitan una API corriendo contra una base **desechable** y un usuario QA creado en ella. Define `DAIRY_TEST_EMAIL`, `DAIRY_TEST_PASSWORD` y, si hace falta, `DAIRY_TEST_URL`. Ambos scripts rechazan hosts que no sean locales.

```bash
npm run test:integration      # test/integration.py: auth, concurrencia, rollback, precios históricos
```

```bash
npm run test:operations       # test/operations.py: inventario, reservas, entregas, pagos, sobreventa
```

`operations.py` apunta por defecto a `http://127.0.0.1:4101/api/v1`.

## Despliegue (Railway)

Proyecto propio en Railway, con su API y su PostgreSQL. Se construye con el `Dockerfile`. `railway.json` ejecuta `prisma migrate deploy` antes de cada despliegue y usa `/api/v1/health/ready` como healthcheck. Además, `scripts/start.sh` vuelve a migrar al arrancar.

Variables: `DATABASE_URL` (referencia al Postgres privado), `CORS_ORIGINS` con el dominio real (obligatorio en producción) y `TRUST_PROXY=1`. Railway proporciona `PORT`.

Para crear el primer usuario en producción, define temporalmente `BOOTSTRAP_ADMIN=1`, `USER_EMAIL`, `USER_NAME` y `USER_PASSWORD`. Después del primer arranque correcto, borra esas cuatro variables. La cuenta inicial acordada es `admin@lacteos.com` (`Administración`).

Haz un backup antes de cualquier migración destructiva.

## Notas de dependencias

- Prisma 6 usa un override `deepmerge-ts@8` para evitar un aviso de agotamiento de pila. Al actualizar Prisma, verifica que `prisma generate` y las migraciones sigan funcionando.
- Swagger arrastra un aviso moderado de `js-yaml` que todavía no tiene corrección. No afecta a esta API porque no procesa YAML y la documentación está desactivada por defecto.

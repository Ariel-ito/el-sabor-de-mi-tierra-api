# El Sabor de Mi Tierra — API

Backend privado de la distribuidora de lácteos de Ariel y María José. NestJS 11, TypeScript, Prisma 6 y PostgreSQL. Es independiente de Leiras: repositorio, base de datos, usuarios y despliegue propios. La web de Leiras solo lo aloja bajo `/lacteos/*` (ver `leiras-kitchen-web/src/lacteos`).

Reglas de negocio acordadas: [`docs/domain-roadmap.md`](docs/domain-roadmap.md).

## Qué hace hoy

- **Catálogos:** clientes y proveedores con teléfono y código de país (por defecto `+504`); los proveedores tienen además un contacto de entrega. Productos con precio de venta, costo estimado y proveedor habitual.
- **Ciclos (rondas):** agrupan encargos y compras. Un ciclo cerrado ya no acepta encargos nuevos ni ediciones. **Cierre guiado** (`GET /rounds/:id/closing`, `POST /rounds/:id/close`): se bloquea si hay encargos sin entregar, y cada libra libre comprada en el ciclo necesita destino (`LOSS`, `SAMPLE`, `PERSONAL` o `KEEP`), así el ciclo termina con su inventario en 0. Cerrar por `PATCH` solo funciona si no hay pendientes ni sobrante. Los cobros pueden seguir después del cierre.
- **Ventas sin encargo** (`GET/POST /sales`): venden producto libre de cualquier ciclo, con o sin ciclo abierto; se entregan al registrarse, el cobro es opcional (si no, queda como saldo) y cuentan en el ciclo del primer lote que consumen. Sin cliente se registran a "Cliente de paso". No se editan como encargos.
- **Encargos:** cantidades en libras y medias libras. Cada línea es `PREORDER` (se compra al proveedor) o `STOCK` (se vende del inventario libre). Cada línea guarda su precio y su costo estimado del momento, así que cambiar el catálogo no altera encargos existentes. Si se envía `totalAmount`, se respeta ese total exacto y el precio unitario se deriva de él. Las ediciones requieren `version`.
- **Envío:** cada encargo es `PICKUP` (retira el cliente, sin costo) o `DELIVERY` con `shippingFee` opcional (0 = gratis). El envío se suma a `total` y al saldo; `productTotal` es solo el producto. Por ciclo, `/statistics` da `shipping` (envíos acordados), `deliveries`, `fuel` (gastos de la categoría Transporte y combustible, `systemKey` `TRANSPORT`) y `expenses` (gastos de Contabilidad asignados al ciclo). `result` = `productResult` (ventas − costo − gasto absorbido) + envíos − gastos del ciclo.
- **Cuenta del cliente y cobranza** (`src/accounts.controller.ts`): `GET /collections` lista lo que debe cada cliente en todos los ciclos y su saldo a favor. La cuenta (`CustomerCredit`) suma anticipos (`DEPOSIT`) y pagos de más pasados desde un encargo (`OVERPAY`), y resta lo usado (`APPLY`, un pago `CREDIT` en el encargo) y lo devuelto (`REFUND`). Un abono con `excessToAccount` guarda el excedente como anticipo. En Contabilidad el dinero entra una sola vez: al recibir el anticipo (o el abono); los pagos `CREDIT` no cuentan como ingreso y las devoluciones restan.
- **Vencimiento:** cada producto puede tener `shelfLifeDays` (dura aproximadamente) y `warnDays` (avisar antes). Al recibir, cada lote guarda `expiresAt` = recepción + duración, o la fecha que se envíe en la línea (producto con fecha impresa); `PATCH /inventory/lots/:id/expiry` la corrige. `/inventory` agrega `daysLeft` (días calendario de Honduras) y `expiryStatus` (`OK`, `SOON` dentro de la ventana de aviso, `EXPIRED`). Sugerencias por tipo de lácteo: [`docs/vencimientos.md`](docs/vencimientos.md).
- **Unidades** (`src/units.ts`): cada producto se vende por `lb`, `unidad`, `bolsa`, `bote`, `botella`, `paquete`, `docena` o `carton`. Solo las libras admiten medias; en lo demás encargos, ventas, compras, recepciones, entregas, salidas y cierres exigen enteros. Precios y costos son por esa unidad. La unidad de un producto con encargos o compras no se cambia. Las estadísticas dan `quantityByUnit` (no se suman libras con bolsas) y los indicadores por libra del ciclo (`costing.unitPrice`, `marginPerLb`) cuentan solo productos por libra.
- **Compras a proveedores:** una compra pertenece a un ciclo y a un proveedor. Puede recibirse en varias recepciones parciales, cada una con factura, descuento por libra y descuento global. El descuento global se reparte en centavos exactos por mayor residuo. Cada línea recibida es un **lote** con su costo efectivo. Una recepción del proveedor habitual actualiza el costo estimado del producto; las de proveedores alternos no.
- **Inventario por lote:** muestra por cada lote lo recibido, lo reservado, lo entregado, lo libre y lo que hay en existencia. Las reservas se asignan automáticamente al encargo más antiguo: las líneas `PREORDER` solo toman lotes de su ciclo, primero de su proveedor y, si falta, del mismo producto comprado a otro proveedor del ciclo; las `STOCK` toman de cualquier ciclo. Las salidas que no son venta (`SAMPLE`, `PERSONAL`, `LOSS`) solo pueden usar libras libres.
- **Entregar en otro ciclo** (`POST /orders/:id/items/:itemId/carry`, `GET /orders/carried?roundId=`): cuando no se consigue un producto, lo pendiente de una línea `PREORDER` se surte con lotes de otro ciclo abierto (`fulfillRoundId`). La venta y los cobros siguen en el ciclo del encargo, con el costo real del lote del otro ciclo. Esa línea ya no impide cerrar su ciclo (sale en `carriedOut` del cierre), cuenta en la lista para proveedores del ciclo destino y bloquea el cierre de ese ciclo hasta entregarse. Con `roundId: null` vuelve a su ciclo, solo si sigue abierto.
- **Entregas:** un encargo puede tener varias entregas parciales, que consumen las reservas del lote más antiguo al más reciente. No se puede entregar producto que aún no se ha recibido, ni con fecha futura.
- **Pagos:** abonos en `CASH` o `TRANSFER`, sin superar el saldo pendiente. Anular un pago guarda el motivo y conserva el historial. Cada encargo expone `total`, `paid`, `balance`, `credit`, `paymentStatus` (`UNPAID/PARTIAL/PAID`) y `deliveryStatus` (`ORDERED/PARTIAL/DELIVERED`), que son independientes entre sí.
- **Lista para proveedores:** agrupa lo que falta comprar por proveedor (`pendingToBuy`), descontando lo ya reservado y lo ya pedido pero no recibido. Las líneas `STOCK` quedan fuera.
- **Estadísticas e historial de costos:** ventas, costo y ganancia **estimados**, margen, ranking de productos y clientes, en total y por ciclo. Si alguna línea no tiene costo, `estimatedProfit` queda en `null` y `partial` da la ganancia de las líneas con costo junto con su cobertura (`coverage`, en % de las ventas); nunca se toma un costo faltante como cero. Cobranza por período: `collected`, `outstanding`, `credit` y `debtors` (saldo pendiente por cliente, de mayor a menor). El historial de costos de un producto se construye con sus lotes.
- **Gasto absorbido** (`absorbed` y `result` en cada ciclo de `/statistics`): merma, muestras y consumo propio de los lotes del ciclo al costo real, lo que queda en existencia (no es gasto) y el resultado ventas − costo de lo vendido − gasto absorbido.
- **Costo por ciclo y producto** (`costing` y `productCosts` en cada ciclo de `/statistics`): precio de venta, costo y margen por libra. Regla acordada en `src/costing.ts`: las libras con lote asignado usan el costo real de ese lote; las demás usan el costo promedio de compra del ciclo (mismo producto y proveedor) y, si no hubo compra, el costo estimado guardado en la línea. `costSources` indica cuántas libras salieron de cada fuente.

- **Contabilidad** (`/finance/*`, lógica en `src/finance.ts`): categorías fijas de ingreso y gasto (las del sistema solo se renombran; una usada se desactiva en vez de borrarse; `inResult=false` para aportes, préstamos y repartos). El libro mezcla movimientos manuales con los automáticos: cada cobro no anulado es "Venta" y cada factura de proveedor es "Compra de producto". Un gasto pagado por un dueño de su bolsa se marca `REIMBURSE` (queda por devolver) o `CONTRIBUTE` (aporte que suma valor, no cambia la propiedad 50/50). Los gastos recurrentes generan solos un movimiento `PENDING` por período vencido; se marcan pagados o, al eliminarlos, quedan `SKIPPED`. Dueños fijos: Ariel Martínez y María Borjas, 50/50. El reparto crea dos movimientos con el mismo `groupId` y no puede superar la ganancia disponible (ganancia acumulada − repartido). Los meses se cuentan en hora de Honduras.

**Todavía no existe:** ganancia real en la tarjeta de rentabilidad (sigue siendo estimada), devoluciones o saldo a favor gestionado, datos de conservación del lote (vencimiento, temperatura) ni recordatorios.

## Reglas técnicas

- Importes y cantidades viajan como **strings decimales**. Dinero en HNL, redondeo half-up a dos decimales por línea; el total es la suma de las líneas ya redondeadas.
- Fechas en ISO UTC; la interfaz las muestra en America/Tegucigalpa.
- Todo lo que toca inventario, encargos, entregas o pagos se hace en una transacción que toma un lock global (`pg_advisory_xact_lock`), lo que evita sobreventas entre ciclos.
- Compras, recepciones, entregas, pagos y salidas llevan un `id` UUID generado por el cliente: si se reintenta la misma operación, no se duplica.
- Una `version` desactualizada devuelve 409. Los cambios quedan en `AuditLog`, con quién los hizo y el antes y el después.

## Estructura de `src/`

| Archivo                                                                             | Contenido                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`, `main.ts`                                                                 | Módulo Nest y arranque (CORS, helmet, validación, Swagger)                                                                                                                          |
| `core.ts`                                                                           | Cliente Prisma, `AuthGuard`, `audit()`, `lockRound()`                                                                                                                               |
| `errors.ts`                                                                         | Filtro global de errores                                                                                                                                                            |
| `*.controller.ts`                                                                   | Rutas por dominio: `health`, `auth`, `catalog`, `rounds` (con lista para proveedores y estadísticas), `orders` (con entregas y pagos), `purchases`, `inventory`, `sales`, `finance` |
| `inventory.ts`, `purchases.ts`, `math.ts`, `costing.ts`, `closing.ts`, `finance.ts` | Lógica sin HTTP: reservas, recepciones y descuentos, dinero, serialización y métricas                                                                                               |
| `dto.ts`, `security.ts`                                                             | Validación de entrada y hashing de contraseñas y tokens                                                                                                                             |

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

| Área               | Rutas                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth               | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`                                                                                                                                                                                                                                                                                                                                                                                          |
| Catálogos          | `GET/POST /customers`, `/suppliers`, `/products`; `PATCH /customers/:id`, `/suppliers/:id`, `/products/:id`                                                                                                                                                                                                                                                                                                                                      |
| Ciclos             | `GET/POST /rounds`, `PATCH /rounds/:id`, `GET /rounds/:id/purchase-summary`                                                                                                                                                                                                                                                                                                                                                                      |
| Encargos           | `GET /orders?roundId=`, `POST /orders`, `PATCH /orders/:id`                                                                                                                                                                                                                                                                                                                                                                                      |
| Entregas y pagos   | `POST /orders/:id/deliveries`, `POST /orders/:id/payments`, `POST /orders/:id/payments/:paymentId/void`                                                                                                                                                                                                                                                                                                                                          |
| Compras            | `GET /purchases?roundId=`, `POST /purchases`, `PATCH /purchases/:id` (solo con el ciclo abierto y antes de registrar factura; después, los cambios van en una compra adicional), `POST /purchases/:id/receipts`                                                                                                                                                                                                                                  |
| Inventario         | `GET /inventory`, `POST /inventory/withdrawals`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Ventas sin encargo | `GET /sales?roundId=`, `POST /sales` (con `roundId`: vende del inventario de ese ciclo), `PATCH /sales/:id`, `DELETE /sales/:id?version=` (solo con el ciclo abierto)                                                                                                                                                                                                                                                                            |
| Cierre de ciclo    | `GET /rounds/:id/closing`, `POST /rounds/:id/close`                                                                                                                                                                                                                                                                                                                                                                                              |
| Contabilidad       | `GET/POST /finance/categories`, `PATCH/DELETE /finance/categories/:id`, `GET /finance/ledger?month=AAAA-MM`, `POST /finance/movements`, `PATCH /finance/movements/:id`, `DELETE /finance/movements/:id?version=`, `POST /finance/movements/:id/pay`, `POST /finance/movements/:id/reimburse`, `GET/POST /finance/recurring`, `PATCH /finance/recurring/:id`, `POST /finance/distributions`, `GET /finance/summary?month=`, `GET /finance/owners` |
| Reportes           | `GET /statistics`, `GET /products/:id/cost-history`                                                                                                                                                                                                                                                                                                                                                                                              |
| Salud              | `GET /health`, `GET /health/ready` (verifica PostgreSQL)                                                                                                                                                                                                                                                                                                                                                                                         |

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

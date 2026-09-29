# El Sabor de Mi Tierra — API

Backend privado e independiente de Leiras: NestJS 11, TypeScript, Prisma 6 y PostgreSQL. No modifica la API ni la app móvil de Leiras. La web comparte alojamiento con Leiras, pero utiliza exclusivamente esta API dentro de `/lacteos`.

## Alcance funcional

Autenticación privada sin registro público; clientes, proveedores, productos, rondas, pedidos y resumen de compra por proveedor. Las cantidades aceptan medias libras; todos los importes y cantidades viajan como **strings decimales**. Dinero HNL, redondeo half-up a dos decimales por línea y total sumando líneas redondeadas. No se calculan ganancias realizadas: los resúmenes muestran **costos estimados** del catálogo actual.

Cada precio de venta queda guardado en su pedido. Cambiar el catálogo no cambia pedidos existentes. Ediciones requieren `version`; una versión desactualizada devuelve 409. Transacciones, bloqueo de ronda y auditoría con actor/antes/después protegen las modificaciones. Cerrar una ronda impide nuevos pedidos y ediciones, pero no elimina inventario ni liquida deudas. Recepciones, lotes, entregas y pagos pertenecen a la siguiente etapa; no hay estados de pago/entrega simulados.

## Desarrollo local

Requisitos: Node 20.19+ o Node 22, Docker Desktop activo.

1. `cp .env.example .env` y completa `POSTGRES_PASSWORD` con una contraseña aleatoria larga y segura para URL. Ajusta la misma contraseña dentro de `DATABASE_URL`. Nunca subas `.env`.
2. `npm ci && npm run prisma:generate`.
3. `docker compose up -d db` levanta una base **independiente**, puerto local 55433.
4. Carga las variables de `.env` en tu shell y ejecuta `npm run db:migrate`.
5. `npm run dev` compila con metadatos TypeScript y reinicia la API; carga `.env`. Escucha en 4100.

También puedes usar `docker compose up --build`: migra antes de iniciar API y publica únicamente puertos loopback. No uses `docker compose down -v` si deseas conservar datos.

Frontend: `VITE_LACTEOS_API_URL=http://localhost:4100/api/v1`. Configura `CORS_ORIGINS` con el origen exacto de la web (puerto incluido), separados por comas. Nunca reutilices la URL o sesión de Leiras.

## Usuarios privados

No existen cuentas ni contraseñas predeterminadas. Proporciona mediante entorno `DATABASE_URL`, `USER_EMAIL`, `USER_NAME` y `USER_PASSWORD` (8–256 caracteres); ejecuta `npm run user:create`. Introduce la contraseña mediante lectura oculta o un gestor de secretos; no la pongas en argumentos ni en historial. Ejecuta una vez para Ariel y una para María José. En contenedor: usa el mismo comando con las variables correspondientes. Emails duplicados se rechazan; no resetea usuarios existentes.

Contraseñas con scrypt y sal aleatoria; tokens aleatorios de 256 bits, solo su hash queda en PostgreSQL. Sesiones duran ocho horas y logout las revoca. Todas las rutas de negocio requieren Bearer. Login limita por IP y correo durante 15 minutos. El limitador es en memoria y está preparado para **una réplica**: antes de escalar se necesita almacenamiento compartido de límites y purga programada de sesiones vencidas. En Railway configura `TRUST_PROXY=1`; no confíes en proxies adicionales sin revisar esa configuración.

## Endpoints

Prefijo `/api/v1`. Respuestas directas, sin envoltorio `data`. Errores `{statusCode,message}`.

- `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`.
- `GET/POST /customers`, `/suppliers`, `/products`, `/rounds`, `/orders`.
- `PATCH /products/:id`, `/rounds/:id`, `/orders/:id`.
- `GET /orders?roundId=UUID`.
- `GET /rounds/:id/purchase-summary`.
- `GET /health` (proceso), `GET /health/ready` (conexión PostgreSQL).

Para explorar OpenAPI configura `ENABLE_API_DOCS=true` y abre `/api/docs` (`/api/docs-json` para JSON). Documentación desactivada por defecto; las rutas de negocio siguen protegidas independientemente del explorador. Fechas ISO UTC; la interfaz debe presentarlas en America/Tegucigalpa.

## Validación

`npm run build` y `npm test`. Para pruebas HTTP reales inicia una API contra una base local desechable, provisiona un usuario QA y define `DAIRY_TEST_EMAIL`, `DAIRY_TEST_PASSWORD` y opcionalmente `DAIRY_TEST_URL`; ejecuta `npm run test:integration`. Crea registros QA, prueba concurrencia, rollback, permisos, precios históricos y logout. Se rechazan hosts no locales. No usar con datos reales. Pruebas cubren decimales y redondeo, agrupación por proveedor, validación de cantidades y contraseñas/tokens. La migración inicial incluye relaciones y restricciones adicionales. Prisma 6 utiliza override compatible `deepmerge-ts@8` para corregir el aviso de agotamiento de pila de su dependencia de configuración; mantener verificación de `prisma generate` y migraciones al actualizar.

## Railway (aún sin desplegar)

Proyecto separado con API y PostgreSQL propios. Conecta este repo y usa el Dockerfile; `railway.json` aplica `prisma migrate deploy` como predeploy y comprueba `/api/v1/health/ready`. Configura `DATABASE_URL` mediante referencia a PostgreSQL privado, `CORS_ORIGINS` al dominio real y `TRUST_PROXY=1`; Railway proporciona `PORT`. Publica HTTPS para API, no PostgreSQL. Provisiona ambos usuarios por un proceso administrativo privado. Haz backup antes de futuras migraciones destructivas.

El contenedor conserva herramientas Prisma/tsx para migrar y provisionar usuarios, pero ejecuta la aplicación compilada como usuario no-root. No hay secretos en la imagen, repositorio ni datos de muestra. No se han creado servicios facturables ni realizado despliegues desde este repositorio.

Nota de dependencias: Swagger incorpora un aviso moderado sin corrección disponible en js-yaml. Esta API no acepta ni analiza YAML de usuarios y la documentación está desactivada por defecto. Revisar la actualización de Swagger cuando se publique la corrección.

La cuenta inicial acordada es `admin@lacteos.com`, nombre `Administración`. Se provisiona explícitamente en cada base de datos con `npm run user:create`; su contraseña se entrega por entorno y no se incluye en el repositorio ni se crea automáticamente al arrancar.

# El Sabor de Mi Tierra: alcance y reglas acordadas

Aplicación privada para Ariel y María José, distribuidores de lácteos en Tegucigalpa con proveedores de Olancho y el sur de Honduras. No producen los lácteos. Los encargos normalmente se reúnen de lunes a jueves, pero pueden existir rondas solapadas, compras adicionales, entregas parciales y ventas de existencias sobrantes.

## Separación de Leiras

- Repositorio y API independientes; autenticación y PostgreSQL propios.
- La web existente de Leiras aloja el módulo `/lacteos/*` con navegación y cliente HTTP independientes.
- La API y la app móvil actuales de Leiras no se modifican.
- Proyecto Railway independiente en el mismo workspace. No compartir credenciales ni tablas con Leiras.

## Primera entrega

Acceso privado sin registro público; clientes; proveedores y región; productos y precios; rondas; pedidos con libras y medias libras; resumen de cantidades por proveedor. Los importes de compra en el resumen son estimaciones, no compras confirmadas ni ganancias realizadas. El cierre de ronda impide nuevas modificaciones de encargos mientras no se reabra; no liquida inventario, ventas o deudas.

## Modelo operativo posterior

### Rondas, compras y lotes

Una ronda agrupa pedidos. Tiene múltiples compras a proveedores. Cada compra separa cantidades comprometidas y extras para venta posterior. Una compra puede recibirse parcialmente y generar varios lotes físicos. Cada lote conserva proveedor, producto, cantidad y costo real originales, aunque sus unidades se vendan en rondas posteriores.

Al cerrar una ronda se revisan cantidades y pendientes, sin exigir inventario cero. El sobrante no se vuelve pérdida ni se vuelve a comprar al pasar de ronda. La vista de resultado por ronda y la trazabilidad de la compra/lote son informes distintos, sin duplicar ingresos ni costos.

### Precios y resultados

Guardar por separado precio ofrecido al cliente, precio final aceptado, costo de compra estimado y costo real por lote. Un cambio del catálogo o costo no modifica el precio prometido de un pedido. Si el cliente acepta otro precio, conservar cambio, autor y momento. Registrar costo de lo vendido y costos operativos (envío, entrega, bolsas/embalaje) sin cargar como vendido el producto que permanece en existencia.

Separar gastos iniciales de búsqueda de proveedores de gastos recurrentes. Los gastos que los dueños pagan con recursos personales se conservan como gastos cubiertos por ellos, sin inventar salidas de caja comercial. Separar dinero cobrado/pagado del resultado económico. La estrategia de asignación de costos por lote y redondeo debe estar definida antes de implementar resultados.

### Inventario

Movimientos independientes: recepción, reserva/liberación, entrega por venta, muestra/promoción, consumo propio, merma/descarte y ajuste justificado. Muestras y consumo propio no son ventas ni se confunden entre sí. Las ventas extra requieren existencia disponible. Las reservas evitan comprometer una misma unidad a varios clientes.

### Entregas y cobros

Un pedido tiene múltiples entregas y múltiples pagos. Entregado no significa pagado. Un pago puede ser anticipo, abono o liquidación por efectivo o transferencia. Guardar monto, fecha, responsable y referencia opcional, además de fecha prometida de pago. La cancelación de un producto prepagado produce un importe a devolver o saldo a favor explícito. Mantener separados total de pedido, entregado, cobrado y pendiente.

### Fechas y conservación

Guardar momentos reales (UTC) de envío de compra, recepción de cada lote y entrega de cada cantidad; mostrar en America/Tegucigalpa. Guardar también fecha de registro y autor para anotaciones posteriores. Permite medir tiempo de abastecimiento, permanencia del lote, entregas y antigüedad del sobrante.

Fecha de elaboración, vencimiento, apertura/fraccionamiento, instrucciones del fabricante, condición y temperatura de recepción, e incidencias de cadena de frío pertenecen al lote. No inventar vida útil por nombre de producto, ni extender fechas al cambiar de ronda. Buen aspecto no certifica inocuidad. Un estado pendiente de revisión no debe autorizar venta, muestra o consumo propio automáticamente. Este sistema registra evidencia y aplica reglas configuradas, no certifica seguridad alimentaria.

## Concurrencia y auditoría

Ariel y María José trabajan con usuarios distintos y datos compartidos. Escrituras de pedidos deben detectar edición concurrente y conservar el borrador del usuario ante conflictos. Operaciones de inventario, entregas y cobros necesitarán transacciones e idempotencia para evitar duplicados. Conservar trazabilidad de cambios; no reemplazarla con eliminaciones silenciosas.

## Fuera de esta primera entrega

Compras confirmadas con costo real, lotes, inventario, entregas, pagos, gastos, reportes de utilidad, recordatorios y funcionamiento sin conexión. No mostrar indicadores simulados para estas funciones. Despliegue y cuentas reales requieren configuración explícita, sin contraseñas predeterminadas ni secretos en Git.

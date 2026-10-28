"""FIFO receipts against a disposable local API. Never run against production."""
import os, json, uuid, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from decimal import Decimal

base = os.environ.get('DAIRY_TEST_URL', 'http://127.0.0.1:4103/api/v1')
assert base.startswith(('http://localhost:', 'http://127.0.0.1:')), 'Local test server only'
token = None
checks = []
uid = lambda: str(uuid.uuid4())
now = datetime.now(timezone.utc) - timedelta(minutes=5)
iso = lambda d: d.isoformat(timespec='seconds')
def call(method, path, body=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(base+path, method=method, headers=headers,
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as res: return res.status, json.load(res)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
def good(method, path, body=None):
    code, data = call(method, path, body)
    assert code in (200, 201), (path, code, data)
    return data
def check(ok, label):
    assert ok, label
    checks.append(label)
token = good('POST', '/auth/login', {'email': os.environ['DAIRY_TEST_EMAIL'], 'password': os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag = uid()[:6]
supplier = good('POST', '/suppliers', {'name': 'Proveedor cobros '+tag, 'region': 'Olancho'})
customer = good('POST', '/customers', {'name': 'Cliente FIFO '+tag})
product = good('POST', '/products', {'name': 'Producto cobros '+tag, 'unit': 'unidad', 'salePrice': '715', 'estimatedCost': '1', 'defaultSupplierId': supplier['id']})
def cycle(n):
    return good('POST', '/rounds', {'name': 'Cobros '+str(n)+' '+tag, 'opensAt': iso(now-timedelta(days=30-n)), 'closesAt': iso(now+timedelta(days=7))})
r1, r2 = cycle(1), cycle(2)
def order(c, r, price, days):
    o = good('POST', '/orders', {'roundId': r['id'], 'customerId': c['id'], 'items': [{'productId': product['id'], 'supplierId': supplier['id'], 'quantity': '1', 'unitPrice': str(price)}]})
    good('PATCH', '/rounds/'+r['id']+'/dates', {'changes': [{'kind': 'order', 'id': o['id'], 'date': iso(now-timedelta(days=days))}]})
    return good('GET', '/orders/'+o['id'])
old, new = order(customer, r1, 715, 10), order(customer, r2, 540, 1)
cancelled = order(customer, r2, 500, 15)
good('POST', '/orders/'+cancelled['id']+'/cancel', {'version': cancelled['version'], 'reason': 'Prueba cancelación'})
purchase = good('POST', '/purchases', {'id': uid(), 'roundId': r1['id'], 'supplierId': supplier['id'], 'orderedAt': iso(now-timedelta(days=20)), 'items': [{'productId': product['id'], 'quantity': '2', 'quotedUnitCost': '1'}]})
good('POST', '/purchases/'+purchase['id']+'/receipts', {'id': uid(), 'version': purchase['version'], 'receivedAt': iso(now-timedelta(days=20)), 'invoice': 'COBROS '+tag, 'globalDiscount': '0', 'items': [{'purchaseItemId': purchase['items'][0]['id'], 'quantity': '2', 'unitCost': '1', 'unitDiscount': '0'}]})
old = good('GET', '/orders/'+old['id'])
good('POST', '/orders/'+old['id']+'/deliveries', {'id': uid(), 'version': old['version'], 'deliveredAt': iso(now-timedelta(days=2)), 'items': [{'orderItemId': old['items'][0]['id'], 'quantity': '1'}]})
lot = next(l for l in good('GET', '/inventory') if l['productId'] == product['id'])
good('POST', '/rounds/'+r1['id']+'/close', {'decisions': [{'receiptItemId': lot['id'], 'reason': 'KEEP', 'quantity': '1'}]})
def snapshot(c=customer):
    row = next(r for r in good('GET', '/collections')['customers'] if r['customer']['id'] == c['id'])
    return [{'id': o['id'], 'version': o['version']} for o in row['orders'] if Decimal(o['balance']) > 0]
def body(amount, c=customer):
    return {'id': uid(), 'amount': str(amount), 'method': 'TRANSFER', 'paidAt': iso(now), 'notes': 'Prueba FIFO '+tag, 'expectedOrders': snapshot(c)}
path = '/customers/'+customer['id']+'/payments'
first = body(1000)
walkin = next((c for c in good('GET', '/customers') if c['name'] == 'Cliente de paso'), None)
if not walkin: walkin = good('POST', '/customers', {'name': 'Cliente de paso'})
check(call('POST', '/customers/'+walkin['id']+'/payments', {**first, 'id': uid()})[0] == 400, 'anonymous walk-in sales cannot be pooled into one customer receipt')
before = Decimal(good('GET', '/finance/summary')['allTime']['cashExpected'])
result = good('POST', path, first)
check([(p['orderId'], p['amount']) for p in result['payments']] == [(old['id'], '715.00'), (new['id'], '285.00')], 'oldest first across cycles, including a closed cycle')
check(good('GET', '/orders/'+new['id'])['balance'] == '255.00', 'partial remainder is exact')
check(not good('GET', '/orders/'+cancelled['id'])['payments'], 'cancelled encargo is untouched')
after = Decimal(good('GET', '/finance/summary')['allTime']['cashExpected'])
check(after-before == Decimal(1000), 'cash is counted once across allocated payments')
good('POST', path, first)
check(len(good('GET', '/orders/'+old['id'])['payments']) == 1 and len(good('GET', '/orders/'+new['id'])['payments']) == 1, 'retry does not duplicate payment')
check(call('POST', path, {**first, 'amount': '1001'})[0] == 409, 'operation id cannot be reused for another amount')
check(call('POST', '/customers/'+uid()+'/payments', first)[0] == 409, 'operation id cannot be reused for another customer')
check(call('POST', path, {**first, 'id': uid(), 'amount': '1'})[0] == 409, 'stale preview rejected without a partial write')
fresh = body(300)
check(call('POST', path, {**fresh, 'amount': '0'})[0] == 400, 'zero payment rejected')
check(call('POST', path, {**fresh, 'paidAt': iso(now+timedelta(days=3))})[0] == 400, 'future payment rejected')
check(call('POST', path, {**fresh, 'method': 'CREDIT'})[0] == 400, 'direct receipt requires cash or transfer')
check(call('POST', path, fresh)[0] == 400, 'excess needs explicit confirmation')
check(good('GET', '/orders/'+new['id'])['balance'] == '255.00', 'invalid payment leaves debt intact')
fresh['excessToAccount'] = True
result = good('POST', path, fresh)
check(result['applied'] == '255.00' and result['excess'] == '45.00', 'excess becomes separate account credit')
good('POST', path, fresh)
check(good('GET', '/customers/'+customer['id']+'/account')['balance'] == '45.00', 'excess also remains idempotent')
unpaid = order(customer, r2, 70, 0)
competing = body(10)
with ThreadPoolExecutor(max_workers=2) as pool:
    codes = sorted(pool.map(lambda b: call('POST', path, b)[0], [competing, {**competing, 'id': uid()}]))
check(codes == [201, 409] and good('GET', '/orders/'+unpaid['id'])['balance'] == '60.00', 'concurrent receipts cannot both use an old preview')
retry = body(10)
with ThreadPoolExecutor(max_workers=2) as pool:
    codes = list(pool.map(lambda _: call('POST', path, retry)[0], range(2)))
check(codes == [201, 201] and good('GET', '/orders/'+unpaid['id'])['balance'] == '50.00', 'simultaneous retries create one receipt')
sale = good('POST', '/sales', {'id': uid(), 'customerId': customer['id'], 'roundId': r2['id'], 'soldAt': iso(now-timedelta(hours=1)), 'items': [{'productId': product['id'], 'quantity': '1', 'unitPrice': '35'}]})
check(datetime.fromisoformat(sale['createdAt'].replace('Z', '+00:00')) == datetime.fromisoformat(iso(now-timedelta(hours=1))), 'backdated sale keeps its business date for FIFO')
mixed = good('POST', path, body(40))
check([(p['orderId'], p['amount']) for p in mixed['payments']] == [(sale['id'], '35.00'), (unpaid['id'], '5.00')], 'direct sales and encargos share the same chronological queue')
ui = good('POST', '/customers', {'name': 'Cliente pago UI '+tag, 'phone': '99887766'})
order(ui, r2, 715, 4)
order(ui, r2, 540, 2)
check(next(c for c in good('GET', '/customers') if c['id'] == ui['id'])['lastOrderAt'] is not None, 'customer picker receives real latest activity')
print(json.dumps({'checks': len(checks), 'round': r2['name'], 'uiCustomer': ui['name'], 'tag': tag}, ensure_ascii=False))

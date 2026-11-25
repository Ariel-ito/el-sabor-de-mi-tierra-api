"""Invoice-price history versus carried-lot profitability on a LOCAL API."""
import json, os, uuid, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

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
    request = urllib.request.Request(base + path, method=method, headers=headers,
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=40) as response:
        return json.load(response)
def check(ok, label):
    assert ok, label
    checks.append(label)

token = call('POST', '/auth/login', {'email': os.environ['DAIRY_TEST_EMAIL'], 'password': os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag = uid()[:6]
s1 = call('POST', '/suppliers', {'name': 'Precios Delicias ' + tag, 'region': 'Olancho'})
s2 = call('POST', '/suppliers', {'name': 'Precios alternativo ' + tag, 'region': 'Sur'})
product = call('POST', '/products', {'name': 'Mantequilla precios ' + tag, 'unit': 'lb', 'salePrice': '70', 'estimatedCost': '54', 'defaultSupplierId': s1['id']})
def round_(label, offset):
    return call('POST', '/rounds', {'name': label + ' ' + tag, 'opensAt': iso(now + timedelta(days=offset)), 'closesAt': iso(now + timedelta(days=offset + 7))})
r8 = round_('Precios anterior', -8)
r9 = round_('Precios actual', -1)
r10 = round_('Precios solo sobrantes', 0)
def purchase(r, supplier, quantity, unit_cost, at):
    p = call('POST', '/purchases', {'id': uid(), 'roundId': r['id'], 'supplierId': supplier['id'], 'orderedAt': iso(at), 'items': [{'productId': product['id'], 'quantity': quantity, 'quotedUnitCost': unit_cost}]})
    call('POST', '/purchases/' + p['id'] + '/receipts', {'id': uid(), 'version': p['version'], 'receivedAt': iso(at), 'invoice': 'FAC ' + tag, 'globalDiscount': '0', 'items': [{'purchaseItemId': p['items'][0]['id'], 'quantity': quantity, 'unitCost': unit_cost, 'unitDiscount': '0'}]})

purchase(r8, s1, '2', '54', now - timedelta(days=7))
purchase(r9, s1, '16', '56', now - timedelta(hours=2))
purchase(r9, s2, '1', '80', now - timedelta(hours=1))
call('POST', '/sales', {'id': uid(), 'roundId': r9['id'], 'soldAt': iso(now), 'items': [{'productId': product['id'], 'quantity': '17', 'unitPrice': '70'}]})
def cycle(r):
    return next(c for c in call('GET', '/statistics')['cycles'] if c['id'] == r['id'])
actual = cycle(r9)
p = next(p for p in actual['productPrices'] if p['productId'] == product['id'] and p['supplierId'] == s1['id'])
check(p['purchasedQuantity'] == '16' and p['soldQuantity'] == '17', 'purchase and sale quantities remain distinct')
check(p['purchaseUnitCost'] == '56.00' and p['purchaseTotal'] == '896.00', 'cycle price comes from this cycle invoice')
check(p['saleUnitPrice'] == '70.00' and p['referenceMargin'] == '14.00', 'reference margin compares cycle purchase with agreed sale price')
check(next(p for p in actual['productCosts'] if p['productId'] == product['id'])['unitCost'] == '55.76', 'lot profitability still includes two pounds of older stock at 54')
check(len(p['invoices']) == 1 and p['invoices'][0]['unitCost'] == '56.00' and p['invoices'][0]['quantity'] == '16', 'invoice drilldown reconciles with this cycle price')
other = next(p for p in actual['productPrices'] if p['productId'] == product['id'] and p['supplierId'] == s2['id'])
check(other['purchaseUnitCost'] == '80.00' and other['saleUnitPrice'] is None, 'other suppliers and unsold extras remain separate')
call('POST', '/sales', {'id': uid(), 'roundId': r10['id'], 'soldAt': iso(now), 'items': [{'productId': product['id'], 'quantity': '0.5', 'unitPrice': '70'}]})
carried = next(p for p in cycle(r10)['productPrices'] if p['productId'] == product['id'])
check(carried['purchaseUnitCost'] is None and carried['referenceMargin'] is None and carried['saleUnitPrice'] == '70.00', 'carried stock without a purchase does not invent a new invoice price')
print(json.dumps({'checks': len(checks), 'round': r9['name'], 'roundId': r9['id'], 'product': product['name'], 'productId': product['id']}, ensure_ascii=False))

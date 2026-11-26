"""Atomic quick operations, bulk packing/delivery/payment and retries; LOCAL only."""
import os, json, uuid, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta
from decimal import Decimal as D
from concurrent.futures import ThreadPoolExecutor

base = os.environ.get('DAIRY_TEST_URL', 'http://127.0.0.1:4104/api/v1')
assert base.startswith(('http://localhost:', 'http://127.0.0.1:')), 'Local test server only'
token = None
checks = []
uid = lambda: str(uuid.uuid4())
now = datetime.now(timezone.utc) - timedelta(minutes=5)
iso = lambda d: d.isoformat(timespec='seconds')
def call(method, path, body=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base+path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
def good(method, path, body=None):
    status, data = call(method, path, body)
    assert status in (200, 201), (path, status, data)
    return data
def check(ok, label):
    assert ok, label
    checks.append(label)
token = good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag = uid()[:6]
s = good('POST','/suppliers',{'name':'Proveedor acciones '+tag,'region':'Olancho'})
q = good('POST','/products',{'name':'Cuajada acciones '+tag,'unit':'lb','salePrice':'70','estimatedCost':'56','defaultSupplierId':s['id']})
b = good('POST','/products',{'name':'Pan acciones '+tag,'unit':'unidad','salePrice':'10','estimatedCost':'5','defaultSupplierId':s['id']})
r = good('POST','/rounds',{'name':'Acciones múltiples '+tag,'opensAt':iso(now-timedelta(days=1)),'closesAt':iso(now+timedelta(days=7))})
def create_order(label, bread=True):
    c=good('POST','/customers',{'name':label+' '+tag})
    items=[{'productId':q['id'],'supplierId':s['id'],'quantity':'1','unitPrice':'70'}]
    if bread: items.append({'productId':b['id'],'supplierId':s['id'],'quantity':'2','unitPrice':'10'})
    return good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':items})
def receive(product, quantity, cost):
    p=good('POST','/purchases',{'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':iso(now-timedelta(hours=2)),'items':[{'productId':product['id'],'quantity':quantity,'quotedUnitCost':cost}]})
    good('POST','/purchases/'+p['id']+'/receipts',{'id':uid(),'version':p['version'],'receivedAt':iso(now-timedelta(hours=1)),'invoice':'FAC '+tag,'globalDiscount':'0','items':[{'purchaseItemId':p['items'][0]['id'],'quantity':quantity,'unitCost':cost,'unitDiscount':'0'}]})
def get(o): return good('GET','/orders/'+o['id'])
def command(action, orders):
    rows=[]
    for o in orders:
        current=get(o)
        rows.append({'id':o['id'],'version':current['version'],**({'items':[{'orderItemId':i['id'],'quantity':i['reservedQuantity']} for i in current['items']]} if action!='PAY' else {})})
    return {'id':uid(),'action':action,'date':iso(now),'method':'CASH','orders':rows}
path='/orders/batch-operations'
orders=[create_order('Cliente grupo '+str(i)) for i in range(7)]
receive(q,'20','56')
first=get(orders[0])
good('POST','/orders/'+first['id']+'/payments',{'id':uid(),'version':first['version'],'amount':'25','method':'TRANSFER','paidAt':iso(now)})
check(get(first)['batchOperations'] is True, 'API advertises bulk operation support')
pack=command('PACK',orders)
with ThreadPoolExecutor(max_workers=2) as pool:
    replies=list(pool.map(lambda _:call('POST',path,pack),range(2)))
check(all(status==201 for status,_ in replies) and sorted(data['replayed'] for _,data in replies)==[False,True], 'concurrent retries apply one command once')
current=[get(o) for o in orders]
check(all(next(i for i in o['items'] if i['productId']==q['id'])['packedQuantity']=='1' and next(i for i in o['items'] if i['productId']==b['id'])['packedQuantity']=='0' for o in current), 'seven dairy-and-bakery orders are packed partially')
check(all(not o['deliveries'] for o in current) and sum(D(o['paid']) for o in current)==25, 'packing does not invent delivery or payment')
check(all(len(good('GET','/orders/'+o['id']+'/packing'))==1 for o in current), 'each packing history has one authored record')
check(call('POST',path,{**pack,'action':'PAY'})[0]==409,'command identifiers cannot be reused for another action')
partial=command('DELIVER',orders)
good('POST',path,partial)
current=[get(o) for o in orders]
check(all(o['deliveryStatus']=='PARTIAL' for o in current),'seven orders deliver the available dairy and leave bakery pending')
check(all(next(i for i in o['items'] if i['productId']==q['id'])['totalPackedQuantity']=='1' and next(i for i in o['items'] if i['productId']==b['id'])['totalPackedQuantity']=='0' for o in current),'partial delivery confirms only the actual delivered packing')
check(sum(D(o['paid']) for o in current)==25,'partial delivery alone never creates a payment')
good('POST',path,partial)
check(all(len(get(o)['deliveries'])==1 for o in orders),'partial delivery retry cannot duplicate quantities')
pay=command('PAY',orders)
pay['orders'][0]['method']='TRANSFER'
cash_before=D(good('GET','/finance/summary')['position']['cash'])
good('POST',path,pay)
current=[get(o) for o in orders]
check(all(o['balance']=='0.00' for o in current),'full payment covers the outstanding balance for seven orders')
check(len(current[0]['payments'])==2 and any(D(p['amount'])==65 and p['method']=='TRANSFER' for p in current[0]['payments']),'previous abono is preserved and only remaining amount is charged with chosen method')
check(D(good('GET','/finance/summary')['position']['cash'])-cash_before==605,'bulk payments reconcile exactly with accounting cash')
check(all(o['deliveryStatus']=='PARTIAL' and len(o['deliveries'])==1 for o in current),'payment does not falsely complete a partial delivery')
check(all(next(i for i in o['items'] if i['productId']==q['id'])['totalPackedQuantity']=='1' for o in current),'payment preserves delivered packing')
good('POST',path,pay)
check(sum(len(get(o)['payments']) for o in orders)==8,'repeated bulk payment cannot duplicate cash')
receive(b,'14','5')
deliver=command('DELIVER',orders)
good('POST',path,deliver)
current=[get(o) for o in orders]
check(all(o['deliveryStatus']=='DELIVERED' for o in current),'seven orders can be delivered together')
check(all(all(D(i['totalPackedQuantity'])==D(i['quantity']) and i['packedQuantity']=='0' for i in o['items']) for o in current),'delivery implies packing without counting earlier preparation twice')
good('POST',path,deliver)
check(all(len(get(o)['deliveries'])==2 for o in orders),'second delivery adds only the bakery; its retry cannot consume stock twice')
good('POST',path,command('COMPLETE',orders))
check(sum(len(get(o)['payments']) for o in orders)==8 and all(len(get(o)['deliveries'])==2 for o in orders),'already completed steps remain no-ops')
ready=create_order('Cliente rápido',False)
missing=create_order('Cliente sin pan',True)
before=get(ready)
stale=command('COMPLETE',[ready,missing]); stale['orders'][1]['version']+=1
check(call('POST',path,stale)[0]==409,'stale review blocks the combined command atomically')
check(get(ready)['version']==before['version'] and get(ready)['balance']=='70.00' and not get(ready)['deliveries'],'a valid first order is untouched when another order has changed')
invalid=command('DELIVER',[ready,missing]); invalid['orders'][1]['items'][0]['quantity']='100'
check(call('POST',path,invalid)[0]==409 and not get(ready)['deliveries'],'unavailable planned quantities cannot partially mutate the rest of a group')
complete=command('COMPLETE',[ready,missing]); complete['method']='TRANSFER'
good('POST',path,complete)
done=get(ready)
check(done['deliveryStatus']=='DELIVERED' and done['paymentStatus']=='PAID' and done['items'][0]['totalPackedQuantity']=='1','one quick action completes packing, delivery and payment')
check(done['payments'][0]['method']=='TRANSFER' and D(done['payments'][0]['amount'])==70,'quick completion records an actual payment with its method')
part=get(missing)
check(part['deliveryStatus']=='PARTIAL' and part['paymentStatus']=='PAID','complete processes only available stock while recording the agreed full payment')
check(next(i for i in part['items'] if i['productId']==b['id'])['deliveredQuantity']=='0' and next(i for i in part['items'] if i['productId']==b['id'])['totalPackedQuantity']=='0','unreceived products are never delivered or packed')
good('POST',path,complete)
check(len(get(ready)['payments'])==1 and len(get(ready)['deliveries'])==1,'quick completion is idempotent too')
receive(b,'2','5')
good('POST',path,command('COMPLETE',[missing]))
check(get(missing)['deliveryStatus']=='DELIVERED' and len(get(missing)['payments'])==1 and len(get(missing)['deliveries'])==2,'later arrival completes only the remaining delivery without charging the customer again')
future=command('PAY',[missing]);future['date']=iso(now+timedelta(days=1))
check(call('POST',path,future)[0]==400,'future dates are rejected')
duplicate=command('PAY',[missing]);duplicate['orders']*=2
check(call('POST',path,duplicate)[0]==400,'duplicate selection is rejected')
competing=create_order('Cobro concurrente',False)
concurrent=command('PAY',[competing])
with ThreadPoolExecutor(max_workers=2) as pool:
    races=list(pool.map(lambda body:call('POST',path,body),[concurrent,{**concurrent,'id':uid()}]))
check(sorted(status for status,_ in races)==[201,409],'different commands competing for the same reviewed debt cannot both charge it')
check(len(get(competing)['payments'])==1 and get(competing)['balance']=='0.00','concurrent distinct commands record exactly one payment')
reviewed=create_order('Revisión disponible',True)
planned=command('DELIVER',[reviewed])
receive(b,'2','5')
good('POST',path,planned)
reviewed=get(reviewed)
check(reviewed['deliveryStatus']=='PARTIAL' and next(i for i in reviewed['items'] if i['productId']==b['id'])['deliveredQuantity']=='0','products arriving after the review are not silently included in the delivery')
good('POST',path,command('COMPLETE',[reviewed]))
check(get(reviewed)['deliveryStatus']=='DELIVERED' and get(reviewed)['paymentStatus']=='PAID','a fresh review can complete newly arrived stock')
no_stock=create_order('Sin producto recibido',True)
only_bread=next(i for i in get(no_stock)['items'] if i['productId']==b['id'])
# A zero-quantity reviewed line remains pending even when another line is available.
half=command('DELIVER',[no_stock])
for line in half['orders'][0]['items']:
    if line['orderItemId']!=only_bread['id']:line['quantity']='0.5'
good('POST',path,half)
check(next(i for i in get(no_stock)['items'] if i['productId']==q['id'])['deliveredQuantity']=='0.5','a partial quantity of one product is delivered and packed exactly')
empty_preview=command('PACK',[no_stock])
for line in empty_preview['orders'][0]['items']:line['quantity']='0'
good('POST',path,empty_preview)
check(next(i for i in get(no_stock)['items'] if i['productId']==b['id'])['packedQuantity']=='0','zero availability never creates a packing mark')
# Retrospective delivery uses each selected order's date, even if those lots
# would be expired today; both orders must see the same historical stock view.
old_product=good('POST','/products',{'name':'Lote histórico '+tag,'unit':'lb','salePrice':'70','estimatedCost':'56','defaultSupplierId':s['id']})
historical=[]
for i in range(2):
    c=good('POST','/customers',{'name':'Entrega anterior '+str(i)+' '+tag})
    historical.append(good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[{'productId':old_product['id'],'supplierId':s['id'],'quantity':'1','unitPrice':'70'}]}))
p=good('POST','/purchases',{'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':iso(now-timedelta(days=4)),'items':[{'productId':old_product['id'],'quantity':'2','quotedUnitCost':'56'}]})
good('POST','/purchases/'+p['id']+'/receipts',{'id':uid(),'version':p['version'],'receivedAt':iso(now-timedelta(days=3)),'invoice':'Anterior '+tag,'globalDiscount':'0','items':[{'purchaseItemId':p['items'][0]['id'],'quantity':'2','unitCost':'56','unitDiscount':'0','expiresAt':iso(now-timedelta(days=1))}]})
historical_command=command('DELIVER',historical)
historical_command['date']=iso(now-timedelta(days=2))
for row in historical_command['orders']:row.pop('items',None)
good('POST',path,historical_command)
check(all(get(o)['deliveryStatus']=='DELIVERED' for o in historical),'retrospective batch preserves the historical inventory date for every selected order')
check(all(get(o)['deliveries'][0]['deliveredAt'].startswith(historical_command['date'][:19]) for o in historical),'actual delivery dates are kept separately from recording time')
print(json.dumps({'checks':len(checks),'roundId':r['id'],'round':r['name'],'customer':missing['customer']['name']},ensure_ascii=False))

"""Payment settlements and current position against a disposable LOCAL API."""
import os, json, uuid, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta
from decimal import Decimal as D
from concurrent.futures import ThreadPoolExecutor

base = os.environ.get('DAIRY_TEST_URL', 'http://127.0.0.1:4103/api/v1')
assert base.startswith(('http://localhost:', 'http://127.0.0.1:')), 'Local test server only'
token = None
checks = []
uid = lambda: str(uuid.uuid4())
now = datetime.now(timezone.utc) - timedelta(minutes=5)
old_day = now.replace(day=1) - timedelta(days=2)
iso = lambda d: d.isoformat(timespec='seconds')
def call(method, path, body=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base+path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
def good(method, path, body=None):
    code, data = call(method, path, body)
    assert code in (200, 201), (path, code, data)
    return data
def check(ok, message):
    assert ok, message
    checks.append(message)
token = good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag=uid()[:6]
supplier=good('POST','/suppliers',{'name':'Proveedor propinas '+tag,'region':'Olancho'})
product=good('POST','/products',{'name':'Producto propinas '+tag,'unit':'unidad','salePrice':'185','estimatedCost':'50','defaultSupplierId':supplier['id']})
r1=good('POST','/rounds',{'name':'Balance anterior '+tag,'opensAt':iso(old_day-timedelta(days=5)),'closesAt':iso(now+timedelta(days=2))})
r2=good('POST','/rounds',{'name':'Balance actual '+tag,'opensAt':iso(now-timedelta(days=1)),'closesAt':iso(now+timedelta(days=7))})
def summary(month=None): return good('GET','/finance/summary'+('?'+'month='+month if month else ''))
def customer(label): return good('POST','/customers',{'name':label+' '+tag})
def order(c, price='185', round_=r2):
    return good('POST','/orders',{'roundId':round_['id'],'customerId':c['id'],'items':[{'productId':product['id'],'supplierId':supplier['id'],'quantity':'1','unitPrice':price}]})
def pay_body(o, choice=None):
    return {'id':uid(),'version':o['version'],'amount':'200','method':'CASH','paidAt':iso(now),**({'excessDisposition':choice} if choice else {})}
before_old=summary(old_day.strftime('%Y-%m'))
purchase=good('POST','/purchases',{'id':uid(),'roundId':r1['id'],'supplierId':supplier['id'],'orderedAt':iso(old_day),'items':[{'productId':product['id'],'quantity':'20','quotedUnitCost':'50'}]})
good('POST','/purchases/'+purchase['id']+'/receipts',{'id':uid(),'version':purchase['version'],'receivedAt':iso(old_day),'invoice':'PROPINA '+tag,'globalDiscount':'0','items':[{'purchaseItemId':purchase['items'][0]['id'],'quantity':'20','unitCost':'50','unitDiscount':'0'}]})
after_old=summary(old_day.strftime('%Y-%m'))
check(D(after_old['monthly']['expense'])-D(before_old['monthly']['expense'])==1000,'supplier expense stays in its original month')
check(D(after_old['position']['inventoryValue'])-D(before_old['position']['inventoryValue'])==1000,'current position values inventory at receipt cost')
c=customer('Cliente FIFO con propina')
older=order(c,'100',r1)
good('PATCH','/rounds/'+r1['id']+'/dates',{'changes':[{'kind':'order','id':older['id'],'date':iso(old_day)}]})
newer=order(c,'85')
def snapshot(c):
    row=next(x for x in good('GET','/collections')['customers'] if x['customer']['id']==c['id'])
    return [{'id':o['id'],'version':o['version']} for o in row['orders'] if D(o['balance'])>0]
receipt={'id':uid(),'amount':'200','method':'CASH','paidAt':iso(now),'expectedOrders':snapshot(c)}
path='/customers/'+c['id']+'/payments'
check(good('GET','/payment-options')['paymentSettlements'] is True,'new API explicitly advertises settlements')
check(call('POST',path,receipt)[0]==400,'excess requires an explicit destination')
receipt['excessDisposition']='TIP'
before=summary()
with ThreadPoolExecutor(max_workers=2) as pool:
    results=list(pool.map(lambda _:call('POST',path,receipt),range(2)))
check(all(code==201 for code,_ in results),'simultaneous retries reuse a single receipt')
result=results[0][1]
check(result['applied']=='185.00' and result['tipAmount']=='15.00' and result['excess']=='0.00','tip does not inflate applied payment or customer credit')
o1=good('GET','/orders/'+older['id']);o2=good('GET','/orders/'+newer['id'])
check(o1['paid']=='100.00' and o2['paid']=='85.00' and o1['paymentStatus']==o2['paymentStatus']=='PAID','FIFO settles exact order totals across cycles')
after=summary()
check(D(after['position']['cash'])-D(before['position']['cash'])==200,'cash counts received payment and tip exactly once')
check(D(before['position']['receivables'])-D(after['position']['receivables'])==185,'current receivables decrease only by the invoice payment')
check(good('GET','/customers/'+c['id']+'/account')['balance']=='0.00','tip never becomes customer credit')
check(call('POST',path,{**receipt,'excessDisposition':'CHANGE'})[0]==409,'retry cannot change the original settlement destination')
check(call('POST','/orders/'+older['id']+'/payments/'+o1['payments'][0]['id']+'/void',{'reason':'Test'})[0]==400,'one FIFO child cannot be voided separately')
history=good('GET',path)
check(len(history)==1 and history[0]['tipRoundId']==r2['id'],'tip has one audited receipt and belongs to the last covered cycle')
stats=good('GET','/statistics')
current_cycle=next(x for x in stats['cycles'] if x['id']==r2['id'])
check(current_cycle['tips']=='15.00','cycle shows tips separately')
previous_view=summary(old_day.strftime('%Y-%m'))
check(previous_view['position']['cash']==after['position']['cash'],'changing the viewed month never changes the current balance')
check(D(previous_view['monthly']['income'])==D(after_old['monthly']['income']),'late receipt does not rewrite the earlier month income')
good('POST',path+'/'+receipt['id']+'/void',{'reason':'Desglose registrado por error'})
good('POST',path+'/'+receipt['id']+'/void',{'reason':'Reintento'})
check(good('GET','/orders/'+older['id'])['balance']=='100.00' and good('GET','/orders/'+newer['id'])['balance']=='85.00','voiding a receipt restores all debts once')
check(D(summary()['position']['cash'])==D(before['position']['cash']),'void also removes the tip from cash')
check(next(x for x in good('GET','/statistics')['cycles'] if x['id']==r2['id'])['tips']=='0.00','void removes tip from cycle results')

for choice in ['TIP','CREDIT','CHANGE']:
    c2=customer('Pago individual '+choice)
    o=order(c2)
    b=pay_body(o,choice)
    before=summary()
    saved=good('POST','/orders/'+o['id']+'/payments',b)
    good('POST','/orders/'+o['id']+'/payments',b)
    p=saved['payments'][0]
    check(saved['paid']=='185.00' and p['receivedAmount']=='200' and len(good('GET','/orders/'+o['id'])['payments'])==1,choice+' individual payment is exact and idempotent')
    check(D(summary()['position']['cash'])-D(before['position']['cash'])==(185 if choice=='CHANGE' else 200),choice+' has the correct net cash')
    check(D(good('GET','/customers/'+c2['id']+'/account')['balance'])==(15 if choice=='CREDIT' else 0),choice+' has the correct customer credit')
    check(call('PATCH','/orders/'+o['id']+'/payments/'+p['id'],{'amount':'180','method':'CASH','paidAt':iso(now)})[0]==400,'settled receipt cannot be edited into an inconsistent split')
    if choice=='CREDIT':
        owing=order(c2,'10')
        applied=good('POST','/orders/'+owing['id']+'/apply-credit',{'id':uid(),'version':owing['version'],'amount':'10','date':iso(now)})
        check(call('POST','/orders/'+o['id']+'/payments/'+p['id']+'/void',{'reason':'Test'})[0]==409,'spent credit must be restored before voiding its deposit')
        used=next(p for p in applied['payments'] if p['method']=='CREDIT')
        good('POST','/orders/'+owing['id']+'/payments/'+used['id']+'/void',{'reason':'Rehacer prueba'})
    good('POST','/orders/'+o['id']+'/payments/'+p['id']+'/void',{'reason':'Corrección'})
    check(good('GET','/orders/'+o['id'])['balance']=='185.00','void standalone restores debt')
    check(good('GET','/customers/'+c2['id']+'/account')['balance']=='0.00','void standalone removes its deposit when present')

before=summary()
sale=good('POST','/sales',{'id':uid(),'roundId':r1['id'],'soldAt':iso(now),'items':[{'productId':product['id'],'quantity':'1','unitPrice':'185'}],'payment':{'amount':'200','method':'CASH','excessDisposition':'TIP'}})
check(sale['total']=='185.00' and sale['paid']=='185.00' and D(sale['payments'][0]['tipAmount'])==15,'walk-in sale can receive a tip without changing sale prices')
check(D(summary()['position']['cash'])-D(before['position']['cash'])==200,'sale cash includes its tip once')
check(call('POST','/sales',{'id':uid(),'roundId':r1['id'],'soldAt':iso(now),'items':[{'productId':product['id'],'quantity':'1','unitPrice':'185'}],'payment':{'amount':'200','method':'CASH','excessDisposition':'CREDIT'}})[0]==400,'anonymous buyers cannot leave shared account credit')
ui=customer('Cliente UI sobrante')
ui_order=order(ui)
print(json.dumps({'checks':len(checks),'tag':tag,'roundId':r2['id'],'round':r2['name'],'uiCustomer':ui['name'],'uiCustomerId':ui['id'],'uiOrderId':ui_order['id']},ensure_ascii=False))

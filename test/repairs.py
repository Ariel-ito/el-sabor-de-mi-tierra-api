"""Regression checks for expiry, set-aside cycle closing and reimbursements.
Run only against a disposable local database via DAIRY_TEST_URL and credentials.
"""
import os, json, uuid, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta
base=os.environ.get('DAIRY_TEST_URL','http://127.0.0.1:4103/api/v1')
assert base.startswith(('http://localhost:','http://127.0.0.1:')),'Local test server only'
token=None
checks=[]
def call(method,path,body=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    r=urllib.request.Request(base+path,headers=headers,method=method,data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(r,timeout=30) as res:return res.status,json.load(res)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
def good(method,path,body=None):
    code,data=call(method,path,body);assert code in (200,201),(path,code,data);return data
def check(ok,label):assert ok,label;checks.append(label)
uid=lambda:str(uuid.uuid4())
now=datetime.now(timezone.utc)-timedelta(minutes=5)
iso=lambda d:d.isoformat(timespec='seconds')
past=iso(now-timedelta(days=4));valid=iso(now-timedelta(days=3));expired=iso(now-timedelta(days=1));future=iso(now+timedelta(days=3))
token=good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag=uid()[:6]
s=good('POST','/suppliers',{'name':'Proveedor revisión '+tag,'region':'Olancho'})
c=good('POST','/customers',{'name':'Cliente revisión '+tag})
p=good('POST','/products',{'name':'Crema revisión '+tag,'salePrice':'45','estimatedCost':'30','defaultSupplierId':s['id']})
r=good('POST','/rounds',{'name':'Vencimientos '+tag,'opensAt':iso(now-timedelta(days=6)),'closesAt':future})
def receive(round,product,quantity='4',expiry=future):
    existing={l['id'] for l in good('GET','/inventory')}
    purchase=good('POST','/purchases',{'id':uid(),'roundId':round['id'],'supplierId':s['id'],'orderedAt':past,'items':[{'productId':product['id'],'quantity':quantity,'quotedUnitCost':'30'}]})
    receipt={'id':uid(),'version':purchase['version'],'receivedAt':past,'invoice':'Revision '+tag,'globalDiscount':'0','items':[{'purchaseItemId':purchase['items'][0]['id'],'quantity':quantity,'unitCost':'30','unitDiscount':'0','expiresAt':expiry}]}
    good('POST',f"/purchases/{purchase['id']}/receipts",receipt)
    return next(l for l in good('GET','/inventory') if l['productId']==product['id'] and l['id'] not in existing)
lot=receive(r,p)
line={'productId':p['id'],'supplierId':s['id'],'quantity':'1','unitPrice':'45'}
o=good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[line]})
stock=good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[{**line,'quantity':'0.5','source':'STOCK'}]})
first=good('POST',f"/orders/{o['id']}/deliveries",{'id':uid(),'version':o['version'],'deliveredAt':valid,'items':[{'orderItemId':o['items'][0]['id'],'quantity':'0.5'}]})
good('POST',f"/orders/{stock['id']}/packing",{'items':[stock['items'][0]['id']],'packed':True})
good('PATCH',f"/inventory/lots/{lot['id']}/expiry",{'expiresAt':expired})
expiredlot=next(l for l in good('GET','/inventory') if l['id']==lot['id'])
check(expiredlot['sellable']=='0' and expiredlot['available']=='3.5','expired free stock stays visible but cannot be sold')
check(expiredlot['reserved']=='0' and expiredlot['delivered']=='0.5','expiry releases undelivered reservations and preserves deliveries')
check(good('GET',f"/orders/{stock['id']}")['items'][0]['packedAt'] is None,'expiry invalidates the packed bag for the released reservation')
check(len(good('GET','/orders?roundId='+r['id']))==2,'expired stock reservation does not break reads of other orders')
check(call('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[{**line,'source':'STOCK'}]})[0]==409,'new stock encargo cannot reserve expired product')
check(call('POST',f"/orders/{o['id']}/deliveries",{'id':uid(),'version':first['version'],'deliveredAt':iso(now),'items':[{'orderItemId':o['items'][0]['id'],'quantity':'0.5'}]})[0]==400,'expired product cannot be delivered')
combo=good('POST','/products',{'name':'Combo revisión '+tag,'unit':'paquete','salePrice':'60','estimatedCost':'0','defaultSupplierId':s['id']})
good('PATCH',f"/products/{combo['id']}/components",{'components':[{'componentId':p['id'],'quantity':'0.5'}]})
check(call('POST','/assemblies',{'id':uid(),'roundId':r['id'],'comboId':combo['id'],'quantity':'1','date':iso(now)})[0]==400,'expired components cannot be assembled into combos')
check(call('POST','/sales',{'id':uid(),'roundId':r['id'],'soldAt':iso(now),'items':[{'productId':p['id'],'quantity':'0.5','unitPrice':'45'}]})[0]==400,'expired product cannot be sold directly')
check(call('POST','/inventory/withdrawals',{'id':uid(),'receiptItemId':lot['id'],'quantity':'0.5','reason':'SAMPLE'})[0]==400,'expired product cannot be used as a sample')
# Historical deliveries are allowed when the product was still valid then.
historical=good('POST',f"/orders/{o['id']}/deliveries",{'id':uid(),'version':first['version'],'deliveredAt':valid,'items':[{'orderItemId':o['items'][0]['id'],'quantity':'0.5'}]})
check(historical['deliveryStatus']=='DELIVERED','historical delivery before expiry still works')
check(call('PATCH',f"/rounds/{r['id']}/dates",{'changes':[{'kind':'delivery','id':historical['deliveries'][-1]['id'],'date':iso(now)}]})[0]==400,'date correction cannot move a recorded delivery after expiry')
# Replacement stock fulfils an existing stock encargo; no expired lot is used.
newlot=receive(r,p,quantity='2',expiry=future)
check(newlot['reserved']=='0.5' and newlot['sellable']=='1.5','fresh replacement stock reserves pending stock order')
currentstock=good('GET',f"/orders/{stock['id']}")
good('POST',f"/orders/{stock['id']}/deliveries",{'id':uid(),'version':currentstock['version'],'deliveredAt':iso(now),'items':[{'orderItemId':stock['items'][0]['id'],'quantity':'0.5'}]})
good('POST','/inventory/withdrawals',{'id':uid(),'receiptItemId':lot['id'],'quantity':'3','reason':'LOSS'})
check(next(l for l in good('GET','/inventory') if l['id']==lot['id'])['onHand']=='0','expired remainder can be written off without losing history')
# A set-aside sale holds the cycle open through partial delivery as well.
r2=good('POST','/rounds',{'name':'Apartados '+tag,'opensAt':past,'closesAt':future})
p2=good('POST','/products',{'name':'Queso revisión '+tag,'salePrice':'50','estimatedCost':'30','defaultSupplierId':s['id']})
receive(r2,p2,quantity='1')
sale=good('POST','/sales',{'id':uid(),'roundId':r2['id'],'customerId':c['id'],'soldAt':iso(now),'deliverNow':False,'items':[{'productId':p2['id'],'quantity':'1','unitPrice':'50'}]})
state=good('GET',f"/rounds/{r2['id']}/closing")
check(len(state['pendingDeliveries'])==1 and state['pendingDeliveries'][0]['kind']=='DIRECT','closing lists set-aside sale with its type')
check(call('PATCH',f"/rounds/{r2['id']}",{'status':'CLOSED'})[0]==409,'simple cycle close cannot bypass set-aside sale')
check(call('POST',f"/rounds/{r2['id']}/close",{'decisions':[]})[0]==409,'guided close blocks set-aside sale')
sale=good('POST',f"/orders/{sale['id']}/deliveries",{'id':uid(),'version':sale['version'],'deliveredAt':iso(now),'items':[{'orderItemId':sale['items'][0]['id'],'quantity':'0.5'}]})
check(len(good('GET',f"/rounds/{r2['id']}/closing")['pendingDeliveries'])==1,'partly delivered set-aside sale still blocks close')
good('POST',f"/orders/{sale['id']}/deliveries",{'id':uid(),'version':sale['version'],'deliveredAt':iso(now),'items':[{'orderItemId':sale['items'][0]['id'],'quantity':'0.5'}]})
check(good('POST',f"/rounds/{r2['id']}/close",{'decisions':[]})['status']=='CLOSED','fully delivered sale permits close even with balance owed')
# Closing cannot consume expired leftovers through a different endpoint.
r3=good('POST','/rounds',{'name':'Merma vencida '+tag,'opensAt':past,'closesAt':future})
p3=good('POST','/products',{'name':'Lote vencido '+tag,'salePrice':'45','estimatedCost':'30','defaultSupplierId':s['id']})
expiredleft=receive(r3,p3,quantity='0.5',expiry=expired)
check(call('POST',f"/rounds/{r3['id']}/close",{'decisions':[{'receiptItemId':expiredleft['id'],'reason':'SAMPLE','quantity':'0.5'}]})[0]==400,'cycle closing cannot classify expired product as a sample')
check(good('POST',f"/rounds/{r3['id']}/close",{'decisions':[{'receiptItemId':expiredleft['id'],'reason':'LOSS','quantity':'0.5'}]})['status']=='CLOSED','expired leftovers can be closed as merma')
# Reimbursement moves cash in October, leaves September expense intact.
categories=good('GET','/finance/categories')
category=next(x for x in categories if x['kind']=='EXPENSE' and x['name']=='Equipo')
beforeSept=good('GET','/finance/summary?month=2026-09')['monthly'];beforeOct=good('GET','/finance/summary?month=2026-10')['monthly']
movement=good('POST','/finance/movements',{'id':uid(),'kind':'EXPENSE','categoryId':category['id'],'amount':'100','description':'Gasto de Ariel '+tag,'date':'2026-09-20T18:00:00Z','paidBy':'ARIEL','personalMode':'REIMBURSE'})
check(call('POST',f"/finance/movements/{movement['id']}/reimburse",{'version':movement['version'],'date':'2026-09-19T18:00:00Z'})[0]==400,'repayment cannot precede original expense')
check(call('POST',f"/finance/movements/{movement['id']}/reimburse",{'version':movement['version'],'date':future})[0]==400,'repayment cannot be future dated')
good('POST',f"/finance/movements/{movement['id']}/reimburse",{'version':movement['version'],'date':'2026-10-10T18:00:00Z'})
sept=good('GET','/finance/summary?month=2026-09')['monthly'];oct=good('GET','/finance/summary?month=2026-10')['monthly']
from decimal import Decimal
check(Decimal(sept['expense'])-Decimal(beforeSept['expense'])==100 and sept['cashExpected']==beforeSept['cashExpected'],'September recognizes expense without subtracting cash for later reimbursement')
check(Decimal(oct['cashExpected'])-Decimal(beforeOct['cashExpected'])==-100 and oct['expense']==beforeOct['expense'],'October recognizes repayment cash without counting expense twice')
good('POST','/auth/logout')
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))

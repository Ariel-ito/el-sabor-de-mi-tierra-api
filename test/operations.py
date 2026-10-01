"""Inventory, delivery, and payment checks; disposable local data only."""
import json, os, uuid, urllib.request, urllib.error, concurrent.futures
base=os.environ.get('DAIRY_TEST_URL','http://127.0.0.1:4101/api/v1')
assert base.startswith(('http://127.0.0.1:', 'http://localhost:'))
checks=[]
def call(method,path,data=None):
    h={'Content-Type':'application/json'}
    if token: h['Authorization']='Bearer '+token
    r=urllib.request.Request(base+path,headers=h,data=None if data is None else json.dumps(data).encode(),method=method)
    try:
        with urllib.request.urlopen(r,timeout=30) as x:return x.status,json.load(x)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
def good(method,path,data=None):
    code,out=call(method,path,data);assert code in (200,201),(path,code,out);return out
def check(ok,label):assert ok,label;checks.append(label)
token=None
check(call('GET','/inventory')[0]==401,'private inventory')
token=good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
u=uuid.uuid4().hex[:6]; uid=lambda:str(uuid.uuid4())
s=good('POST','/suppliers',{'name':'Prueba inventario '+u,'region':'Olancho'})
c=good('POST','/customers',{'name':'Prueba entregas '+u})
p=good('POST','/products',{'name':'Crema inventario '+u,'salePrice':'45','estimatedCost':'30','defaultSupplierId':s['id']})
r=good('POST','/rounds',{'name':'Inventario y cobros '+u,'opensAt':'2026-09-01T00:00:00Z','closesAt':'2026-10-01T00:00:00Z'})
line={'productId':p['id'],'supplierId':s['id'],'quantity':'2.5','unitPrice':'45'}
o=good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[line]})
check(o['deliveryStatus']=='ORDERED' and o['paymentStatus']=='UNPAID','independent initial states')
d={'id':uid(),'version':o['version'],'deliveredAt':'2026-09-29T10:00:00Z','items':[{'orderItemId':o['items'][0]['id'],'quantity':'0.5'}]}
check(call('POST',f"/orders/{o['id']}/deliveries",d)[0]==400,'cannot deliver before receipt')
purchase=good('POST','/purchases',{'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':'2026-09-28T10:00:00Z','items':[{'productId':p['id'],'quantity':'5','quotedUnitCost':'30'}]})
good('POST',f"/purchases/{purchase['id']}/receipts",{'id':uid(),'version':purchase['version'],'receivedAt':'2026-09-28T15:00:00Z','invoice':'INV '+u,'globalDiscount':'0','items':[{'purchaseItemId':purchase['items'][0]['id'],'quantity':'5','unitCost':'30','unitDiscount':'0'}]})
def lot():return next(l for l in good('GET','/inventory') if l['productId']==p['id'])
check(lot()['available']=='2.5' and lot()['reserved']=='2.5','rounded and extra stock reserves only customer quantity')
o=good('POST',f"/orders/{o['id']}/deliveries",d)
check(o['deliveryStatus']=='PARTIAL' and o['paymentStatus']=='UNPAID','partial delivery remains unpaid')
retry=good('POST',f"/orders/{o['id']}/deliveries",d)
check(len(retry['deliveries'])==1 and lot()['onHand']=='4.5','delivery retry does not consume twice')
# Add stock to existing encargo, keeping delivered original line and exact total.
saved={k:o['items'][0][k] for k in ['id','productId','supplierId','quantity','unitPrice']}
o=good('PATCH',f"/orders/{o['id']}",{'version':o['version'],'items':[saved,{**line,'quantity':'0.5','source':'STOCK','totalAmount':'25'}]})
check(o['total']=='137.50' and lot()['available']=='2','extra stock attaches to encargo with premium half-pound total')
summary=good('GET',f"/rounds/{r['id']}/purchase-summary")
check(summary['totalQuantity']=='2.5','stock sale excluded from supplier request')
check(call('PATCH',f"/orders/{o['id']}",{'version':o['version'],'items':[{**line,'id':next(i['id'] for i in o['items'] if i['source']=='STOCK'),'quantity':'0.5','source':'STOCK'}]})[0]==400,'cannot erase delivered line')
pay={'id':uid(),'version':o['version'],'amount':'50','method':'CASH','paidAt':'2026-09-29T10:00:00Z'}
o=good('POST',f"/orders/{o['id']}/payments",pay)
check(o['paid']=='50.00' and o['balance']=='87.50' and o['paymentStatus']=='PARTIAL','partial abono computes balance')
check(good('POST',f"/orders/{o['id']}/payments",pay)['paid']=='50.00','payment retry is idempotent')
check(call('POST',f"/orders/{o['id']}/payments",{**pay,'id':uid(),'version':o['version'],'amount':'88'})[0]==400,'reject excess payment')
check(call('POST',f"/orders/{o['id']}/payments",{**pay,'id':uid(),'version':o['version'],'amount':'0'})[0]==400,'reject zero payment')
# Closed cycles allow fulfilment and collection.
good('PATCH',f"/rounds/{r['id']}",{'status':'CLOSED'})
d2={'id':uid(),'version':o['version'],'deliveredAt':'2026-09-29T12:00:00Z','items':[{'orderItemId':i['id'],'quantity':str(float(i['quantity'])-float(i['deliveredQuantity']))} for i in o['items']]}
o=good('POST',f"/orders/{o['id']}/deliveries",d2)
check(o['deliveryStatus']=='DELIVERED' and o['paymentStatus']=='PARTIAL','delivered but unpaid remainder in closed cycle')
o=good('POST',f"/orders/{o['id']}/payments",{**pay,'id':uid(),'version':o['version'],'amount':'87.50','method':'TRANSFER'})
check(o['paymentStatus']=='PAID' and o['balance']=='0.00','full payment automatically marks paid')
o=good('POST',f"/orders/{o['id']}/payments/{pay['id']}/void",{'reason':'Corrección de prueba'})
check(o['paymentStatus']=='PARTIAL' and o['balance']=='50.00' and len(o['payments'])==2,'void preserves history and recalculates balance')
check(lot()['reserved']=='0' and lot()['onHand']=='2','delivery reduces on-hand, leaves extras')
r2=good('POST','/rounds',{'name':'Siguiente ciclo '+u,'opensAt':'2026-09-29T00:00:00Z','closesAt':'2026-10-02T00:00:00Z'})
body={'roundId':r2['id'],'customerId':c['id'],'items':[{**line,'source':'STOCK','quantity':'1.5'}]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:codes=list(pool.map(lambda _:call('POST','/orders',body)[0],range(2)))
check(sorted(codes)==[201,409],'concurrent stock buyers cannot oversell across cycles')
check(lot()['available']=='0.5','prior cycle lot remains available in next cycle')
w={'id':uid(),'receiptItemId':lot()['id'],'quantity':'0.5','reason':'SAMPLE'}
good('POST','/inventory/withdrawals',w);good('POST','/inventory/withdrawals',w)
check(lot()['available']=='0','sample withdrawal idempotent and reduces free stock')
check(call('POST','/inventory/withdrawals',{**w,'id':uid()})[0]==400,'cannot withdraw reserved inventory')
# New demand must still be purchased after extras were sold/withdrawn.
new=good('POST','/orders',{'roundId':r2['id'],'customerId':c['id'],'items':[{**line,'quantity':'0.5'}]})
summary=good('GET',f"/rounds/{r2['id']}/purchase-summary")
check(summary['groups'][0]['items'][0]['pendingToBuy']=='0.5','new preorder shortage excludes consumed old extras')
incoming=good('POST','/purchases',{'id':uid(),'roundId':r2['id'],'supplierId':s['id'],'orderedAt':'2026-09-29T14:00:00Z','items':[{'productId':p['id'],'quantity':'1','quotedUnitCost':'30'}]})
summary=good('GET',f"/rounds/{r2['id']}/purchase-summary")
check(summary['groups'][0]['items'][0]['pendingToBuy']=='0','pending supplier purchase prevents buying twice')
check(lot()['available']=='0','unreceived purchase is not sellable inventory')
# Purchases are editable only while their cycle is open, never below what arrived.
item=lambda q,prod=None:{'productId':(prod or p)['id'],'quantity':q,'quotedUnitCost':'30'}
purchase=next(x for x in good('GET',f"/purchases?roundId={r['id']}") if x['id']==purchase['id'])
check(call('PATCH',f"/purchases/{purchase['id']}",{'version':purchase['version'],'items':[item('6')]})[0]==409,'closed cycle blocks purchase edits')
good('PATCH',f"/rounds/{r['id']}",{'status':'OPEN'})
check(call('PATCH',f"/purchases/{purchase['id']}",{'version':purchase['version'],'items':[item('4')]})[0]==400,'cannot order less than received')
p2=good('POST','/products',{'name':'Quesillo edición '+u,'salePrice':'60','estimatedCost':'40','defaultSupplierId':s['id']})
check(call('PATCH',f"/purchases/{purchase['id']}",{'version':purchase['version'],'items':[item('2',p2)]})[0]==400,'cannot remove a received product')
edited=good('PATCH',f"/purchases/{purchase['id']}",{'version':purchase['version'],'items':[item('6.5'),item('2',p2)]})
check(edited['version']==purchase['version']+1 and len(edited['items'])==2,'reopened cycle allows growing and adding lines')
check(call('PATCH',f"/purchases/{purchase['id']}",{'version':purchase['version'],'items':[item('7')]})[0]==409,'stale purchase version is rejected')
line5=next(i for i in edited['items'] if i['productId']==p['id'])
edited=good('POST',f"/purchases/{purchase['id']}/receipts",{'id':uid(),'version':edited['version'],'receivedAt':'2026-09-29T16:00:00Z','invoice':'INV2 '+u,'globalDiscount':'0','items':[{'purchaseItemId':line5['id'],'quantity':'1.5','unitCost':'31','unitDiscount':'0'}]})
check(sum(float(x['quantity']) for rc in edited['receipts'] for x in rc['items'] if x['purchaseItemId']==line5['id'])==6.5,'added pounds can be received after editing')
edited=good('PATCH',f"/purchases/{purchase['id']}",{'version':edited['version'],'items':[item('6.5')]})
check(len(edited['items'])==1,'unreceived added product can be removed')
good('PATCH',f"/rounds/{r['id']}",{'status':'CLOSED'})
good('POST','/auth/logout')
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))

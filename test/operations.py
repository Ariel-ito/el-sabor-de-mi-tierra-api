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
# Closing requires every encargo delivered and every free pound decided.
check(call('PATCH',f"/rounds/{r['id']}",{'status':'CLOSED'})[0]==409,'pending deliveries block a direct close')
state=good('GET',f"/rounds/{r['id']}/closing")
check(len(state['pendingDeliveries'])==1 and state['leftovers'][0]['available']=='2','closing lists pending deliveries and leftovers')
check(call('POST',f"/rounds/{r['id']}/close",{'decisions':[]})[0]==409,'guided close is blocked by pending deliveries')
d2={'id':uid(),'version':o['version'],'deliveredAt':'2026-09-29T12:00:00Z','items':[{'orderItemId':i['id'],'quantity':str(float(i['quantity'])-float(i['deliveredQuantity']))} for i in o['items']]}
o=good('POST',f"/orders/{o['id']}/deliveries",d2)
leftover=good('GET',f"/rounds/{r['id']}/closing")['leftovers'][0]['receiptItemId']
check(call('POST',f"/rounds/{r['id']}/close",{'decisions':[{'receiptItemId':leftover,'reason':'KEEP','quantity':'1.5'}]})[0]==400,'every leftover pound needs a destination')
good('POST',f"/rounds/{r['id']}/close",{'decisions':[{'receiptItemId':leftover,'reason':'KEEP','quantity':'2'}]})
check(next(x for x in good('GET','/rounds') if x['id']==r['id'])['status']=='CLOSED','kept stock closes the cycle')
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
# Purchases are editable only while their cycle is open and before any invoice.
item=lambda q,prod=None:{'productId':(prod or p)['id'],'quantity':q,'quotedUnitCost':'30'}
purchase=next(x for x in good('GET',f"/purchases?roundId={r['id']}") if x['id']==purchase['id'])
good('PATCH',f"/rounds/{r['id']}",{'status':'OPEN'})
check(call('PATCH',f"/purchases/{purchase['id']}",{'version':purchase['version'],'items':[item('6')]})[0]==409,'invoiced purchase cannot be edited')
p2=good('POST','/products',{'name':'Quesillo edición '+u,'salePrice':'60','estimatedCost':'40','defaultSupplierId':s['id']})
pe=good('POST','/purchases',{'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':'2026-09-29T10:00:00Z','items':[item('2')]})
edited=good('PATCH',f"/purchases/{pe['id']}",{'version':pe['version'],'items':[item('3'),item('2',p2)]})
check(edited['version']==pe['version']+1 and len(edited['items'])==2,'open cycle allows growing and adding lines before invoice')
check(call('PATCH',f"/purchases/{pe['id']}",{'version':pe['version'],'items':[item('4')]})[0]==409,'stale purchase version is rejected')
edited=good('PATCH',f"/purchases/{pe['id']}",{'version':edited['version'],'items':[item('3')]})
check(len(edited['items'])==1,'product can be removed before invoice')
edited=good('POST',f"/purchases/{pe['id']}/receipts",{'id':uid(),'version':edited['version'],'receivedAt':'2026-09-29T16:00:00Z','invoice':'INV2 '+u,'globalDiscount':'0','items':[{'purchaseItemId':edited['items'][0]['id'],'quantity':'3','unitCost':'31','unitDiscount':'0'}]})
check(sum(float(x['quantity']) for rc in edited['receipts'] for x in rc['items'])==3,'edited purchase can be received')
check(call('PATCH',f"/purchases/{pe['id']}",{'version':edited['version'],'items':[item('5')]})[0]==409,'purchase locks once invoiced')
pf=good('POST','/purchases',{'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':'2026-09-29T11:00:00Z','items':[item('1')]})
state=good('GET',f"/rounds/{r['id']}/closing")
good('POST',f"/rounds/{r['id']}/close",{'decisions':[{'receiptItemId':l['receiptItemId'],'reason':'KEEP','quantity':l['available']} for l in state['leftovers']]})
check(call('PATCH',f"/purchases/{pf['id']}",{'version':pf['version'],'items':[item('2')]})[0]==409,'closed cycle blocks purchase edits')
# Walk-in sales use free stock of any cycle, even closed, and count in the lot's cycle.
free=lambda:sum(float(l['available']) for l in good('GET','/inventory') if l['productId']==p['id'])
before=free()
sale={'id':uid(),'soldAt':'2026-09-30T10:00:00Z','items':[{'productId':p['id'],'quantity':'1','unitPrice':'48'}],'payment':{'amount':'48.00','method':'CASH'}}
sold=good('POST','/sales',sale)
check(sold['kind']=='DIRECT' and sold['deliveryStatus']=='DELIVERED' and sold['paymentStatus']=='PAID','walk-in sale is delivered and paid on the spot')
check(sold['roundId']==r['id'] and free()==before-1,'sale consumes free stock and counts in the lot cycle')
check(good('POST','/sales',sale)['id']==sold['id'] and free()==before-1,'sale retry is idempotent')
check(all(x['id']!=sold['id'] for x in good('GET',f"/orders?roundId={r['id']}")),'walk-in sales stay out of the encargo list')
check(any(x['id']==sold['id'] for x in good('GET','/sales')),'walk-in sales are listed apart')
check(call('POST','/sales',{**sale,'id':uid(),'items':[{**sale['items'][0],'quantity':'500'}]})[0]==400,'cannot sell more than free stock')
check(call('PATCH',f"/orders/{sold['id']}",{'version':sold['version'],'notes':'x'})[0]==400,'walk-in sales are not edited as encargos')
unpaid={'id':uid(),'soldAt':sale['soldAt'],'items':[{**sale['items'][0],'quantity':'0.5'}]}
credit=good('POST','/sales',unpaid)
check(credit['paymentStatus']=='UNPAID' and credit['balance']=='24.00','unpaid walk-in sale becomes a debt')
# Losses and samples at close are absorbed cost of the cycle that bought them.
r3=good('POST','/rounds',{'name':'Cierre con merma '+u,'opensAt':'2026-09-29T00:00:00Z','closesAt':'2026-10-03T00:00:00Z'})
buy=good('POST','/purchases',{'id':uid(),'roundId':r3['id'],'supplierId':s['id'],'orderedAt':'2026-09-29T14:00:00Z','items':[{'productId':p['id'],'quantity':'3','quotedUnitCost':'40'}]})
good('POST',f"/purchases/{buy['id']}/receipts",{'id':uid(),'version':buy['version'],'receivedAt':'2026-09-29T15:00:00Z','invoice':'INV3 '+u,'globalDiscount':'0','items':[{'purchaseItemId':buy['items'][0]['id'],'quantity':'3','unitCost':'40','unitDiscount':'0'}]})
lot3=good('GET',f"/rounds/{r3['id']}/closing")['leftovers'][0]['receiptItemId']
good('POST',f"/rounds/{r3['id']}/close",{'decisions':[{'receiptItemId':lot3,'reason':'LOSS','quantity':'2'},{'receiptItemId':lot3,'reason':'SAMPLE','quantity':'1'}]})
cyc=next(c for c in good('GET','/statistics')['cycles'] if c['id']==r3['id'])
check(cyc['absorbed']['loss']['cost']=='80.00' and cyc['absorbed']['sample']['pounds']=='1' and cyc['absorbed']['total']=='120.00','close records loss and samples as absorbed cost')
check(call('POST',f"/rounds/{r3['id']}/close",{'decisions':[]})[0]==409,'a closed cycle cannot be closed again')
# An encargo bought from another supplier is still reserved and deliverable,
# without taking lots from a supplier's own encargos first.
sA=good('POST','/suppliers',{'name':'Proveedor A '+u,'region':'Olancho'})
sB=good('POST','/suppliers',{'name':'Proveedor B '+u,'region':'Sur'})
pq=good('POST','/products',{'name':'Quesillo cruzado '+u,'salePrice':'75','estimatedCost':'50','defaultSupplierId':sA['id']})
r4=good('POST','/rounds',{'name':'Proveedor cruzado '+u,'opensAt':'2026-09-29T00:00:00Z','closesAt':'2026-10-04T00:00:00Z'})
oa=good('POST','/orders',{'roundId':r4['id'],'customerId':c['id'],'items':[{'productId':pq['id'],'supplierId':sA['id'],'quantity':'2','unitPrice':'75'}]})
ob=good('POST','/orders',{'roundId':r4['id'],'customerId':c['id'],'items':[{'productId':pq['id'],'supplierId':sB['id'],'quantity':'1','unitPrice':'75'}]})
bb=good('POST','/purchases',{'id':uid(),'roundId':r4['id'],'supplierId':sB['id'],'orderedAt':'2026-09-29T14:00:00Z','items':[{'productId':pq['id'],'quantity':'3','quotedUnitCost':'50'}]})
good('POST',f"/purchases/{bb['id']}/receipts",{'id':uid(),'version':bb['version'],'receivedAt':'2026-09-29T15:00:00Z','invoice':'INV4 '+u,'globalDiscount':'0','items':[{'purchaseItemId':bb['items'][0]['id'],'quantity':'3','unitCost':'50','unitDiscount':'0'}]})
byId={o['id']:o for o in good('GET',f"/orders?roundId={r4['id']}")}
check(byId[ob['id']]['items'][0]['reservedQuantity']=='1','supplier own encargo keeps its lot first')
check(byId[oa['id']]['items'][0]['reservedQuantity']=='2','encargo bought from another supplier is reserved')
oa=byId[oa['id']]
oa=good('POST',f"/orders/{oa['id']}/deliveries",{'id':uid(),'version':oa['version'],'deliveredAt':'2026-09-29T16:00:00Z','items':[{'orderItemId':oa['items'][0]['id'],'quantity':'2'}]})
check(oa['deliveryStatus']=='DELIVERED','cross-supplier encargo can be delivered')
good('POST','/auth/logout')
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))

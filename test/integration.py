"""Independent end-to-end smoke checks against a LOCAL test database only."""
import json, os, urllib.request, urllib.error, uuid, concurrent.futures
base=os.environ.get('DAIRY_TEST_URL','http://127.0.0.1:4100/api/v1')
assert base.startswith(('http://127.0.0.1:', 'http://localhost:')), 'Local test server only'
passed=[]
def check(condition, label):
    assert condition, label
    passed.append(label)
def req(method,path,payload=None,token=None):
    headers={'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    request=urllib.request.Request(base+path,data=json.dumps(payload).encode() if payload is not None else None,headers=headers,method=method)
    try:
        with urllib.request.urlopen(request,timeout=15) as r: return r.status,json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read() or b'{}')
def good(method,path,payload=None,token=None):
    status,data=req(method,path,payload,token)
    assert status in (200,201), (method,path,status,data)
    return data
for path in ['/customers','/suppliers','/products','/rounds','/orders','/statistics']:
    check(req('GET',path)[0]==401,'private '+path)
user=good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})
token=user['accessToken']; check(bool(good('GET','/auth/me',token=token)['email']),'authenticated session')
u=uuid.uuid4().hex[:8]
s1=good('POST','/suppliers',{'name':'QA Olancho '+u,'region':'Olancho'},token)
s2=good('POST','/suppliers',{'name':'QA Sur '+u,'region':'Sur'},token)
c=good('POST','/customers',{'name':'QA Cliente '+u},token)
p=good('POST','/products',{'name':'QA Crema '+u,'salePrice':'70.00','estimatedCost':'53.00','defaultSupplierId':s1['id']},token)
check(s1['phoneCountryCode']=='+504','Honduras default code')
s1=good('PATCH','/suppliers/'+s1['id'],{'name':s1['name'],'region':'Olancho','phoneCountryCode':'+503','phone':'77770000','deliveryContactName':'QA Entrega','deliveryContactPhone':'99990000','deliveryContactCountryCode':'+504'},token)
check(s1['deliveryContactName']=='QA Entrega' and s1['phoneCountryCode']=='+503','edit supplier delivery and country code')
c=good('PATCH','/customers/'+c['id'],{'name':c['name'],'phone':'88880000','phoneCountryCode':'+504','notes':'QA edit'},token)
check(c['notes']=='QA edit' and c['phone']=='88880000','edit customer contact')
check(req('PATCH','/suppliers/'+s1['id'],{'name':s1['name'],'region':'Sur','phoneCountryCode':'javascript:'},token)[0]==400,'reject invalid country code')
p2=good('POST','/products',{'name':p['name'],'salePrice':'72','estimatedCost':'54','defaultSupplierId':s2['id']},token)
check(p2['id']!=p['id'] and p2['name']==p['name'],'same name distinct supplier products')
r=good('POST','/rounds',{'name':'QA Ronda '+u,'opensAt':'2026-09-28T06:00:00.000Z','closesAt':'2026-10-02T06:00:00.000Z'},token)
item={'productId':p['id'],'supplierId':s2['id'],'quantity':'0.5','unitPrice':'53.01'}
order=good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[item]},token)
check(order['total']=='26.51','half-up rounding per line')
good('PATCH','/products/'+p['id'],{'salePrice':'90.00','estimatedCost':'60.00'},token)
orders=good('GET','/orders?roundId='+r['id'],token=token)
check(orders[0]['items'][0]['unitPrice']=='53.01','catalog edit preserves saved sale price')
check(orders[0]['items'][0]['estimatedUnitCost']=='53.00','catalog edit preserves saved estimated cost')
check(orders[0]['profitability']['estimatedProfit']=='0.01','half-pound profit rounds both line totals')
sumry=good('GET','/rounds/'+r['id']+'/purchase-summary',token=token)
check(len(sumry['groups'])==1 and sumry['groups'][0]['supplierId']==s2['id'],'actual selected supplier grouping')
for quantity in ['0','-0.5','0.3','1.001']:
    bad={**item,'quantity':quantity}
    check(req('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[bad]},token)[0]==400,'reject quantity '+quantity)
check(req('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[]},token)[0]==400,'reject empty order')
check(req('POST','/products',{'name':'Bad','salePrice':'1.001','estimatedCost':'1','defaultSupplierId':s1['id']},token)[0]==400,'reject price overprecision')
check(req('POST','/customers',{'name':'Bad','admin':True},token)[0]==400,'reject unknown fields')
status,_=req('PATCH','/orders/'+order['id'],{'version':order['version'],'items':[{**item,'productId':str(uuid.uuid4())}]},token)
check(400<=status<500,'reject invalid product reference')
unchanged=good('GET','/orders?roundId='+r['id'],token=token)[0]
check(unchanged['version']==order['version'] and unchanged['total']==order['total'],'invalid update leaves order intact')
update={'version':order['version'],'items':[{**item,'quantity':'1.5'}]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    statuses=list(pool.map(lambda _:req('PATCH','/orders/'+order['id'],update,token)[0], range(2)))
check(sorted(statuses)==[200,409],'concurrent edit exactly one success')
revised=good('GET','/orders?roundId='+r['id'],token=token)[0]
check(revised['items'][0]['estimatedUnitCost']=='53.00','quantity edit retains estimated cost')
reports=good('GET','/statistics',token=token)
cycle=next(x for x in reports['cycles'] if x['id']==r['id'])
check(cycle['sales']=='79.52' and cycle['estimatedCost']=='79.50' and cycle['estimatedProfit']=='0.02','cycle profitability uses historical cost')
check(cycle['customerCount']==1 and cycle['orderCount']==1,'cycle counts')
good('PATCH','/rounds/'+r['id'],{'status':'CLOSED'},token)
check(req('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[item]},token)[0] in (400,409),'closed round rejects new order')
updated=good('PATCH','/rounds/'+r['id'],{'name':'Ciclo histórico '+u,'opensAt':'2026-09-01T14:00:00.000Z','closesAt':'2026-09-05T00:00:00.000Z'},token)
check(updated['status']=='CLOSED' and updated['createdAt']==r['createdAt'],'historical dates preserve status and creation timestamp')
check(good('GET','/orders?roundId='+r['id'],token=token)[0]['id']==order['id'],'cycle edit preserves associated orders')
for patch in [{'closesAt':'2026-08-01T00:00:00Z'},{'opensAt':None},{'name':'   '},{'createdAt':'2020-01-01T00:00:00Z'}]:
    check(req('PATCH','/rounds/'+r['id'],patch,token)[0]==400,'reject invalid cycle patch '+str(patch))
check(good('PATCH','/rounds/'+r['id'],{'status':'OPEN'},token)['status']=='OPEN','reopen edited cycle')
check(req('GET','/purchases')[0]==401,'purchases private')
purchase_id=str(uuid.uuid4())
po=good('POST','/purchases',{'id':purchase_id,'roundId':r['id'],'supplierId':s1['id'],'orderedAt':'2026-09-01T12:00:00Z','items':[{'productId':p['id'],'quantity':'4','quotedUnitCost':'53'}]},token)
check(good('POST','/purchases',{'id':purchase_id,'roundId':r['id'],'supplierId':s1['id'],'orderedAt':'2026-09-01T12:00:00Z','items':[{'productId':p['id'],'quantity':'4','quotedUnitCost':'53'}]},token)['id']==po['id'],'purchase retry idempotent')
receipt={'id':str(uuid.uuid4()),'version':po['version'],'receivedAt':'2026-09-24T12:00:00Z','invoice':'QA-1','globalDiscount':'0','items':[{'purchaseItemId':po['items'][0]['id'],'quantity':'2','unitCost':'55','unitDiscount':'1'}]}
received=good('POST','/purchases/'+po['id']+'/receipts',receipt,token)
check(str(received['receipts'][0]['total'])=='108','receipt applies per-pound discount')
prod=lambda:next(x for x in good('GET','/products',token=token) if x['id']==p['id'])
check(prod()['estimatedCost']=='54.00' and prod()['salePrice']=='90.00','receipt changes catalog cost only')
check(len(good('POST','/purchases/'+po['id']+'/receipts',receipt,token)['receipts'])==1,'receipt retry idempotent')
check(good('GET','/orders?roundId='+r['id'],token=token)[0]['items'][0]['estimatedUnitCost']=='53.00','receipt preserves old order estimate')
bad={**receipt,'id':str(uuid.uuid4()),'version':received['version'],'items':[{**receipt['items'][0],'quantity':'3'}]}
check(req('POST','/purchases/'+po['id']+'/receipts',bad,token)[0]==400,'cannot receive beyond pending quantity')
older={**receipt,'id':str(uuid.uuid4()),'version':received['version'],'receivedAt':'2026-09-20T12:00:00Z','invoice':'QA-OLD','globalDiscount':'2','items':[{**receipt['items'][0],'unitCost':'51','unitDiscount':'0'}]}
received=good('POST','/purchases/'+po['id']+'/receipts',older,token)
check(prod()['estimatedCost']=='54.00','backdated receipt cannot replace newer cost')
history=good('GET','/products/'+p['id']+'/cost-history',token=token)
check(len(history)==2 and str(history[0]['effectiveUnitCost'])=='50','history ordered by receipt date with global discount')
check(req('POST','/purchases/'+po['id']+'/receipts',{**receipt,'id':str(uuid.uuid4())},token)[0]==409,'stale purchase version rejected')
po2=good('POST','/purchases',{'roundId':r['id'],'supplierId':s1['id'],'orderedAt':'2026-09-25T12:00:00Z','items':[{'productId':p['id'],'quantity':'1','quotedUnitCost':'54'}]},token)
r2={**receipt,'id':str(uuid.uuid4()),'version':1,'receivedAt':'2026-09-26T12:00:00Z','invoice':'QA-NEW','items':[{'purchaseItemId':po2['items'][0]['id'],'quantity':'1','unitCost':'80','unitDiscount':'0'}]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results=list(pool.map(lambda _:req('POST','/purchases/'+po2['id']+'/receipts',{**r2,'id':str(uuid.uuid4())},token)[0],range(2)))
check(sorted(results)==[201,409],'concurrent receipts cannot duplicate quantities')
check(prod()['estimatedCost']=='80.00','latest received price becomes current cost')

good('POST','/auth/logout',{},token)
check(req('GET','/auth/me',token=token)[0]==401,'logout invalidates token')
print(json.dumps({'passed':len(passed),'checks':passed},ensure_ascii=False,indent=2))

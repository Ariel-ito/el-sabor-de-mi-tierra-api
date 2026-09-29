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
for path in ['/customers','/suppliers','/products','/rounds','/orders']:
    check(req('GET',path)[0]==401,'private '+path)
user=good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})
token=user['accessToken']; check(bool(good('GET','/auth/me',token=token)['email']),'authenticated session')
u=uuid.uuid4().hex[:8]
s1=good('POST','/suppliers',{'name':'QA Olancho '+u,'region':'Olancho'},token)
s2=good('POST','/suppliers',{'name':'QA Sur '+u,'region':'Sur'},token)
c=good('POST','/customers',{'name':'QA Cliente '+u},token)
p=good('POST','/products',{'name':'QA Crema '+u,'salePrice':'70.00','estimatedCost':'53.00','defaultSupplierId':s1['id']},token)
r=good('POST','/rounds',{'name':'QA Ronda '+u,'opensAt':'2026-09-28T06:00:00.000Z','closesAt':'2026-10-02T06:00:00.000Z'},token)
item={'productId':p['id'],'supplierId':s2['id'],'quantity':'0.5','unitPrice':'53.01'}
order=good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[item]},token)
check(order['total']=='26.51','half-up rounding per line')
good('PATCH','/products/'+p['id'],{'salePrice':'90.00'},token)
orders=good('GET','/orders?roundId='+r['id'],token=token)
check(orders[0]['items'][0]['unitPrice']=='53.01','catalog edit preserves saved sale price')
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
good('PATCH','/rounds/'+r['id'],{'status':'CLOSED'},token)
check(req('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[item]},token)[0] in (400,409),'closed round rejects new order')
updated=good('PATCH','/rounds/'+r['id'],{'name':'Ciclo histórico '+u,'opensAt':'2026-09-01T14:00:00.000Z','closesAt':'2026-09-05T00:00:00.000Z'},token)
check(updated['status']=='CLOSED' and updated['createdAt']==r['createdAt'],'historical dates preserve status and creation timestamp')
check(good('GET','/orders?roundId='+r['id'],token=token)[0]['id']==order['id'],'cycle edit preserves associated orders')
for patch in [{'closesAt':'2026-08-01T00:00:00Z'},{'opensAt':None},{'name':'   '},{'createdAt':'2020-01-01T00:00:00Z'}]:
    check(req('PATCH','/rounds/'+r['id'],patch,token)[0]==400,'reject invalid cycle patch '+str(patch))
check(good('PATCH','/rounds/'+r['id'],{'status':'OPEN'},token)['status']=='OPEN','reopen edited cycle')
good('POST','/auth/logout',{},token)
check(req('GET','/auth/me',token=token)[0]==401,'logout invalidates token')
print(json.dumps({'passed':len(passed),'checks':passed},ensure_ascii=False,indent=2))

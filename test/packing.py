"""Quantity packing against a disposable local API; never production."""
import os, json, uuid, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from decimal import Decimal
base = os.environ.get('DAIRY_TEST_URL', 'http://127.0.0.1:4103/api/v1')
assert base.startswith(('http://localhost:', 'http://127.0.0.1:')), 'Local test server only'
token = None
uid = lambda: str(uuid.uuid4())
now = datetime.now(timezone.utc)-timedelta(minutes=5)
iso = lambda d: d.isoformat(timespec='seconds')
checks = []
def call(method, path, body=None):
    headers = {'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    req = urllib.request.Request(base+path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=30) as res: return res.status,json.load(res)
    except urllib.error.HTTPError as e: return e.code,json.load(e)
def good(method,path,body=None):
    code,data=call(method,path,body)
    assert code in (200,201),(path,code,data)
    return data
def check(ok,label):
    assert ok,label
    checks.append(label)
token=good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag=uid()[:6]
s1=good('POST','/suppliers',{'name':'Lácteos empaque '+tag,'region':'Olancho'})
s2=good('POST','/suppliers',{'name':'Panadería empaque '+tag,'region':'Sur'})
c=good('POST','/customers',{'name':'Cliente empaque '+tag})
p1=good('POST','/products',{'name':'Cuajada empaque '+tag,'unit':'lb','salePrice':'70','estimatedCost':'50','defaultSupplierId':s1['id']})
p2=good('POST','/products',{'name':'Rosquillas empaque '+tag,'unit':'unidad','salePrice':'5','estimatedCost':'3','defaultSupplierId':s2['id']})
r=good('POST','/rounds',{'name':'Empaque QA '+tag,'opensAt':iso(now-timedelta(days=1)),'closesAt':iso(now+timedelta(days=7))})
def new_order(lines):
    return good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'partialOk':False,'items':[{'productId':p['id'],'supplierId':s['id'],'quantity':str(q),'unitPrice':p['salePrice']} for p,s,q in lines]})
o=new_order([(p1,s1,2),(p2,s2,20)])
path='/orders/'+o['id']
def get(): return good('GET',path)
def line(product,order=None): return next(i for i in (order or get())['items'] if i['productId']==product['id'])
def receipt(p,s,q):
    buy=good('POST','/purchases',{'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':iso(now),'items':[{'productId':p['id'],'quantity':str(q),'quotedUnitCost':p['estimatedCost']}]})
    return good('POST','/purchases/'+buy['id']+'/receipts',{'id':uid(),'version':buy['version'],'receivedAt':iso(now),'invoice':'EMPAQUE '+tag,'globalDiscount':'0','items':[{'purchaseItemId':buy['items'][0]['id'],'quantity':str(q),'unitCost':p['estimatedCost'],'unitDiscount':'0'}]})
def body(product,q,mode='PACK'):
    order=get()
    return {'id':uid(),'version':order['version'],'mode':mode,'items':[{'orderItemId':line(product,order)['id'],'quantity':str(q)}]}
def pack(product,q,mode='PACK'):
    return good('POST',path+'/packing/quantities',body(product,q,mode))
check(call('POST',path+'/packing/quantities',body(p1,1))[0]==400,'unreceived stock cannot be packed')
receipt(p1,s1,1)
check(get()['partialOk'] is False and line(p1)['reservedQuantity']=='1','partial stock is reserved even for a joint delivery')
first=body(p1,'0.5')
o=good('POST',path+'/packing/quantities',first)
check(line(p1,o)['packedQuantity']=='0.5' and line(p2,o)['packedQuantity']=='0','partial quantity on a line, without partial delivery permission')
good('POST',path+'/packing/quantities',first)
check(len(good('GET',path+'/packing'))==1,'retry preserves exactly one history entry')
check(call('POST',path+'/packing/quantities',{**first,'items':[{'orderItemId':line(p1)['id'],'quantity':'1'}]})[0]==409,'id cannot be reused for another packing quantity')
check(call('POST',path+'/packing/quantities',{**first,'id':uid()})[0]==409,'stale second phone is rejected')
check(call('POST',path+'/packing/quantities',body(p1,'1.5'))[0]==400,'cannot exceed available reserved stock')
check(call('POST',path+'/packing/quantities',body(p1,'-1'))[0]==400,'negative quantity rejected')
check(call('POST',path+'/packing/quantities',body(p1,'0.5001'))[0]==400,'precision beyond inventory scale rejected')
check(call('POST',path+'/packing/quantities',body(p1,'0.25'))[0]==400,'reductions require explicit edit')
check(line(p1,pack(p1,'0.25','EDIT'))['packedQuantity']=='0.25','manual correction can reduce packing')
receipt(p1,s1,1)
check(line(p1)['packedQuantity']=='0.25' and line(p1)['reservedQuantity']=='2','new receipt preserves already packed quantities')
pack(p1,2)
receipt(p2,s2,20)
check(line(p1)['packedQuantity']=='2' and line(p2)['packedQuantity']=='0','bakery arrival does not silently mark packing complete')
check(call('POST',path+'/packing/quantities',body(p2,'0.5'))[0]==400,'whole-unit product cannot be packed as fractions')
pack(p2,20)
check(all(Decimal(i['packedQuantity'])==Decimal(i['quantity']) for i in get()['items']),'all lines can become fully packed')
# Simultaneous edits from two phones must not overwrite each other.
competing=body(p1,1,'EDIT')
with ThreadPoolExecutor(max_workers=2) as pool:
    codes=sorted(pool.map(lambda b:call('POST',path+'/packing/quantities',b)[0],[competing,{**competing,'id':uid(),'items':[{'orderItemId':line(p1)['id'],'quantity':'1.5'}]}]))
check(codes==[201,409],'concurrent quantity edits serialize with one conflict')
pack(p1,2)
o=get()
good('PATCH',path,{'version':o['version'],'items':[{'id':i['id'],'productId':i['productId'],'supplierId':i['supplierId'],'quantity':i['quantity'],'unitPrice':'75' if i['productId']==p1['id'] else i['unitPrice']} for i in o['items']]})
check(line(p1)['packedQuantity']=='2' and line(p2)['packedQuantity']=='20','price-only edit preserves physical packing')
o=get()
good('PATCH',path,{'version':o['version'],'items':[{'id':i['id'],'productId':i['productId'],'supplierId':i['supplierId'],'quantity':'3' if i['productId']==p1['id'] else i['quantity'],'unitPrice':i['unitPrice']} for i in o['items']]})
check(line(p1)['packedQuantity']=='2' and line(p2)['packedQuantity']=='20','increasing requested quantity preserves other packed lines')
receipt(p1,s1,1)
o=get()
good('POST',path+'/deliveries',{'id':uid(),'version':o['version'],'deliveredAt':iso(now+timedelta(minutes=1)),'items':[{'orderItemId':line(p1,o)['id'],'quantity':'1'}]})
check(line(p1)['packedQuantity']=='1' and line(p1)['deliveredQuantity']=='1' and line(p2)['packedQuantity']=='20','partial delivery subtracts only delivered packing and preserves the other product')
# A failure in the second line rolls back the first line too.
b=body(p1,2);b['items'].append({'orderItemId':uid(),'quantity':'1'})
check(call('POST',path+'/packing/quantities',b)[0]==400 and line(p1)['packedQuantity']=='1','invalid multi-line confirmation is atomic')
revert={'id':uid(),'version':get()['version'],'mode':'REVERT','items':[{'orderItemId':i['id'],'quantity':'0'} for i in get()['items']]}
reserved=[i['reservedQuantity'] for i in get()['items']]
o=good('POST',path+'/packing/quantities',revert)
check(all(i['packedQuantity']=='0' for i in o['items']) and [i['reservedQuantity'] for i in o['items']]==reserved,'reversal frees packing marks without releasing customer reservations')
h=good('GET',path+'/packing')
check(h[0]['mode']=='REVERT' and h[0]['actor'] and len(h[0]['changes'])==2,'history records author, time and exact changes')
# Older deployed clients continue to work with quantity-safe operations.
good('POST',path+'/packing',{'items':[line(p1)['id']],'packed':True})
check(line(p1)['packedQuantity']=='2','legacy web confirmation packs only remaining reserved quantity')
good('POST',path+'/packing',{'items':[line(p1)['id']],'packed':False})
check(line(p1)['packedQuantity']=='0','legacy undo also clears quantity')
# Adding a new line cannot erase existing physical packing.
pack(p1,2)
p3=good('POST','/products',{'name':'Crema empaque '+tag,'unit':'lb','salePrice':'70','estimatedCost':'50','defaultSupplierId':s1['id']})
o=get()
good('PATCH',path,{'version':o['version'],'items':[{'id':i['id'],'productId':i['productId'],'supplierId':i['supplierId'],'quantity':i['quantity'],'unitPrice':i['unitPrice']} for i in o['items']]+[{'productId':p3['id'],'supplierId':s1['id'],'quantity':'0.5','unitPrice':'70'}]})
check(line(p1)['packedQuantity']=='2' and line(p3)['packedQuantity']=='0','adding a product preserves existing packing and leaves the new product unpacked')
# Leave a useful mobile QA case: half of the remaining dairy packed; bakery ready.
pack(p1,'0.5','EDIT')
print(json.dumps({'checks':len(checks),'tag':tag,'roundId':r['id'],'round':r['name'],'customer':c['name'],'orderId':o['id'],'supplierId':s1['id']},ensure_ascii=False))

"""Supplier-bound purchase products: catalog filters also enforced by API. LOCAL only."""
import os,json,uuid,urllib.request,urllib.error
from datetime import datetime,timezone,timedelta
base=os.environ.get('DAIRY_TEST_URL','http://127.0.0.1:4104/api/v1')
assert base.startswith(('http://localhost:','http://127.0.0.1:')),'Local server only'
token=None;checks=[];uid=lambda:str(uuid.uuid4())
now=datetime.now(timezone.utc)-timedelta(minutes=4);iso=lambda d:d.isoformat(timespec='seconds')
def call(method,path,body=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(base+path,method=method,headers=headers,data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req,timeout=40) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
def good(method,path,body=None):
    status,data=call(method,path,body);assert status in (200,201),(path,status,data);return data
def check(ok,label):assert ok,label;checks.append(label)
token=good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag=uid()[:6]
a=good('POST','/suppliers',{'name':'Amazon filtro '+tag,'region':'En línea'})
d=good('POST','/suppliers',{'name':'Las Delicias filtro '+tag,'region':'Local'})
r=good('POST','/rounds',{'name':'Compra por proveedor '+tag,'opensAt':iso(now-timedelta(days=1)),'closesAt':iso(now+timedelta(days=7))})
def product(s):return good('POST','/products',{'name':'Crema filtro '+tag,'unit':'frasco','salePrice':'100','estimatedCost':'60','defaultSupplierId':s['id']})
pa=product(a);pd=product(d)
def line(p,q='1'):return {'productId':p['id'],'quantity':q,'quotedUnitCost':'60'}
def buy(s,items):return {'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':iso(now),'items':items}
def purchases():return good('GET','/purchases?roundId='+r['id'])
first=good('POST','/purchases',buy(a,[line(pa)]))
other=good('POST','/purchases',buy(d,[line(pd)]))
check(first['items'][0]['productId']==pa['id'] and other['items'][0]['productId']==pd['id'],'identical product names keep their supplier-specific identities')
wrong=buy(a,[line(pd)]);code,error=call('POST','/purchases',wrong)
check(code==400 and 'no pertenece al proveedor' in error['message'],'ordinary purchases reject a product owned by another supplier')
check(not any(p['id']==wrong['id'] for p in purchases()),'rejected purchases leave no purchase record')
code,_=call('PATCH','/purchases/'+first['id'],{'version':first['version'],'items':[line(pa,'4'),line(pd)]})
check(code==400,'editing a purchase cannot add another supplier product')
unchanged=next(p for p in purchases() if p['id']==first['id'])
check(unchanged['version']==first['version'] and unchanged['items'][0]['quantity']=='1','a rejected edit does not partially change quantities or version')
direct={'id':uid(),'roundId':r['id'],'purchasedAt':iso(now),'newSupplier':{'name':'Proveedor inválido filtro '+tag,'region':'Local'},'globalDiscount':'0','items':[
    {'newProduct':{'name':'Producto rollback filtro '+tag,'categoryName':'Categoria rollback filtro '+tag,'unit':'frasco','salePrice':'100'},'quantity':'1','unitCost':'60','unitDiscount':'0'},
    {'productId':pa['id'],'quantity':'1','unitCost':'60','unitDiscount':'0'}]}
check(call('POST','/purchases/direct',direct)[0]==400,'buy-and-receive rejects an existing product from another supplier')
check(not any(s['name']==direct['newSupplier']['name'] for s in good('GET','/suppliers')),'rejected mixed-supplier receipt rolls back its new supplier')
check(not any(p['name']=='Producto rollback filtro '+tag for p in good('GET','/products')) and not any(c['name']=='Categoria rollback filtro '+tag for c in good('GET','/product-categories')),'rejected receipt rolls back inline product and category creation')
received=good('POST','/purchases/direct',{'id':uid(),'roundId':r['id'],'supplierId':d['id'],'purchasedAt':iso(now),'globalDiscount':'0','items':[{'productId':pd['id'],'quantity':'2','unitCost':'60','unitDiscount':'0'}]})
check(received['purchase']['supplierId']==d['id'] and received['purchase']['items'][0]['productId']==pd['id'],'the correct supplier product can still be bought and received normally')
# If the catalog provider is corrected after ordering, receipt creation also
# requires correcting the purchase attribution, rather than recording a mismatch.
good('PATCH','/products/'+pa['id'],{'defaultSupplierId':d['id'],'name':'Crema con proveedor corregido '+tag})
receipt={'id':uid(),'version':first['version'],'receivedAt':iso(now+timedelta(minutes=1)),'invoice':'FILTRO '+tag,'globalDiscount':'0','items':[{'purchaseItemId':first['items'][0]['id'],'quantity':'1','unitCost':'60','unitDiscount':'0'}]}
check(call('POST','/purchases/'+first['id']+'/receipts',receipt)[0]==400,'receipt creation checks the current product supplier too')
check(not next(p for p in purchases() if p['id']==first['id'])['receipts'],'a rejected receipt cannot create inventory or invoice records')
aligned=good('PATCH','/purchases/'+first['id']+'/supplier',{'id':uid(),'version':first['version'],'supplierId':d['id'],'correctCreatedProducts':False,'reason':'Catálogo corregido al proveedor real.'})
receipt['version']=aligned['version'];saved=good('POST','/purchases/'+first['id']+'/receipts',receipt)
check(saved['supplierId']==d['id'] and len(saved['receipts'])==1,'after attribution is corrected, the same pending purchase can be received')
print(json.dumps({'checks':len(checks),'roundId':r['id']},ensure_ascii=False))

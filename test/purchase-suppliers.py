"""Audited supplier corrections preserve received stock and paid deliveries. LOCAL only."""
import os,json,uuid,copy,urllib.request,urllib.error
from datetime import datetime,timezone,timedelta
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal as D
base=os.environ.get('DAIRY_TEST_URL','http://127.0.0.1:4104/api/v1')
assert base.startswith(('http://localhost:','http://127.0.0.1:')),'Local server only'
token=None;checks=[];uid=lambda:str(uuid.uuid4())
now=datetime.now(timezone.utc)-timedelta(minutes=5)
iso=lambda d:d.isoformat(timespec='seconds')
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
r=good('POST','/rounds',{'name':'Corrección proveedor '+tag,'opensAt':iso(now-timedelta(days=1)),'closesAt':iso(now+timedelta(days=7))})
wrong=good('POST','/suppliers',{'name':'Proveedor incorrecto '+tag,'region':'Local'})
def direct(items,supplier,date=now):return good('POST','/purchases/direct',{'id':uid(),'roundId':r['id'],'supplierId':supplier,'purchasedAt':iso(date),'invoice':'SUP '+tag,'globalDiscount':'0','items':items})
def line(name):return {'newProduct':{'name':name+' '+tag,'unit':'bote','salePrice':'100'},'quantity':'3','unitCost':'60','unitDiscount':'0'}
def existing(p,cost):return {'productId':p,'quantity':'1','unitCost':cost,'unitDiscount':'0'}
def catalog(id):return next(p for p in good('GET','/products') if p['id']==id)
def lots(p):
    ids={i['id'] for receipt in p['receipts'] for i in receipt['items']}
    return sorted([{k:v for k,v in lot.items() if k not in ('supplierName','supplierId')} for lot in good('GET','/inventory') if lot['id'] in ids],key=lambda l:l['id'])
initial=direct([line('Suplemento A'),line('Suplemento B')],wrong['id'])
p=initial['purchase'];product=initial['createdProducts'][0];path='/purchases/'+p['id']+'/supplier'
customer=good('POST','/customers',{'name':'Cliente proveedor '+tag})
order=good('POST','/orders',{'roundId':r['id'],'customerId':customer['id'],'items':[{'productId':product['id'],'supplierId':wrong['id'],'quantity':'1','unitPrice':'100'}]})
order_path='/orders/'+order['id']
order=good('POST',order_path+'/deliveries',{'id':uid(),'version':order['version'],'deliveredAt':iso(now+timedelta(minutes=1)),'items':[{'orderItemId':order['items'][0]['id'],'quantity':'1'}]})
order=good('POST',order_path+'/payments',{'id':uid(),'version':order['version'],'amount':'100','method':'CASH','paidAt':iso(now+timedelta(minutes=2))})
before_lots=lots(p);before_cash=good('GET','/finance/summary')['position']['cash']
command={'id':uid(),'version':p['version'],'newSupplier':{'name':'Amazon '+tag,'region':'En línea'},'correctCreatedProducts':True,'reason':'Proveedor incorrecto al registrar la compra.'}
with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:call('PATCH',path,command),range(2)))
check(all(status==200 for status,_ in results),'simultaneous correction retries both succeed')
corrected=results[0][1];amazon=corrected['supplierId']
check(corrected['supplier']['name']=='Amazon '+tag and corrected['version']==p['version']+1,'new supplier is created and assigned once')
check(len([s for s in good('GET','/suppliers') if s['name']=='Amazon '+tag])==1,'retries do not duplicate the supplier')
check(corrected['receipts']==p['receipts'],'all receipts retain IDs, amounts, dates, invoices and discounts')
check([(i['id'],i['quantity'],i['quotedUnitCost']) for i in corrected['items']]==[(i['id'],i['quantity'],i['quotedUnitCost']) for i in p['items']],'purchase line IDs and quantities are preserved')
check(lots(corrected)==before_lots,'stock, reservations, delivered quantities and expiry remain unchanged')
after_order=good('GET',order_path)
check(all(after_order[k]==order[k] for k in ['deliveries','payments','total','paid','balance']),'recorded deliveries and payments are untouched')
check(good('GET','/finance/summary')['position']['cash']==before_cash,'supplier correction does not create a cash movement')
check(all(catalog(item['id'])['defaultSupplierId']==amazon for item in initial['createdProducts']),'new products created in this purchase receive the corrected habitual supplier')
check(all(D(catalog(item['id'])['estimatedCost'])==60 for item in initial['createdProducts']),'effective catalog cost is preserved for the corrected invoice')
check(good('GET','/products/'+product['id']+'/cost-history')[0]['receipt']['purchase']['supplierId']==amazon,'invoice cost history follows the corrected supplier')
listed=next(x for x in good('GET','/purchases?roundId='+r['id']) if x['id']==p['id'])
check(set(listed['createdProductIds'])=={x['id'] for x in initial['createdProducts']},'purchase lists identify only products created with that direct purchase')
changed={**command,'reason':'Otro motivo'}
check(call('PATCH',path,changed)[0]==409,'reusing the command ID for another correction is rejected')
stale={**command,'id':uid(),'newSupplier':{'name':'Proveedor que no se debe crear '+tag,'region':'Local'}}
check(call('PATCH',path,stale)[0]==409 and not any(s['name']==stale['newSupplier']['name'] for s in good('GET','/suppliers')),'stale correction cannot create an orphan supplier')
inactive=good('POST','/suppliers',{'name':'Proveedor inactivo '+tag,'region':'Local','active':False})
def correction(p,supplier,**extra):return {'id':uid(),'version':p['version'],'supplierId':supplier,'correctCreatedProducts':True,'reason':'Corrección de prueba',**extra}
check(call('PATCH',path,correction(corrected,inactive['id']))[0]==400,'inactive suppliers cannot be assigned')
check(call('PATCH',path,correction(corrected,amazon))[0]==400,'selecting the same supplier is rejected')
check(call('PATCH',path,{**correction(corrected,wrong['id']),'newSupplier':{'name':'Ambiguo','region':'Local'}})[0]==400,'ambiguous existing-and-new suppliers are rejected')
# Existing products retain their habitual supplier; removing a mistaken current
# invoice restores the latest actual invoice for that supplier.
prior=direct([existing(product['id'],'120')],amazon,now+timedelta(minutes=1))
mistake=direct([existing(product['id'],'160')],amazon,now+timedelta(minutes=2))['purchase']
third=good('POST','/suppliers',{'name':'Tercer proveedor '+tag,'region':'Local'})
check(D(catalog(product['id'])['estimatedCost'])==160,'fixture has the latest mistaken invoice cost')
fixed=good('PATCH','/purchases/'+mistake['id']+'/supplier',correction(mistake,third['id']))
check(catalog(product['id'])['defaultSupplierId']==amazon and D(catalog(product['id'])['estimatedCost'])==120,'correction of an existing product preserves its habitual supplier and restores its previous invoice cost')
check(fixed['receipts']==mistake['receipts'],'cost provenance changes do not alter actual receipt costs')
# A name conflict rolls back every change, including the purchase attribution.
conflict=good('POST','/products',{'name':initial['createdProducts'][1]['name'],'salePrice':'100','estimatedCost':'60','defaultSupplierId':third['id'],'unit':'bote'})
snapshot=copy.deepcopy(listed)
check(call('PATCH',path,correction(corrected,third['id']))[0]==409,'conflicting product names prevent an ambiguous catalog supplier')
check(next(x for x in good('GET','/purchases?roundId='+r['id']) if x['id']==p['id'])['supplierId']==amazon and all(catalog(x['id'])['defaultSupplierId']==amazon for x in initial['createdProducts']),'a late conflict rolls back the purchase and all product changes')
# Closed cycles still permit attribution-only fixes.
leftovers=[l for l in good('GET','/inventory') if l['roundId']==r['id'] and D(l['available'])>0]
good('POST','/rounds/'+r['id']+'/close',{'decisions':[{'receiptItemId':l['id'],'quantity':l['available'],'reason':'KEEP'} for l in leftovers]})
current=next(x for x in good('GET','/purchases?roundId='+r['id']) if x['id']==mistake['id'])
closed=good('PATCH','/purchases/'+mistake['id']+'/supplier',correction(current,wrong['id'],correctCreatedProducts=False))
check(closed['supplierId']==wrong['id'] and closed['receipts']==current['receipts'],'metadata correction works in a closed cycle without reopening or replacing receipts')
check(call('PATCH',path,{**correction(corrected,third['id']),'reason':' '})[0]==400,'a correction must include a meaningful audit reason')
print(json.dumps({'checks':len(checks),'roundId':r['id']},ensure_ascii=False))

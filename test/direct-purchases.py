"""Direct purchases create catalog, invoice and stock together, against a LOCAL API."""
import os,json,uuid,copy,urllib.request,urllib.error
from datetime import datetime,timezone,timedelta
from decimal import Decimal as D
from concurrent.futures import ThreadPoolExecutor
base=os.environ.get('DAIRY_TEST_URL','http://127.0.0.1:4104/api/v1')
assert base.startswith(('http://localhost:','http://127.0.0.1:')),'Local test server only'
token=None;checks=[]
uid=lambda:str(uuid.uuid4())
now=datetime.now(timezone.utc)-timedelta(minutes=3)
iso=lambda d:d.isoformat(timespec='seconds')
def call(method,path,body=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(base+path,method=method,headers=headers,data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req,timeout=40) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
def good(method,path,body=None):
    status,data=call(method,path,body)
    assert status in (200,201),(path,status,data)
    return data
def check(ok,label):
    assert ok,label
    checks.append(label)
token=good('POST','/auth/login',{'email':os.environ['DAIRY_TEST_EMAIL'],'password':os.environ['DAIRY_TEST_PASSWORD']})['accessToken']
tag=uid()[:6]
r=good('POST','/rounds',{'name':'Compra recibida '+tag,'opensAt':iso(now-timedelta(days=1)),'closesAt':iso(now+timedelta(days=7))})
def new_line(name,quantity='1',cost='60',category=None):
    return {'newProduct':{'name':name+' '+tag,'unit':'bote','salePrice':'100','categoryName':category or 'Cuidado directo '+tag,'shelfLifeDays':365,'warnDays':30},'quantity':quantity,'unitCost':cost,'unitDiscount':'0'}
def body(items,supplier=None):
    return {'id':uid(),'roundId':r['id'],'purchasedAt':iso(now),'globalDiscount':'0','items':items,**({'supplierId':supplier} if supplier else {'newSupplier':{'name':'Proveedor directo '+tag,'region':'Tegucigalpa'}})}
def products():return good('GET','/products')
def cash():return D(good('GET','/finance/summary')['position']['cash'])
path='/purchases/direct'
first=body([new_line('Crema facial','3','60'),new_line('Crema manos','2','80')])
first['items'][0]['newProduct']['description']='  Crema hidratante de 250 ml.\nPara piel sensible.  '
first['items'][0]['unitDiscount']='5';first['globalDiscount']='5';first['invoice']='FAC '+tag
before=cash()
with ThreadPoolExecutor(max_workers=2) as pool:
    results=list(pool.map(lambda _:call('POST',path,first),range(2)))
check(all(status==201 for status,_ in results),'concurrent retries both return a successful direct purchase')
check(sorted(data['replayed'] for _,data in results)==[False,True],'direct purchase command is applied once')
result=results[0][1];p=result['purchase'];supplier=p['supplierId']
created=result['createdProducts'];facial=next(p for p in created if p['name'].startswith('Crema facial'));hands=next(p for p in created if p['name'].startswith('Crema manos'))
description='Crema hidratante de 250 ml.\nPara piel sensible.'
check(facial['description']==description and hands['description'] is None,'direct purchase saves product details independently and descriptions remain optional')
check(next(p for p in products() if p['id']==facial['id'])['description']==description,'direct-purchase description remains available in the catalog')
check(p['id']==first['id'] and len(p['receipts'])==1 and len(p['items'])==2,'purchase and complete receipt are created together')
check(D(p['receipts'][0]['total'])==320 and cash()-before==-320,'all discounts reconcile with the invoice and cash exactly once')
check(len([s for s in good('GET','/suppliers') if s['name']=='Proveedor directo '+tag])==1 and p['supplier']['phoneCountryCode']=='+504','supplier is created once with Honduras defaults')
check(facial['categoryId']==hands['categoryId'] and next(c for c in good('GET','/product-categories') if c['id']==facial['categoryId'])['productCount']==2,'one inline category is shared by both new products')
check(D(facial['estimatedCost'])==D('54.15') and D(facial['salePrice'])==100,'new catalog cost is the effective invoice cost while sale price remains explicit')
stock=good('GET','/inventory')
check(sum(D(l['onHand']) for l in stock if l['productId']==facial['id'])==3 and sum(D(l['available']) for l in stock if l['productId']==hands['id'])==2,'received products are immediately available in inventory')
history=good('GET','/products/'+facial['id']+'/cost-history')
check(len(history)==1 and D(history[0]['effectiveUnitCost'])==D('54.153333'),'cost history preserves discounts and receipt precision')
check(all(l['expiresAt'] for l in p['receipts'][0]['items']),'new product shelf life applies to the first received lot')
changed=copy.deepcopy(first);changed['items'][0]['quantity']='4'
check(call('POST',path,changed)[0]==409,'same command cannot be reused for edited purchase content')
check(len([p for p in good('GET','/purchases?roundId='+r['id']) if p['id']==first['id']])==1,'retries never duplicate invoices or purchases')
mixed=body([{'productId':facial['id'],'quantity':'1','unitCost':'62','unitDiscount':'2'},new_line('Crema corporal','1','70')],supplier)
mixed['items'][1]['newProduct'].pop('categoryName');mixed['items'][1]['newProduct']['categoryId']=facial['categoryId']
m=good('POST',path,mixed)
check(D(m['purchase']['receipts'][0]['total'])==130 and len(m['createdProducts'])==1,'existing and new products can share one received purchase')
current=next(p for p in products() if p['id']==facial['id'])
check(D(current['estimatedCost'])==60 and D(current['salePrice'])==100,'repeat purchase updates cost without changing the existing sale price')
check(current['description']==description,'buying an existing product preserves its description')
check(m['purchase']['receipts'][0]['invoice']=='Compra directa','missing invoice number keeps an explicit direct-purchase reference')
alt=body([{'productId':facial['id'],'quantity':'1','unitCost':'99','unitDiscount':'0'}]);alt['newSupplier']['name']='Proveedor alterno directo '+tag
good('POST',path,alt)
check(D(next(p for p in products() if p['id']==facial['id'])['estimatedCost'])==60,'alternative supplier invoice does not overwrite habitual supplier cost')
check(len(good('GET','/products/'+facial['id']+'/cost-history'))==3,'all receipt costs remain visible in history')
c=good('POST','/customers',{'name':'Encargo compra directa '+tag})
o=good('POST','/orders',{'roundId':r['id'],'customerId':c['id'],'items':[{'productId':facial['id'],'supplierId':supplier,'quantity':'6','unitPrice':'100'}]})
fill=good('POST',path,body([{'productId':facial['id'],'quantity':'2','unitCost':'60','unitDiscount':'0'}],supplier))
check(D(good('GET','/orders/'+o['id'])['items'][0]['reservedQuantity'])==6,'received stock fills pending encargos immediately')
new_lot=next(l for l in good('GET','/inventory') if l['id']==fill['purchase']['receipts'][0]['items'][0]['id'])
check(D(new_lot['quantity'])==2 and D(new_lot['available'])==1,'only stock not needed by encargos remains free to sell')
bad=body([new_line('Producto que debe revertir')]);bad['newSupplier']['name']='Proveedor rollback '+tag
bad['items'][0]['newProduct']['categoryName']='Categoria rollback '+tag;bad['globalDiscount']='9999'
check(call('POST',path,bad)[0]==400,'late invoice validation can reject the whole direct purchase')
check(not any(s['name']=='Proveedor rollback '+tag for s in good('GET','/suppliers')),'failed purchase does not leave an orphan supplier')
check(not any(p['name']=='Producto que debe revertir '+tag for p in products()) and not any(c['name']=='Categoria rollback '+tag for c in good('GET','/product-categories')),'failed purchase rolls back its new product and category')
check(not any(p['id']==bad['id'] for p in good('GET','/purchases?roundId='+r['id'])),'failed purchase does not leave a purchase or receipt')
bad['globalDiscount']='0';repaired=good('POST',path,bad)
check(len(repaired['createdProducts'])==1,'a rejected request can be corrected and saved with the same command ID')
fraction=body([new_line('Fracción inválida','0.5')],supplier)
check(call('POST',path,fraction)[0]==400 and not any(p['name']=='Fracción inválida '+tag for p in products()),'non-pound fractions roll back new product creation')
duplicate=body([new_line('Crema facial')],supplier)
check(call('POST',path,duplicate)[0]==409,'same-name product for the same supplier is selected from the catalog instead of duplicated')
other=body([new_line('Crema facial')]);other['newSupplier']['name']='Otro proveedor crema '+tag
check(len(good('POST',path,other)['createdProducts'])==1,'same product name is allowed for another supplier')
future=body([new_line('Futuro')],supplier);future['purchasedAt']=iso(now+timedelta(days=1))
check(call('POST',path,future)[0]==400,'future purchase dates are rejected')
both=body([new_line('Proveedor ambiguo')]);both['supplierId']=supplier
check(call('POST',path,both)[0]==400,'existing and new supplier cannot be chosen simultaneously')
both_line=body([new_line('Producto ambiguo')],supplier);both_line['items'][0]['productId']=facial['id']
check(call('POST',path,both_line)[0]==400,'existing and new product cannot be chosen simultaneously')
stats=next(c for c in good('GET','/statistics')['cycles'] if c['id']==r['id'])
check(any(p['productId']==facial['id'] for p in stats['productPrices']),'direct receipts participate in cycle price history')
catalog_body={'name':'Producto con detalles '+tag,'description':'  Presentación de 100 ml.\nUso externo.  ','unit':'bote','salePrice':'100','estimatedCost':'60','defaultSupplierId':supplier}
catalog=good('POST','/products',catalog_body)
check(catalog['description']=='Presentación de 100 ml.\nUso externo.','catalog creation saves a trimmed multiline description')
catalog_path='/products/'+catalog['id']
check(good('PATCH',catalog_path,{'salePrice':'105'})['description']==catalog['description'],'editing other fields preserves an omitted description')
edited=good('PATCH',catalog_path,{'description':'  Nueva presentación de 150 ml.  '})
check(edited['description']=='Nueva presentación de 150 ml.','catalog description can be edited independently')
check(good('PATCH',catalog_path,{'description':'   '})['description'] is None,'an empty description clears saved details')
good('PATCH',catalog_path,{'description':'Detalle temporal'})
check(good('PATCH',catalog_path,{'description':None})['description'] is None,'an explicit null clears the description')
for value in [123,'x'*2001]:
    check(call('PATCH',catalog_path,{'description':value})[0]==400,'invalid catalog descriptions are rejected')
    invalid=body([new_line('Descripción inválida')],supplier);invalid['items'][0]['newProduct']['description']=value
    check(call('POST',path,invalid)[0]==400,'invalid direct-purchase descriptions are rejected before receipt creation')
print(json.dumps({'checks':len(checks),'roundId':r['id'],'round':r['name'],'supplier':p['supplier']['name']},ensure_ascii=False))

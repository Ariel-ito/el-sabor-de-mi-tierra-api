"""Correct packaging labels on untouched purchases, without converting amounts. LOCAL only."""
import os,json,uuid,urllib.request,urllib.error
from datetime import datetime,timezone,timedelta
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal as D
base=os.environ.get('DAIRY_TEST_URL','http://127.0.0.1:4104/api/v1')
assert base.startswith(('http://localhost:','http://127.0.0.1:')),'Local server only'
token=None;checks=[];uid=lambda:str(uuid.uuid4())
now=datetime.now(timezone.utc)-timedelta(minutes=5);iso=lambda d:d.isoformat(timespec='seconds')
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
tag=uid()[:6];s=good('POST','/suppliers',{'name':'Proveedor unidades '+tag,'region':'Local'})
r=good('POST','/rounds',{'name':'Unidades '+tag,'opensAt':iso(now-timedelta(days=1)),'closesAt':iso(now+timedelta(days=7))})
def new_line(name,unit='bote',quantity='3'):
    return {'newProduct':{'name':name+' '+tag,'unit':unit,'salePrice':'100'},'quantity':quantity,'unitCost':'60','unitDiscount':'0'}
result=good('POST','/purchases/direct',{'id':uid(),'roundId':r['id'],'supplierId':s['id'],'purchasedAt':iso(now),'invoice':'UNIDAD '+tag,'globalDiscount':'0','items':[new_line(n) for n in ['Corregible','Muestra','Venta','Receta']]+[new_line('Peso','lb','0.5'),new_line('Docena','docena','1')]})
p=result['purchase'];products=result['createdProducts']
def product(prefix):return next(x for x in products if x['name']==prefix+' '+tag)
def change(product,unit):return call('PATCH','/products/'+product['id'],{'unit':unit})
def purchase():return next(x for x in good('GET','/purchases?roundId='+r['id']) if x['id']==p['id'])
def lot(product):return next(x for x in good('GET','/inventory') if x['productId']==product['id'])
a=product('Corregible');before=lot(a)
code,updated=change(a,'frasco')
check(code==200 and updated['unit']=='frasco','a received but unsold product can be corrected from tub to jar')
check(D(updated['salePrice'])==D(a['salePrice']) and D(updated['estimatedCost'])==D(a['estimatedCost']),'correcting the label preserves sale price and catalog cost')
check(purchase()['receipts']==p['receipts'],'invoice amounts, receipt IDs, dates and quantities are unchanged')
after=lot(a)
check(all(after[k]==v for k,v in before.items() if k!='unit') and after['unit']=='frasco','stock quantities, lots and costs are unchanged; only the unit label follows the catalog')
check(change(a,'bote')[0]==200 and change(a,'frasco')[0]==200,'an untouched packaging correction is reversible')
check(change(product('Peso'),'frasco')[0]==400,'received pounds cannot be relabeled as pieces without conversion')
check(change(product('Docena'),'bote')[0]==400 and change(a,'docena')[0]==400,'dozens are never silently converted to or from individual packages')
customer=good('POST','/customers',{'name':'Cliente unidades '+tag})
order=good('POST','/orders',{'roundId':r['id'],'customerId':customer['id'],'items':[{'productId':a['id'],'supplierId':s['id'],'quantity':'1','unitPrice':'100'}]})
code,error=change(a,'bote')
check(code==400 and 'ventas o encargos' in error['message'],'an encargo blocks changing its unit even before delivery')
check(good('PATCH','/products/'+a['id'],{'unit':'frasco','description':'Detalle actualizado'})['description']=='Detalle actualizado','other catalog edits still work when the unit is unchanged')
b=product('Muestra');good('POST','/inventory/withdrawals',{'id':uid(),'receiptItemId':lot(b)['id'],'quantity':'1','reason':'SAMPLE'})
code,error=change(b,'frasco')
check(code==400 and 'salidas de inventario' in error['message'],'sample or personal-use withdrawals protect their recorded unit')
c=product('Venta');good('POST','/sales',{'id':uid(),'roundId':r['id'],'soldAt':iso(now+timedelta(minutes=1)),'items':[{'productId':c['id'],'quantity':'1','unitPrice':'100'}]})
check(change(c,'frasco')[0]==400,'walk-in sales also protect the original unit')
d=product('Receta')
combo=good('POST','/products',{'name':'Combo unidades '+tag,'unit':'paquete','salePrice':'150','estimatedCost':'0','defaultSupplierId':s['id']})
good('PATCH','/products/'+combo['id']+'/components',{'components':[{'componentId':d['id'],'quantity':'1'}]})
code,error=change(d,'frasco')
check(code==400 and 'combo' in error['message'],'recipe components cannot be silently reinterpreted')
check(change(combo,'bolsa')[0]==400,'the combo unit is protected while it has a recipe')
fresh=good('POST','/products',{'name':'Sin historial '+tag,'unit':'lb','salePrice':'100','estimatedCost':'60','defaultSupplierId':s['id']})
check(change(fresh,'frasco')[0]==200,'a product with no history can still change freely')
race=good('POST','/products',{'name':'Concurrente '+tag,'unit':'lb','salePrice':'100','estimatedCost':'60','defaultSupplierId':s['id']})
buy={'id':uid(),'roundId':r['id'],'supplierId':s['id'],'orderedAt':iso(now),'items':[{'productId':race['id'],'quantity':'0.5','quotedUnitCost':'60'}]}
with ThreadPoolExecutor(max_workers=2) as pool:
    edit=pool.submit(change,race,'frasco');purchase_result=pool.submit(call,'POST','/purchases',buy)
    edit_status,_=edit.result();purchase_status,_=purchase_result.result()
check((edit_status==200 and purchase_status==400) or (edit_status==400 and purchase_status==201),'a concurrent purchase and unit correction cannot create a fractional jar purchase')
print(json.dumps({'checks':len(checks),'roundId':r['id']},ensure_ascii=False))

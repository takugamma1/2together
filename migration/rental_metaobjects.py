#!/usr/bin/env python3
"""Create the rental metaobject definitions (rental_bike, rental_booking) + sample bikes.
Needs read_metaobjects/write_metaobjects on the app token in .env. Re-runnable."""
import os, json, urllib.request
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env=dict(l.strip().split('=',1) for l in open(os.path.join(ROOT,'.env')) if '=' in l and not l.startswith('#'))
def gql(q,v=None):
    rq=urllib.request.Request(f"https://{env['SHOPIFY_STORE']}/admin/api/2025-07/graphql.json",data=json.dumps({'query':q,'variables':v or {}}).encode(),headers={'Content-Type':'application/json','X-Shopify-Access-Token':env['SHOPIFY_ADMIN_TOKEN']})
    r=json.load(urllib.request.urlopen(rq))
    if r.get('errors'): raise SystemExit(r['errors'])
    return r['data']
DEFS=[{
  "name":"Rental bike","type":"rental_bike","access":{"storefront":"PUBLIC_READ"},
  "displayNameField":"name",
  "capabilities":{"publishable":{"enabled":True}},
  "fieldDefinitions":[
    {"key":"name","name":"Име","type":"single_line_text_field","required":True},
    {"key":"photo","name":"Снимка","type":"file_reference","validations":[{"name":"file_type_options","value":json.dumps(["Image"])}]},
    {"key":"gallery","name":"Още снимки","type":"list.file_reference"},
    {"key":"description","name":"Описание","type":"multi_line_text_field"},
    {"key":"category","name":"Категория (MTB / Град / E-bike / Детско)","type":"single_line_text_field"},
    {"key":"sizes","name":"Размери (напр. S, M, L)","type":"single_line_text_field"},
    {"key":"count","name":"Брой налични колела","type":"number_integer","required":True},
    {"key":"active","name":"Активно за наем","type":"boolean","required":True},
    {"key":"hourly_rate","name":"Цена на час € (празно = по подразбиране)","type":"number_decimal"},
    {"key":"day_rate","name":"Цена за ден € (празно = по подразбиране)","type":"number_decimal"},
    {"key":"long_term_tiers","name":"Дългосрочни цени (ден|€ на ред; празно = по подразбиране)","type":"multi_line_text_field"},
    {"key":"sort","name":"Подредба","type":"number_integer"}
  ]},{
  "name":"Rental booking","type":"rental_booking","access":{"storefront":"NONE"},
  "displayNameField":"reference",
  "fieldDefinitions":[
    {"key":"reference","name":"Референция","type":"single_line_text_field","required":True},
    {"key":"bike","name":"Колело","type":"metaobject_reference","validations":[{"name":"metaobject_definition_id","value":"__RENTAL_BIKE_ID__"}]},
    {"key":"bike_handle","name":"Колело (handle)","type":"single_line_text_field"},
    {"key":"quantity","name":"Брой","type":"number_integer","required":True},
    {"key":"mode","name":"Вид (short / long)","type":"single_line_text_field","required":True},
    {"key":"start","name":"Начало","type":"date_time","required":True},
    {"key":"end","name":"Край","type":"date_time","required":True},
    {"key":"status","name":"Статус (pending / confirmed / cancelled)","type":"single_line_text_field","required":True},
    {"key":"customer_name","name":"Клиент","type":"single_line_text_field"},
    {"key":"phone","name":"Телефон","type":"single_line_text_field"},
    {"key":"email","name":"Имейл","type":"single_line_text_field"},
    {"key":"note","name":"Бележка","type":"multi_line_text_field"},
    {"key":"price","name":"Цена €","type":"number_decimal"},
    {"key":"calendar_event","name":"Google Calendar event id","type":"single_line_text_field"}
  ]}]
existing={d['type']:d['id'] for d in gql('{ metaobjectDefinitions(first:50){ nodes{ id type } } }')['metaobjectDefinitions']['nodes']}
for d in DEFS:
    if d['type'] in existing: print('exists',d['type']); continue
    body=json.loads(json.dumps(d).replace('__RENTAL_BIKE_ID__',existing.get('rental_bike','')))
    r=gql('mutation($d:MetaobjectDefinitionCreateInput!){ metaobjectDefinitionCreate(definition:$d){ metaobjectDefinition{ id type } userErrors{ field message } } }',{'d':body})['metaobjectDefinitionCreate']
    if r['userErrors']: raise SystemExit(r['userErrors'])
    existing[d['type']]=r['metaobjectDefinition']['id']; print('created',d['type'])
# sample bikes (edit in admin → Content → Metaobjects → Rental bike)
samples=[("mtb-trail","MTB Trail","MTB","S, M, L",4),("city-cruiser","Градско колело","Град","M, L",6),("e-bike","E-bike","E-bike","M, L",2),("kids-20","Детско 20\"","Детско","20\"",3)]
for i,(h,n,c,sz,cnt) in enumerate(samples):
    r=gql('mutation($h:MetaobjectHandleInput!,$m:MetaobjectUpsertInput!){ metaobjectUpsert(handle:$h, metaobject:$m){ metaobject{ id } userErrors{ message } } }',{'h':{'type':'rental_bike','handle':h},'m':{'fields':[{'key':'name','value':n},{'key':'category','value':c},{'key':'sizes','value':sz},{'key':'count','value':str(cnt)},{'key':'active','value':'true'},{'key':'sort','value':str(i)}],'capabilities':{'publishable':{'status':'ACTIVE'}}}})['metaobjectUpsert']
    print('bike',h,r['userErrors'] or 'ok')

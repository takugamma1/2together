#!/usr/bin/env python3
"""Create/ensure metaobject definitions for service booking (mechanic, service_type, service_booking) + seed data."""
import os, json, urllib.request, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = dict(l.strip().split('=', 1) for l in open(os.path.join(ROOT, '.env')) if '=' in l and not l.startswith('#'))
API = f"https://{env['SHOPIFY_STORE']}/admin/api/2025-07/graphql.json"
def gql(q, v=None):
    rq = urllib.request.Request(API, data=json.dumps({'query': q, 'variables': v or {}}).encode(), headers={'Content-Type': 'application/json', 'X-Shopify-Access-Token': env['SHOPIFY_ADMIN_TOKEN']})
    r = json.load(urllib.request.urlopen(rq))
    if r.get('errors'): print(r['errors']); sys.exit(1)
    return r['data']
def ensure(defn):
    ex = gql('query($t:String!){ metaobjectDefinitionByType(type:$t){ id } }', {'t': defn['type']})['metaobjectDefinitionByType']
    if ex: print('exists', defn['type']); return
    r = gql('mutation($d:MetaobjectDefinitionCreateInput!){ metaobjectDefinitionCreate(definition:$d){ metaobjectDefinition{ type } userErrors{ field message } } }', {'d': defn})['metaobjectDefinitionCreate']
    print('created' if not r['userErrors'] else r['userErrors'], defn['type'])
T = lambda key, name, typ, **kw: dict(key=key, name=name, type=typ, **kw)
ensure({'name': 'Mechanic', 'type': 'mechanic', 'access': {'storefront': 'PUBLIC_READ'}, 'capabilities': {'publishable': {'enabled': True}}, 'fieldDefinitions': [
    T('name', 'Име', 'single_line_text_field', required=True), T('photo', 'Снимка', 'file_reference', validations=[{'name': 'file_type_options', 'value': '["Image"]'}]),
    T('specialties', 'Специалности (напр. окачване, спирачки)', 'single_line_text_field'), T('bio', 'Кратко описание', 'multi_line_text_field'),
    T('active', 'Приема записвания', 'boolean', required=True),
    T('shifts', 'Работно време по дни (ред: mon=09:00-13:00,14:00-18:00)', 'multi_line_text_field'),
    T('days_off', 'Почивни дати (YYYY-MM-DD, по един на ред)', 'multi_line_text_field'),
    T('slot_minutes', 'Стъпка на часовете (мин)', 'number_integer'), T('sort', 'Подредба', 'number_integer')]})
ensure({'name': 'Service type', 'type': 'service_type', 'access': {'storefront': 'PUBLIC_READ'}, 'capabilities': {'publishable': {'enabled': True}}, 'fieldDefinitions': [
    T('name', 'Услуга', 'single_line_text_field', required=True), T('description', 'Описание', 'multi_line_text_field'),
    T('duration_minutes', 'Продължителност (мин)', 'number_integer', required=True), T('price_from', 'Цена от €', 'number_decimal'),
    T('active', 'Активна', 'boolean', required=True), T('sort', 'Подредба', 'number_integer')]})
ensure({'name': 'Service booking', 'type': 'service_booking', 'access': {'storefront': 'NONE'}, 'fieldDefinitions': [
    T('reference', 'Номер', 'single_line_text_field', required=True), T('mechanic', 'Механик', 'metaobject_reference', validations=[{'name': 'metaobject_definition_type', 'value': 'mechanic'}]), T('mechanic_handle', 'Механик (handle)', 'single_line_text_field'),
    T('service', 'Услуга', 'metaobject_reference', validations=[{'name': 'metaobject_definition_type', 'value': 'service_type'}]), T('service_handle', 'Услуга (handle)', 'single_line_text_field'),
    T('start', 'Начало', 'date_time', required=True), T('end', 'Край', 'date_time', required=True),
    T('status', 'Статус (pending / confirmed / done / cancelled)', 'single_line_text_field', required=True),
    T('customer_name', 'Клиент', 'single_line_text_field', required=True), T('phone', 'Телефон', 'single_line_text_field'), T('email', 'Имейл', 'single_line_text_field'),
    T('bike', 'Колело', 'single_line_text_field'), T('note', 'Бележка', 'multi_line_text_field'), T('price', 'Цена', 'single_line_text_field'),
    T('calendar_event', 'Google Calendar event id', 'single_line_text_field'), T('customer_id', 'Shopify customer id', 'single_line_text_field')]})
def upsert(t, h, fields):
    r = gql('mutation($h:MetaobjectHandleInput!,$m:MetaobjectUpsertInput!){ metaobjectUpsert(handle:$h, metaobject:$m){ metaobject{ handle } userErrors{ field message } } }', {'h': {'type': t, 'handle': h}, 'm': {'fields': [{'key': k, 'value': v} for k, v in fields.items()], 'capabilities': {'publishable': {'status': 'ACTIVE'}}}})['metaobjectUpsert']
    print(' ', h, r['userErrors'] or 'ok')
if '--seed' in sys.argv:
    print('seed services'); 
    for i, (h, n, d, dur, pr) in enumerate([('diagnostika', 'Диагностика', 'Преглед и оценка какво е нужно — точна цена след прегледа.', 30, '10'), ('osnoven-servis', 'Основен сервиз', 'Настройка на скорости и спирачки, смазване, проверка на всички болтове.', 60, '35'), ('palen-servis', 'Пълен сервиз', 'Разглобяване, почистване, смяна на консумативи, пълна настройка.', 120, '70'), ('spirachki', 'Спирачки', 'Обезвъздушаване, накладки, ротори.', 45, '25'), ('skorosti', 'Скорости', 'Настройка, жила, дерайльор, верига.', 45, '25'), ('gumi-tubeless', 'Гуми и tubeless', 'Смяна на гума/вътрешна гума, tubeless конвертиране, течност.', 30, '15'), ('kolela', 'Центроване на колела', 'Спици, центроване, лагери на главини.', 45, '20'), ('okachvane', 'Окачване', 'Сервиз на вилка/амортисьор, уплътнения, масло.', 90, '60')], 1):
        upsert('service_type', h, {'name': n, 'description': d, 'duration_minutes': str(dur), 'price_from': pr, 'active': 'true', 'sort': str(i)})
    print('seed mechanics')
    upsert('mechanic', 'kalin', {'name': 'Калин', 'specialties': 'Окачване, спирачки, пълен сервиз', 'bio': 'Основател на 2gether. Кара и поправя от 2017.', 'active': 'true', 'shifts': 'mon=09:00-13:00,14:00-18:00\ntue=09:00-13:00,14:00-18:00\nwed=09:00-13:00,14:00-18:00\nthu=09:00-13:00,14:00-18:00\nfri=09:00-13:00,14:00-18:00\nsat=10:00-14:00', 'days_off': '', 'slot_minutes': '30', 'sort': '1'})
    upsert('mechanic', 'mehanik-2', {'name': 'Механик 2', 'specialties': 'Скорости, гуми, колела', 'bio': 'Сменете името и снимката, включете „Приема записвания“.', 'active': 'false', 'shifts': 'mon=10:00-18:00\ntue=10:00-18:00\nwed=10:00-18:00\nthu=10:00-18:00\nfri=10:00-18:00', 'days_off': '', 'slot_minutes': '30', 'sort': '2'})
print('done')

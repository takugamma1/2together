# Наем на велосипеди — система за резервации (настройка)

**Архитектура:** колелата и резервациите са *метаобекти* в Shopify (Content → Metaobjects), не продукти. Наличността и записването минават през Cloudflare worker-а на клуба (`/apps/club/*`), който огледално записва всяка резервация в Google Calendar. Няма отделно приложение за инсталиране.

## 1. Метаобекти (еднократно)
`python3 migration/rental_metaobjects.py` — създава дефинициите **Rental bike** и **Rental booking** и 4 примерни колела. Изисква `read_metaobjects` + `write_metaobjects` на custom app-а в `.env`.

## 2. Колела за наем (Калин, всеки ден)
Shopify admin → **Content → Metaobjects → Rental bike → Add entry**: име, снимка, категория, размери, **Брой налични**, **Активно** (изкл. = скрива колелото), по желание собствени цени (час / ден / дългосрочни). Save = веднага на сайта.

## 3. Цени (в Customize → страница Наем → секция „Rental booking“)
- Краткосрочно: € на час, € за ден (таван), € за 24 ч, първи/последен час.
- Дългосрочно: редове `ден|€` — всеки ден се таксува по тарифата на своя ред (напр. `1|20 … 7|13`).
Цените от секцията важат за всички колела; метаобектът на колелото може да ги override-не.

## 4. Worker (Cloudflare) — еднократно
```
cd worker
npx wrangler login
npx wrangler deploy
```
Google Calendar (по желание, препоръчително):
1. Google Cloud → проект → **APIs & Services → Enable „Google Calendar API“**.
2. **IAM → Service Accounts → Create** → Keys → Add key (JSON). Запази `client_email` и `private_key`.
3. Google Calendar → календар „Наем 2gether“ → Settings → **Share with specific people → client_email → Make changes to events**. Копирай **Calendar ID**.
4. `npx wrangler secret put GOOGLE_SA_EMAIL`, `… GOOGLE_SA_KEY` (целия private_key, с `\n`), `… GOOGLE_CALENDAR_ID`.

Всяка резервация се появява като събитие. Блокиране на дати от календара: събитие със заглавие `BLOCK mtb-trail` (handle на колелото) или `BLOCK all`.

## 5. Резервации
Content → Metaobjects → **Rental booking** — статус `pending` → `confirmed` / `cancelled` (отказаните освобождават датите). Имейл известие: Shopify Flow → trigger „Metaobject entry created“ → Send internal email.

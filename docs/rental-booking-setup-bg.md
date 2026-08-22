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

## Ако Google не позволява ключ за service account („Service account key creation is disabled“)

Това е Workspace политика (`iam.disableServiceAccountKeyCreation`). Три варианта:

**А. Разреши ключове само за този проект** (ако си администратор): IAM & Admin → Organization Policies → „Disable service account key creation“ → Manage policy → Override parent's policy → *Not enforced* → Set policy (с избран проект). После създай JSON ключа.

**Б. Направи проекта с личен Gmail** (без организация — ключовете са разрешени). Календарът остава този на магазина: просто го споделяш с имейла на service account-а.

**В. OAuth refresh token вместо ключ** (без политики):
1. APIs & Services → OAuth consent screen → User type **Internal** (за Workspace; тогава токенът не изтича) → запази.
2. Credentials → Create credentials → **OAuth client ID** → Application type **Desktop app** → копирай Client ID и Client secret.
3. На компютъра: `node worker/google-oauth-token.mjs <CLIENT_ID> <CLIENT_SECRET>` → отвори линка, влез с Google акаунта на магазина, потвърди → скриптът отпечатва `GOOGLE_OAUTH_REFRESH_TOKEN`.
4. ```
   cd worker
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
   npx wrangler secret put GOOGLE_CALENDAR_ID
   npx wrangler deploy
   ```
   При наличие на OAuth тайните worker-ът ги ползва с предимство пред service account-а.

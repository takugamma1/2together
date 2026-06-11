# Club backend (Cloudflare Worker)

Backend for the Sunday Club RSVP + destination poll features on the 2gether storefront.
Served through a **Shopify App Proxy** at `https://<shop-domain>/apps/club/*`.

Endpoints (all JSON):

| Method | Path                      | Auth                | Response |
|--------|---------------------------|---------------------|----------|
| GET    | `/apps/club/status?ride=` | works logged out    | `{count, capacity, mine}` |
| POST   | `/apps/club/rsvp`         | logged-in customer  | `{count, capacity, mine}` / `409 {error:"full"}` |
| GET    | `/apps/club/poll?poll=`   | works logged out    | `{counts: {optionGid: n}, mine}` |
| POST   | `/apps/club/vote`         | customer + tag `member` | `{counts, mine}` / `403` |

Every request is verified against the Shopify app proxy HMAC signature; unsigned/forged
requests get `401`. `logged_in_customer_id` is injected by Shopify and is only trusted
because the signature is valid.

Status codes the storefront JS maps to Bulgarian messages: `401` not logged in,
`403` not a member, `409` ride full, `404`/`405`/`400`/`500` generic error.

---

## 1. Partner app + App Proxy (provides the signature secret)

1. [Partner Dashboard](https://partners.shopify.com) → **Apps → Create app → Create app manually**. Name e.g. `2gether Club Proxy`. Distribution: **Custom distribution** (single store).
2. Deploy the worker first (step 3) so you have its URL, e.g. `https://club-backend.<account>.workers.dev`.
3. App → **Configuration → App proxy**:
   - Subpath prefix: `apps`
   - Subpath: `club`
   - Proxy URL: `https://club-backend.<account>.workers.dev`
4. Generate the custom-distribution install link and **install the app on the store** (the proxy only works once installed).
5. App → **Settings / API credentials** → copy the **Client secret**. This becomes `SHOPIFY_API_SECRET`.

The app needs **no API scopes** of its own — it exists only for the proxy + signature.

## 2. Admin custom app (provides the Admin API token)

In the **store admin** (not the Partner Dashboard):

1. **Settings → Apps and sales channels → Develop apps → Create an app** → name `Club backend`.
2. **Configure Admin API scopes**: `read_customers`, `read_metaobjects`, `write_metaobjects`.
3. **Install app** → reveal the **Admin API access token** (`shpat_...`). It is shown **once** — copy it now. This becomes `SHOPIFY_ADMIN_TOKEN`.

## 3. Deploy + secrets

```sh
cd worker
npx wrangler deploy                          # first deploy — note the workers.dev URL
npx wrangler secret put SHOPIFY_API_SECRET   # client secret from step 1
npx wrangler secret put SHOPIFY_ADMIN_TOKEN  # shpat_ token from step 2
npx wrangler secret put SHOP                 # e.g. 2together-bikes.myshopify.com (no https://)
```

`SHOP` must be the permanent `*.myshopify.com` domain, exactly as it appears in the
`shop` query param Shopify sends — not the custom domain.

Secrets persist across deploys; re-run `npx wrangler deploy` after code changes only.

## 4. After a store transfer / ownership change

Both credentials can silently break when the store is transferred. Checklist:

- [ ] Partner app still installed? Open `https://<shop>/apps/club/status?ride=1` — a `401`/`404` HTML page from Shopify means the proxy/app is gone; reinstall via a new custom-distribution link.
- [ ] Client secret unchanged? If the app was recreated, update `SHOPIFY_API_SECRET`.
- [ ] Admin custom app token still valid? Test (expect JSON, not a 401):

  ```sh
  curl -s -H "X-Shopify-Access-Token: $TOKEN" \
    "https://<shop>.myshopify.com/admin/api/2025-10/graphql.json" \
    -H "Content-Type: application/json" -d '{"query":"{ shop { name } }"}'
  ```

  If invalid: store admin → Develop apps → Club backend → API credentials →
  **regenerate/uninstall+reinstall** to get a new `shpat_` token, then
  `npx wrangler secret put SHOPIFY_ADMIN_TOKEN`.
- [ ] `SHOP` secret still matches the myshopify domain (it never changes on transfer, but verify).

## 5. Testing with curl

Always test **through the storefront domain** — Shopify adds the HMAC signature when
proxying. Hitting the workers.dev URL directly returns `401 {"error":"missing_signature"}`;
that is correct behavior, not a bug.

```sh
# Ride status (works logged out; mine will be null)
curl -i "https://<shop-domain>/apps/club/status?ride=123"

# Poll counts
curl -i "https://<shop-domain>/apps/club/poll?poll=456"

# RSVP — without a logged-in customer session this correctly returns 401
curl -i -X POST "https://<shop-domain>/apps/club/rsvp" \
  -H "Content-Type: application/json" \
  -d '{"ride":"123","status":"going"}'
```

IDs may be bare numbers (`123`) or full GIDs (`gid://shopify/Metaobject/123`); both work.

### Dev-store storefront password caveat

Password-protected development stores redirect `/apps/club/*` to `/password`, so curl
gets a `302` instead of JSON. Grab the `storefront_digest` cookie first:

```sh
curl -s -c cookies.txt -d "password=<storefront password>" "https://<shop-domain>/password"
curl -i -b cookies.txt "https://<shop-domain>/apps/club/status?ride=123"
```

To test the logged-in POST endpoints end-to-end, log in as a customer in a browser and
use the site UI (or copy the browser's cookies) — `logged_in_customer_id` is only set by
Shopify for an authenticated customer session. For `/vote` the customer additionally
needs the `member` tag (admin → Customers → add tag `member`).

### Tail logs

```sh
npx wrangler tail club-backend
```

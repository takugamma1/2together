/**
 * Econt Express integration.
 *
 * Storefront endpoints (behind the Shopify app proxy, signature-verified):
 *   GET  /econt-cities?q=<text>          -> { cities: [{id, name, nameEn, postCode, region}] }
 *   GET  /econt-offices?city=<cityId>    -> { offices: [{code, name, address, isAPS, lat, lng}] }
 *   POST /econt-quote                    -> { price, currency, service, weight, free }
 *        { mode: 'office'|'address', officeCode, city: {id, name, postCode},
 *          street, num, other, weightGrams, subtotal, name, phone }
 *
 * Shopify CarrierService callback (server-to-server, HMAC-verified):
 *   POST /carrier-rates                  -> { rates: [...] }
 *
 * Secrets (wrangler secret put):
 *   ECONT_USER / ECONT_PASS      — ee.econt.com API profile (demo: iasp-dev / 1Asp-dev)
 *   SHOPIFY_CARRIER_SECRET       — client secret of the app that registered the
 *                                  CarrierService (falls back to SHOPIFY_API_SECRET)
 *
 * Vars (wrangler.toml [vars]):
 *   ECONT_API_BASE               — https://ee.econt.com/services (prod) or
 *                                  https://demo.econt.com/ee/services (sandbox)
 *   ECONT_SENDER_NAME/PHONE      — who ships (shown on the label)
 *   ECONT_SENDER_OFFICE          — office code the shop hands parcels to (preferred), or
 *   ECONT_SENDER_CITY/POSTCODE/STREET/NUM — courier pick-up address
 *   ECONT_DEFAULT_WEIGHT_KG      — used when the cart has no product weights
 *   SHIP_FREE_OVER               — order subtotal (EUR) from which delivery is free (0 = never)
 *   ECONT_FALLBACK_OFFICE/ADDRESS — flat prices (EUR) used at checkout when Econt is unreachable
 */

const BGN_PER_EUR = 1.95583;
const CITIES_TTL_S = 24 * 3600;
const OFFICES_TTL_S = 12 * 3600;
const OFFICE_MARKER = /\[(?:код|kod|code)\s*([0-9A-Za-z]+)\]/i;

let citiesMemo = null; // { at, list } — per-isolate memo on top of the edge cache

export function econtConfig(env) {
  return {
    base: String(env.ECONT_API_BASE || 'https://ee.econt.com/services').replace(/\/+$/, ''),
    user: env.ECONT_USER || '',
    pass: env.ECONT_PASS || '',
    sender: {
      name: env.ECONT_SENDER_NAME || '2GETHER Bikes',
      phone: env.ECONT_SENDER_PHONE || '',
      officeCode: env.ECONT_SENDER_OFFICE || '',
      city: env.ECONT_SENDER_CITY || 'Варна',
      postCode: env.ECONT_SENDER_POSTCODE || '9000',
      street: env.ECONT_SENDER_STREET || '',
      num: env.ECONT_SENDER_NUM || '',
    },
    defaultWeightKg: num(env.ECONT_DEFAULT_WEIGHT_KG, 1),
    freeOver: num(env.SHIP_FREE_OVER, 0),
    fallback: {
      office: num(env.ECONT_FALLBACK_OFFICE, 0),
      address: num(env.ECONT_FALLBACK_ADDRESS, 0),
    },
  };
}

function num(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

/* ------------------------------------------------------------------ */
/* Low-level Econt call                                                 */
/* ------------------------------------------------------------------ */

async function econtCall(cfg, service, body, timeoutMs = 12000) {
  if (!cfg.user || !cfg.pass) throw new Error('econt_not_configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${cfg.base}/${service}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa(`${cfg.user}:${cfg.pass}`),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    // Econt reports validation problems as { type: 'Ex...', message } (often with HTTP 200).
    if (!r.ok || (data && typeof data.type === 'string' && /^Ex/.test(data.type))) {
      const err = new Error(data && data.message ? data.message : `econt_http_${r.status}`);
      err.econt = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Nomenclatures                                                        */
/* ------------------------------------------------------------------ */

async function loadCities(cfg, ctx) {
  if (citiesMemo && Date.now() - citiesMemo.at < CITIES_TTL_S * 1000) return citiesMemo.list;

  const cache = caches.default;
  const key = new Request('https://econt.cache.local/cities/BGR');
  const hit = await cache.match(key);
  if (hit) {
    const list = await hit.json();
    citiesMemo = { at: Date.now(), list };
    return list;
  }

  const data = await econtCall(cfg, 'Nomenclatures/NomenclaturesService.getCities.json', { countryCode: 'BGR' }, 30000);
  const list = (data.cities || [])
    .map((c) => ({
      id: c.id,
      name: c.name || '',
      nameEn: c.nameEn || '',
      postCode: c.postCode || '',
      region: c.regionName || '',
    }))
    .filter((c) => c.id && c.name);

  const resp = new Response(JSON.stringify(list), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CITIES_TTL_S}` },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, resp));
  citiesMemo = { at: Date.now(), list };
  return list;
}

function fold(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
}

export async function handleEcontCities(url, env, ctx) {
  const cfg = econtConfig(env);
  const q = fold(url.searchParams.get('q'));
  let list;
  try {
    list = await loadCities(cfg, ctx);
  } catch (err) {
    return jsonNoStore({ error: 'econt_unavailable', detail: String(err.message || err) }, 502);
  }
  if (q.length < 2) return jsonPublic({ cities: [] }, 300);

  const scored = [];
  for (const c of list) {
    const n = fold(c.name);
    const en = fold(c.nameEn);
    let score = -1;
    if (n === q || en === q) score = 0;
    else if (n.startsWith(q) || en.startsWith(q)) score = 1;
    else if (c.postCode.startsWith(q)) score = 2;
    else if (n.includes(' ' + q) || n.includes('-' + q) || n.includes('.' + q)) score = 3;
    if (score >= 0) scored.push([score, c.name.length, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].name.localeCompare(b[2].name, 'bg'));
  return jsonPublic({ cities: scored.slice(0, 12).map((s) => s[2]) }, 3600);
}

export async function handleEcontOffices(url, env, ctx) {
  const cfg = econtConfig(env);
  const cityId = parseInt(url.searchParams.get('city') || '', 10);
  if (!cityId) return jsonNoStore({ error: 'invalid' }, 400);

  const cache = caches.default;
  const key = new Request(`https://econt.cache.local/offices/BGR/${cityId}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  let data;
  try {
    data = await econtCall(cfg, 'Nomenclatures/NomenclaturesService.getOffices.json', { countryCode: 'BGR', cityID: cityId });
  } catch (err) {
    return jsonNoStore({ error: 'econt_unavailable', detail: String(err.message || err) }, 502);
  }
  const offices = (data.offices || [])
    .filter((o) => o.code && !o.isMPS)
    .map((o) => ({
      code: String(o.code),
      name: o.name || '',
      address: String((o.address && o.address.fullAddress) || '').trim(),
      isAPS: !!o.isAPS,
      lat: o.address && o.address.location ? o.address.location.latitude : null,
      lng: o.address && o.address.location ? o.address.location.longitude : null,
    }))
    .sort((a, b) => Number(a.isAPS) - Number(b.isAPS) || a.name.localeCompare(b.name, 'bg'));

  const resp = jsonPublic({ offices }, OFFICES_TTL_S);
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, resp.clone()));
  return resp;
}

/* ------------------------------------------------------------------ */
/* Price calculation                                                    */
/* ------------------------------------------------------------------ */

function senderBlock(cfg) {
  const out = { senderClient: { name: cfg.sender.name, phones: cfg.sender.phone ? [cfg.sender.phone] : [] } };
  if (cfg.sender.officeCode) out.senderOfficeCode = cfg.sender.officeCode;
  else {
    out.senderAddress = {
      city: { country: { code3: 'BGR' }, name: cfg.sender.city, postCode: cfg.sender.postCode },
      street: cfg.sender.street,
      num: cfg.sender.num,
    };
  }
  return out;
}

/**
 * dest: { mode: 'office'|'address', officeCode, city: {id?, name, postCode}, street, num, other, fullAddress }
 * Returns { price (EUR), currency, service, weight }.
 */
export async function econtQuote(cfg, dest, weightKg, receiver = {}) {
  const label = {
    ...senderBlock(cfg),
    receiverClient: { name: receiver.name || 'Клиент', phones: [receiver.phone || '0888000000'] },
    packCount: 1,
    shipmentType: 'PACK',
    weight: Math.max(0.1, Math.round(weightKg * 100) / 100),
    shipmentDescription: 'Велосипеди и части',
    paymentSenderMethod: 'CASH',
  };
  if (dest.mode === 'office') {
    if (!dest.officeCode) throw new Error('office_required');
    label.receiverOfficeCode = String(dest.officeCode);
  } else {
    const city = dest.city || {};
    if (!city.name && !city.id) throw new Error('city_required');
    const addr = { city: { country: { code3: 'BGR' } } };
    if (city.id) addr.city.id = Number(city.id);
    if (city.name) addr.city.name = city.name;
    if (city.postCode) addr.city.postCode = city.postCode;
    if (dest.fullAddress) addr.fullAddress = dest.fullAddress;
    else {
      if (dest.street) addr.street = dest.street;
      if (dest.num) addr.num = dest.num;
      if (dest.other) addr.other = dest.other;
      if (!dest.street && !dest.num) addr.fullAddress = [dest.other].filter(Boolean).join(' ');
    }
    label.receiverAddress = addr;
  }

  const data = await econtCall(cfg, 'Shipments/LabelService.createLabel.json', { label, mode: 'calculate' });
  const out = data && data.label ? data.label : null;
  if (!out || typeof out.totalPrice !== 'number') throw new Error('econt_no_price');
  let price = out.totalPrice;
  let currency = out.currency || 'EUR';
  if (currency === 'BGN') { price = price / BGN_PER_EUR; currency = 'EUR'; }
  price = Math.round(price * 100) / 100;
  const service = Array.isArray(out.services) && out.services[0] ? out.services[0].description || '' : '';
  return { price, currency, service, weight: label.weight };
}

export async function handleEcontQuote(request, env) {
  const cfg = econtConfig(env);
  let body;
  try { body = await request.json(); } catch (_) { return jsonNoStore({ error: 'invalid' }, 400); }
  if (!body || typeof body !== 'object') return jsonNoStore({ error: 'invalid' }, 400);

  const mode = body.mode === 'office' ? 'office' : 'address';
  const grams = Math.max(0, parseInt(body.weightGrams, 10) || 0);
  const weightKg = grams > 0 ? grams / 1000 : cfg.defaultWeightKg;
  const subtotal = Math.max(0, parseFloat(body.subtotal) || 0);

  if (cfg.freeOver > 0 && subtotal >= cfg.freeOver) {
    return jsonNoStore({ price: 0, currency: 'EUR', free: true, weight: weightKg, mode });
  }

  const dest = {
    mode,
    officeCode: str(body.officeCode, 16),
    city: body.city && typeof body.city === 'object'
      ? { id: parseInt(body.city.id, 10) || undefined, name: str(body.city.name, 80), postCode: str(body.city.postCode, 12) }
      : {},
    street: str(body.street, 120),
    num: str(body.num, 16),
    other: str(body.other, 120),
  };
  try {
    const q = await econtQuote(cfg, dest, weightKg, { name: str(body.name, 80), phone: str(body.phone, 24) });
    return jsonNoStore({ ...q, free: false, mode });
  } catch (err) {
    return jsonNoStore({ error: 'quote_failed', detail: String(err.message || err), mode }, 502);
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).trim().slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Shopify CarrierService callback                                      */
/* ------------------------------------------------------------------ */

async function verifyCarrierHmac(request, rawBody, env) {
  const secret = env.SHOPIFY_CARRIER_SECRET || env.SHOPIFY_API_SECRET;
  const given = request.headers.get('X-Shopify-Hmac-Sha256') || '';
  if (!secret || !given) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function cents(eur) {
  return String(Math.round(eur * 100));
}

function rateRow(mode, priceEur, description) {
  return {
    service_name: mode === 'office' ? 'Еконт — до офис' : 'Еконт — до адрес',
    service_code: mode === 'office' ? 'ECONT_OFFICE' : 'ECONT_ADDRESS',
    total_price: cents(priceEur),
    currency: 'EUR',
    description: description || '',
  };
}

export async function handleCarrierRates(request, env) {
  if (request.method !== 'POST') return jsonNoStore({ error: 'method_not_allowed' }, 405);
  const raw = await request.text();
  if (!(await verifyCarrierHmac(request, raw, env))) return jsonNoStore({ error: 'unauthorized' }, 401);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return jsonNoStore({ rates: [] }); }
  const rate = payload && payload.rate ? payload.rate : {};
  const dest = rate.destination || {};
  const items = Array.isArray(rate.items) ? rate.items : [];
  const cfg = econtConfig(env);

  // Only Bulgaria is served through Econt; anything else gets no rates here
  // so Shopify falls back to whatever manual rates exist.
  if (dest.country && String(dest.country).toUpperCase() !== 'BG') return jsonNoStore({ rates: [] });

  let grams = 0;
  let subtotal = 0;
  for (const it of items) {
    if (it.requires_shipping === false) continue;
    const qty = parseInt(it.quantity, 10) || 1;
    grams += (parseInt(it.grams, 10) || 0) * qty;
    subtotal += ((parseInt(it.price, 10) || 0) / 100) * qty;
  }
  const weightKg = grams > 0 ? grams / 1000 : cfg.defaultWeightKg;

  const address1 = String(dest.address1 || '');
  const marker = address1.match(OFFICE_MARKER);
  const mode = marker ? 'office' : 'address';

  if (cfg.freeOver > 0 && subtotal >= cfg.freeOver) {
    return jsonNoStore({ rates: [rateRow(mode, 0, 'Безплатна доставка')] });
  }

  const destination = marker
    ? { mode, officeCode: marker[1] }
    : {
        mode,
        city: { name: String(dest.city || ''), postCode: String(dest.postal_code || '') },
        fullAddress: [address1, dest.address2].filter(Boolean).join(', '),
      };

  try {
    const q = await econtQuote(cfg, destination, weightKg, { name: dest.name || '', phone: dest.phone || '' });
    return jsonNoStore({ rates: [rateRow(mode, q.price, q.service)] });
  } catch (err) {
    console.error('econt carrier quote failed:', err && err.message ? err.message : err);
    const fb = mode === 'office' ? cfg.fallback.office : cfg.fallback.address;
    if (fb > 0) return jsonNoStore({ rates: [rateRow(mode, fb, 'Ориентировъчна цена')] });
    return jsonNoStore({ rates: [] });
  }
}

/* ------------------------------------------------------------------ */

function jsonPublic(data, maxAge) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` },
  });
}

function jsonNoStore(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

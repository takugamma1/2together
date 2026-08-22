/**
 * club-backend — Cloudflare Worker behind the Shopify App Proxy at /apps/club/*.
 *
 * Endpoints (routed on the trailing path segment, so both "/rsvp" and
 * "/apps/club/rsvp" work regardless of how Shopify forwards the path):
 *
 *   GET  /status?ride=<id>   -> { count, capacity, mine }
 *   POST /rsvp   {ride, status: 'going'|'not_going'}
 *   GET  /poll?poll=<id>     -> { counts: {<optionGid>: n}, mine: <optionGid>|null }
 *   POST /vote   {poll, option}
 *   GET  /reviews            -> { name, rating, total, mapsUrl, reviews:[...] } (Google, cached 12h)
 *   GET  /youtube            -> { channelTitle, channelUrl, videos:[...] } (YouTube RSS, cached 30m)
 *
 * Secrets (wrangler secret put):
 *   SHOPIFY_API_SECRET  — app proxy app's client secret (signature verification)
 *   SHOPIFY_ADMIN_TOKEN — admin custom app token (shpat_...)
 *   SHOP                — myshopify domain, e.g. my-store.myshopify.com
 *   GOOGLE_PLACES_KEY   — Google Places API (New) key (for /reviews)
 *
 * Vars (wrangler.toml [vars]):
 *   GOOGLE_PLACE_ID     — Google Place ID of the business (public; for /reviews)
 *   YOUTUBE_CHANNEL_ID  — channel ID (UC...); public; for /youtube
 */

const ADMIN_API_VERSION = '2025-10';
const TIMESTAMP_TOLERANCE_S = 300;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // --- Authenticate EVERY request (Shopify app proxy signature) ---
      const authError = await verifyProxyRequest(url, env);
      if (authError) return json({ error: authError }, 401);

      // Trusted only because the signature verified above.
      const customerId =
        numericId(url.searchParams.get('logged_in_customer_id') || '') || null;

      const segment =
        url.pathname.split('/').filter(Boolean).pop() || '';

      switch (segment) {
        case 'status':
          if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
          return await handleStatus(url, env, customerId);
        case 'rsvp':
          if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
          return await handleRsvp(request, env, customerId);
        case 'poll':
          if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
          return await handlePoll(url, env, customerId);
        case 'vote':
          if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
          return await handleVote(request, env, customerId);
        case 'reviews':
          if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
          return await handleReviews(env, ctx);
        case 'youtube':
          if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
          return await handleYoutube(env, ctx);
        case 'rental-availability':
          if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
          return await handleRentalAvailability(url, env);
        case 'service-slots':
          return handleServiceSlots(url, env);
        case 'service-book':
          return handleServiceBook(request, env, customerId);
        case 'rental-book':
          if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
          return await handleRentalBook(request, env, customerId);
        default:
          return json({ error: 'not_found' }, 404);
      }
    } catch (err) {
      console.error('club-backend error:', err && err.stack ? err.stack : err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* App proxy signature verification                                    */
/* ------------------------------------------------------------------ */

/**
 * Returns null when the request is authentic, otherwise an error string.
 *
 * Shopify app proxy signature: take every query param except `signature`,
 * sort keys alphabetically, build "key=value" pairs (multiple values for
 * the same key joined with a comma), concatenate with NO separator,
 * HMAC-SHA256 with the app's client secret, hex-encode, compare.
 */
async function verifyProxyRequest(url, env) {
  const params = url.searchParams;
  const signature = params.get('signature');
  if (!signature) return 'missing_signature';

  const keys = [...new Set([...params.keys()])]
    .filter((k) => k !== 'signature')
    .sort();
  const message = keys
    .map((k) => `${k}=${params.getAll(k).join(',')}`)
    .join('');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SHOPIFY_API_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  );
  const expected = toHex(new Uint8Array(mac));

  if (!timingSafeEqual(expected, signature.toLowerCase())) {
    return 'invalid_signature';
  }

  // Signature is valid — now pin the shop and reject stale requests.
  if (params.get('shop') !== env.SHOP) return 'wrong_shop';

  const ts = parseInt(params.get('timestamp') || '', 10);
  if (!Number.isFinite(ts)) return 'missing_timestamp';
  if (Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE_S) {
    return 'stale_timestamp';
  }

  return null;
}

function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

// GET /status?ride=<id>
async function handleStatus(url, env, customerId) {
  const rideGid = metaobjectGid(url.searchParams.get('ride'));
  if (!rideGid) return json({ error: 'bad_request' }, 400);

  const ride = await fetchMetaobjectFields(env, rideGid);
  if (!ride) return json({ error: 'not_found' }, 404);
  const capacity = intOr0(ride.fields.capacity);

  const rsvps = await listMetaobjects(env, 'ride_rsvp');
  const { count, mine } = summarizeRsvps(rsvps, rideGid, customerId);

  return json({ count, capacity, mine: mine ? mine.status : null });
}

// POST /rsvp  {ride, status}
async function handleRsvp(request, env, customerId) {
  if (!customerId) return json({ error: 'not_logged_in' }, 401);

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400);
  const status = body.status;
  if (status !== 'going' && status !== 'not_going') {
    return json({ error: 'bad_request' }, 400);
  }
  const rideGid = metaobjectGid(body.ride);
  if (!rideGid) return json({ error: 'bad_request' }, 400);
  const rideNum = numericId(rideGid);

  const ride = await fetchMetaobjectFields(env, rideGid);
  if (!ride) return json({ error: 'not_found' }, 404);
  const capacity = intOr0(ride.fields.capacity);

  // Pre-check capacity (capacity 0/blank = unlimited).
  let rsvps = await listMetaobjects(env, 'ride_rsvp');
  let summary = summarizeRsvps(rsvps, rideGid, customerId);
  const alreadyGoing = summary.mine && summary.mine.status === 'going';
  if (status === 'going' && capacity > 0 && summary.count >= capacity && !alreadyGoing) {
    return json({ error: 'full' }, 409);
  }

  const customer = await fetchCustomer(env, customerId);
  if (!customer) return json({ error: 'not_logged_in' }, 401);

  await metaobjectUpsert(env, 'ride_rsvp', `r${rideNum}-c${customerId}`, [
    { key: 'ride', value: rideGid },
    { key: 'customer_id', value: customerId },
    { key: 'customer_name', value: customer.displayName || '' },
    { key: 'customer_email', value: customer.email || '' },
    { key: 'status', value: status },
    { key: 'rsvp_at', value: new Date().toISOString() },
  ]);

  // Recount and persist going_count on the ride.
  rsvps = await listMetaobjects(env, 'ride_rsvp');
  summary = summarizeRsvps(rsvps, rideGid, customerId);
  let count = summary.count;

  // Best-effort race compensation: if we tipped the ride over capacity and
  // our RSVP is the newest 'going' entry, withdraw it and report 'full'.
  if (status === 'going' && capacity > 0 && count > capacity && summary.mine) {
    const others = summary.going.filter((e) => e.id !== summary.mine.id);
    const mineIsNewest = others.every(
      (e) => (e.rsvpAt || '') <= (summary.mine.rsvpAt || '')
    );
    if (mineIsNewest) {
      await metaobjectDelete(env, summary.mine.id);
      count -= 1;
      await writeGoingCount(env, rideGid, count);
      return json({ error: 'full' }, 409);
    }
  }

  await writeGoingCount(env, rideGid, count);
  return json({ count, capacity, mine: status });
}

// GET /poll?poll=<id>
async function handlePoll(url, env, customerId) {
  const pollGid = metaobjectGid(url.searchParams.get('poll'));
  if (!pollGid) return json({ error: 'bad_request' }, 400);

  const poll = await fetchMetaobjectFields(env, pollGid);
  if (!poll) return json({ error: 'not_found' }, 404);
  const optionGids = parseOptionList(poll.fields.options);

  const votes = await listMetaobjects(env, 'poll_vote');
  const { counts, mine } = summarizeVotes(votes, pollGid, optionGids, customerId);

  return json({ counts, mine });
}

// POST /vote  {poll, option}
async function handleVote(request, env, customerId) {
  if (!customerId) return json({ error: 'not_logged_in' }, 401);

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400);
  const pollGid = metaobjectGid(body.poll);
  const optionGid = metaobjectGid(body.option);
  if (!pollGid || !optionGid) return json({ error: 'bad_request' }, 400);
  const pollNum = numericId(pollGid);

  // Members only.
  const customer = await fetchCustomer(env, customerId);
  if (!customer) return json({ error: 'not_logged_in' }, 401);
  const tags = (customer.tags || []).map((t) => String(t).trim().toLowerCase());
  if (!tags.includes('member')) return json({ error: 'not_member' }, 403);

  const poll = await fetchMetaobjectFields(env, pollGid);
  if (!poll) return json({ error: 'not_found' }, 404);
  const optionGids = parseOptionList(poll.fields.options);
  if (!optionGids.includes(optionGid)) return json({ error: 'bad_request' }, 400);

  await metaobjectUpsert(env, 'poll_vote', `p${pollNum}-c${customerId}`, [
    { key: 'poll', value: pollGid },
    { key: 'option', value: optionGid },
    { key: 'customer_id', value: customerId },
    { key: 'voted_at', value: new Date().toISOString() },
  ]);

  // Recount and persist vote_count on every option of this poll.
  const votes = await listMetaobjects(env, 'poll_vote');
  const { counts, mine } = summarizeVotes(votes, pollGid, optionGids, customerId);
  for (const gid of optionGids) {
    await metaobjectUpdate(env, gid, [
      { key: 'vote_count', value: String(counts[gid] || 0) },
    ]);
  }

  return json({ counts, mine });
}

/* ------------------------------------------------------------------ */
/* Google reviews (Places API New, edge-cached 12h)                    */
/* ------------------------------------------------------------------ */

// GET /reviews -> slim, theme-friendly payload. Cached in the Worker edge
// cache for 12h so Google is hit ~twice a day regardless of store traffic.
async function handleReviews(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://reviews.cache.local/google-reviews');

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const data = await fetchGoogleReviews(env);
  const resp = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      // Don't cache error payloads — only good responses.
      'Cache-Control': data.error ? 'no-store' : 'public, max-age=43200',
    },
  });
  if (!data.error && ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  }
  return resp;
}

async function fetchGoogleReviews(env) {
  const placeId = env.GOOGLE_PLACE_ID;
  if (!placeId || !env.GOOGLE_PLACES_KEY) {
    return { rating: null, total: 0, reviews: [], error: 'not_configured' };
  }
  let res;
  try {
    res = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY,
          'X-Goog-FieldMask':
            'id,displayName,rating,userRatingCount,googleMapsUri,reviews',
        },
      }
    );
  } catch (e) {
    return { rating: null, total: 0, reviews: [], error: 'fetch_failed' };
  }
  if (!res.ok) {
    return { rating: null, total: 0, reviews: [], error: `google_${res.status}` };
  }
  const p = await res.json();
  const reviews = (p.reviews || []).map((r) => {
    const a = r.authorAttribution || {};
    return {
      author: a.displayName || '',
      photo: a.photoUri || '',
      profile: a.uri || '',
      rating: r.rating || 0,
      text:
        ((r.text && r.text.text) ||
          (r.originalText && r.originalText.text) ||
          '').trim(),
      time: r.relativePublishTimeDescription || '',
      publishTime: r.publishTime || '',
    };
  });
  return {
    name: (p.displayName && p.displayName.text) || '',
    rating: typeof p.rating === 'number' ? p.rating : null,
    total: p.userRatingCount || 0,
    mapsUrl: p.googleMapsUri || '',
    reviews,
  };
}

/* ------------------------------------------------------------------ */
/* YouTube latest videos (public RSS feed, edge-cached 30m)            */
/* ------------------------------------------------------------------ */

// GET /youtube -> latest uploads with per-video stats. Uses the public
// channel RSS feed (no API key): title, thumbnail, views and rating count
// (≈ likes, since dislikes are hidden) come straight from the feed.
async function handleYoutube(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://youtube.cache.local/latest-videos');

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const data = await fetchYoutubeFeed(env);
  const resp = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      // Don't cache error payloads — only good responses.
      'Cache-Control': data.error ? 'no-store' : 'public, max-age=1800',
    },
  });
  if (!data.error && ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  }
  return resp;
}

async function fetchYoutubeFeed(env) {
  const channelId = env.YOUTUBE_CHANNEL_ID;
  if (!channelId) {
    return { channelTitle: '', channelUrl: '', videos: [], error: 'not_configured' };
  }
  let res;
  try {
    res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { headers: { Accept: 'application/atom+xml' } }
    );
  } catch (e) {
    return { channelTitle: '', channelUrl: '', videos: [], error: 'fetch_failed' };
  }
  if (!res.ok) {
    return { channelTitle: '', channelUrl: '', videos: [], error: `youtube_${res.status}` };
  }
  const xml = await res.text();

  const channelTitle = decodeXml(
    (xml.split('<entry>')[0].match(/<title>([^<]*)<\/title>/) || [])[1] || ''
  );

  const videos = xml
    .split('<entry>')
    .slice(1)
    .map((entry) => {
      const pick = (re) => (entry.match(re) || [])[1] || '';
      const id = pick(/<yt:videoId>([^<]+)<\/yt:videoId>/);
      if (!id) return null;
      return {
        id,
        title: decodeXml(pick(/<media:title>([^<]*)<\/media:title>/) || pick(/<title>([^<]*)<\/title>/)),
        published: pick(/<published>([^<]+)<\/published>/),
        thumb: pick(/<media:thumbnail url="([^"]+)"/) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        views: parseInt(pick(/<media:statistics views="(\d+)"/), 10) || 0,
        likes: parseInt(pick(/<media:starRating count="(\d+)"/), 10) || 0,
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    })
    .filter(Boolean);

  return {
    channelTitle,
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    videos,
  };
}

function decodeXml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ */
/* Counting helpers                                                    */
/* ------------------------------------------------------------------ */

function summarizeRsvps(allRsvps, rideGid, customerId) {
  const forRide = allRsvps.filter((m) => m.fields.ride === rideGid);
  const going = forRide
    .filter((m) => m.fields.status === 'going')
    .map((m) => ({ id: m.id, rsvpAt: m.fields.rsvp_at || '' }));
  const mineEntry = customerId
    ? forRide.find((m) => m.fields.customer_id === customerId)
    : null;
  const mine = mineEntry
    ? {
        id: mineEntry.id,
        status: mineEntry.fields.status,
        rsvpAt: mineEntry.fields.rsvp_at || '',
      }
    : null;
  return { count: going.length, going, mine };
}

function summarizeVotes(allVotes, pollGid, optionGids, customerId) {
  const counts = {};
  for (const gid of optionGids) counts[gid] = 0;
  let mine = null;
  for (const m of allVotes) {
    if (m.fields.poll !== pollGid) continue;
    const option = m.fields.option;
    if (option in counts) counts[option] += 1;
    if (customerId && m.fields.customer_id === customerId) mine = option || null;
  }
  return { counts, mine };
}

function parseOptionList(rawValue) {
  // list.metaobject_reference field value is a JSON-encoded array of GIDs.
  if (!rawValue) return [];
  try {
    const arr = JSON.parse(rawValue);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Shopify Admin API                                                   */
/* ------------------------------------------------------------------ */

async function adminGraphQL(env, query, variables) {
  const res = await fetch(
    `https://${env.SHOP}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    }
  );
  if (!res.ok) {
    throw new Error(`Admin API HTTP ${res.status}: ${await res.text()}`);
  }
  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    throw new Error(`Admin API errors: ${JSON.stringify(payload.errors)}`);
  }
  return payload.data;
}

/** Fetch one metaobject and flatten its fields to { key: value }. */
async function fetchMetaobjectFields(env, gid) {
  const data = await adminGraphQL(
    env,
    `query Metaobject($id: ID!) {
      metaobject(id: $id) {
        id
        handle
        fields { key value }
      }
    }`,
    { id: gid }
  );
  if (!data.metaobject) return null;
  return flattenNode(data.metaobject);
}

/** List ALL metaobjects of a type (paginated, 250 per page). */
async function listMetaobjects(env, type) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await adminGraphQL(
      env,
      `query List($type: String!, $cursor: String) {
        metaobjects(type: $type, first: 250, after: $cursor) {
          nodes {
            id
            handle
            fields { key value }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { type, cursor }
    );
    const page = data.metaobjects;
    for (const node of page.nodes) out.push(flattenNode(node));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

function flattenNode(node) {
  const fields = {};
  for (const f of node.fields || []) fields[f.key] = f.value;
  return { id: node.id, handle: node.handle, fields };
}

async function metaobjectUpsert(env, type, handle, fields) {
  const data = await adminGraphQL(
    env,
    `mutation Upsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    { handle: { type, handle }, metaobject: { fields } }
  );
  throwOnUserErrors(data.metaobjectUpsert.userErrors, 'metaobjectUpsert');
  return data.metaobjectUpsert.metaobject;
}

async function metaobjectUpdate(env, gid, fields) {
  const data = await adminGraphQL(
    env,
    `mutation Update($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    { id: gid, metaobject: { fields } }
  );
  throwOnUserErrors(data.metaobjectUpdate.userErrors, 'metaobjectUpdate');
  return data.metaobjectUpdate.metaobject;
}

async function metaobjectDelete(env, gid) {
  const data = await adminGraphQL(
    env,
    `mutation Delete($id: ID!) {
      metaobjectDelete(id: $id) {
        deletedId
        userErrors { field message }
      }
    }`,
    { id: gid }
  );
  throwOnUserErrors(data.metaobjectDelete.userErrors, 'metaobjectDelete');
  return data.metaobjectDelete.deletedId;
}

async function fetchCustomer(env, customerNumericId) {
  const data = await adminGraphQL(
    env,
    `query Customer($id: ID!) {
      customer(id: $id) {
        id
        displayName
        email
        tags
      }
    }`,
    { id: `gid://shopify/Customer/${customerNumericId}` }
  );
  return data.customer || null;
}

function writeGoingCount(env, rideGid, count) {
  return metaobjectUpdate(env, rideGid, [
    { key: 'going_count', value: String(count) },
  ]);
}

function throwOnUserErrors(userErrors, label) {
  if (userErrors && userErrors.length) {
    throw new Error(`${label} userErrors: ${JSON.stringify(userErrors)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/** "gid://shopify/Metaobject/123" or "123" -> "123" (null when invalid). */
function numericId(value) {
  const s = String(value == null ? '' : value).trim();
  let m = s.match(/^gid:\/\/shopify\/[A-Za-z]+\/(\d+)$/);
  if (m) return m[1];
  m = s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

/** Normalize an incoming ride/poll/option id to a Metaobject GID. */
function metaobjectGid(value) {
  const n = numericId(value);
  return n ? `gid://shopify/Metaobject/${n}` : null;
}

function intOr0(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}


/* ------------------------------------------------------------------ */
/* Bike rental — availability + booking (metaobjects) + Google Calendar */
/* ------------------------------------------------------------------ */
/*
 * Secrets (wrangler secret put …):
 *   GOOGLE_SA_EMAIL   service-account e-mail (…@….iam.gserviceaccount.com)
 *   GOOGLE_SA_KEY     service-account private key (PEM, \n-escaped ok)
 *   GOOGLE_CALENDAR_ID calendar id shared with the service account (e.g. abc@group.calendar.google.com)
 * Without them bookings still work; the calendar mirror is skipped.
 *
 * GET  /apps/club/rental-availability?from=YYYY-MM-DD&to=YYYY-MM-DD
 *      → { bikes: [{handle, name, count}], booked: { [bikeHandle]: { [YYYY-MM-DD]: unitsBooked } } }
 *      Calendar events titled "BLOCK <bike-handle>" (or "BLOCK all") count as fully booked.
 * POST /apps/club/rental-book  {bike, quantity, mode:'short'|'long', start, end, name, phone, email, note, price}
 *      → { ok, reference } / 409 {error:'unavailable'} / 400 {error:'invalid'}
 */
const DAY = 86400000;
function dayKey(d) { return new Date(d).toISOString().slice(0, 10); }
function daysBetween(startIso, endIso) {
  const out = []; let t = new Date(dayKey(startIso)).getTime(); const end = new Date(dayKey(endIso)).getTime();
  while (t <= end) { out.push(new Date(t).toISOString().slice(0, 10)); t += DAY; }
  return out;
}
async function rentalBikes(env) {
  const list = await listMetaobjects(env, 'rental_bike');
  return list.filter(b => String(b.fields.active) === 'true').map(b => ({ id: b.id, handle: b.handle, name: b.fields.name, count: parseInt(b.fields.count || '0', 10) || 0 }));
}
async function rentalBookedMap(env, fromIso, toIso) {
  const bookings = await listMetaobjects(env, 'rental_booking');
  const booked = {};
  const add = (handle, day, n) => { booked[handle] = booked[handle] || {}; booked[handle][day] = (booked[handle][day] || 0) + n; };
  const from = new Date(dayKey(fromIso)).getTime(), to = new Date(dayKey(toIso)).getTime();
  for (const b of bookings) {
    const f = b.fields; if (!f.start || !f.end || f.status === 'cancelled') continue;
    const handle = f.bike_handle || (f.bike ? f.bike : ''); // bike_handle is stored alongside the reference for cheap lookups
    if (!handle) continue;
    for (const day of daysBetween(f.start, f.end)) { const t = new Date(day).getTime(); if (t >= from && t <= to) add(handle, day, parseInt(f.quantity || '1', 10) || 1); }
  }
  // Google Calendar blocks
  try {
    const events = await gcalList(env, fromIso, toIso);
    for (const ev of events) {
      const m = /^BLOCK\s+(\S+)/i.exec(ev.summary || ''); if (!m) continue;
      const target = m[1].toLowerCase(); const s = ev.start.date || ev.start.dateTime, e = ev.end.date ? new Date(new Date(ev.end.date).getTime() - DAY).toISOString() : ev.end.dateTime;
      for (const day of daysBetween(s, e)) add(target === 'all' ? '*' : target, day, 9999);
    }
  } catch (e) { console.warn('gcal list skipped:', e && e.message); }
  return booked;
}
async function handleRentalAvailability(url, env) {
  const from = url.searchParams.get('from') || dayKey(Date.now());
  const to = url.searchParams.get('to') || dayKey(Date.now() + 90 * DAY);
  const [bikes, booked] = await Promise.all([rentalBikes(env), rentalBookedMap(env, from, to)]);
  return json({ bikes, booked, from, to }, 200, { 'Cache-Control': 'private, max-age=60' });
}
async function handleRentalBook(request, env, customerId) {
  const body = await readJson(request); if (!body) return json({ error: 'invalid' }, 400);
  const { bike, quantity, mode, start, end, name, phone, email, note, price } = body;
  const qty = parseInt(quantity || '1', 10) || 1;
  if (!bike || !start || !end || !name || !phone || !['short', 'long'].includes(mode)) return json({ error: 'invalid' }, 400);
  if (new Date(end) <= new Date(start)) return json({ error: 'invalid' }, 400);
  if (mode === 'short' && (new Date(end) - new Date(start)) > DAY + 60000) return json({ error: 'invalid' }, 400);
  const bikes = await rentalBikes(env); const b = bikes.find(x => x.handle === bike);
  if (!b) return json({ error: 'invalid' }, 400);
  const booked = await rentalBookedMap(env, start, end);
  for (const day of daysBetween(start, end)) {
    const used = ((booked[bike] || {})[day] || 0) + ((booked['*'] || {})[day] || 0);
    if (used + qty > b.count) return json({ error: 'unavailable', day }, 409);
  }
  const reference = 'R' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  let eventId = '';
  try { eventId = await gcalInsert(env, { summary: `${b.name} ×${qty} — ${name}`, description: `Резервация ${reference}\n${mode === 'short' ? 'Краткосрочен' : 'Дългосрочен'} наем\nТел: ${phone}\nИмейл: ${email || '-'}\nЦена: €${price || '-'}\n${note || ''}`, start, end, mode }); } catch (e) { console.warn('gcal insert skipped:', e && e.message); }
  const fields = [
    ['reference', reference], ['bike', b.id], ['bike_handle', bike], ['quantity', String(qty)], ['mode', mode], ['start', new Date(start).toISOString()], ['end', new Date(end).toISOString()],
    ['status', 'pending'], ['customer_name', name], ['phone', phone], ['email', email || ''], ['note', note || ''], ['price', price ? String(price) : ''], ['calendar_event', eventId],
  ].filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value }));
  await metaobjectUpsert(env, 'rental_booking', reference.toLowerCase(), fields);
  return json({ ok: true, reference });
}

/* ═══════════════════════════ SERVICE BOOKING ═══════════════════════════
   Metaobjects: mechanic (shifts per weekday, days_off, slot_minutes, active),
   service_type (duration_minutes, price_from, active), service_booking.
   GET  /apps/club/service-slots?from=YYYY-MM-DD&days=28&service=<handle>&mechanic=<handle|any>
   POST /apps/club/service-book {mechanic, service, start, name, phone, email, bike, note}
   Calendar: SERVICE_CALENDAR_ID (events titled "[Mechanic] Service — Name"; "BLOCK <mechanic>|all" events block slots)
   E-mail: RESEND_API_KEY + NOTIFY_FROM + NOTIFY_TO (optional; skipped when unset) */
const TZ = 'Europe/Sofia';
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function tzOffsetMin(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(utcMs));
  const g = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return Math.round((asUtc - utcMs) / 60000);
}
function localToUtc(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return guess - tzOffsetMin(guess) * 60000;
}
function localDateKey(utcMs) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(utcMs));
  const g = (t) => parts.find(p => p.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}
function localHHMM(utcMs) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(utcMs));
  const g = (t) => parts.find(p => p.type === t).value; return `${g('hour')}:${g('minute')}`;
}
function parseShifts(text) {
  // "mon=09:00-13:00,14:00-18:00" per line; also accepts Bulgarian day names
  const map = {}; const bg = { 'пон': 'mon', 'вт': 'tue', 'ср': 'wed', 'чет': 'thu', 'пет': 'fri', 'съб': 'sat', 'нед': 'sun' };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const [k, v] = line.split(/[=:](?=\s*\d)/); if (!k || !v) continue;
    let day = k.trim().toLowerCase().slice(0, 3); day = bg[day] || day; if (!WD.includes(day)) continue;
    map[day] = v.split(',').map(r => r.trim()).filter(Boolean).map(r => { const [a, b] = r.split('-').map(x => x.trim()); return [a, b]; });
  }
  return map;
}
async function serviceContext(env) {
  const [mechanics, services, bookings] = await Promise.all([listMetaobjects(env, 'mechanic'), listMetaobjects(env, 'service_type'), listMetaobjects(env, 'service_booking')]);
  const m = mechanics.filter(x => x.fields.active === 'true').map(x => ({ id: x.id, handle: x.handle, name: x.fields.name, shifts: parseShifts(x.fields.shifts), daysOff: String(x.fields.days_off || '').split(/\s+/).filter(Boolean), slot: parseInt(x.fields.slot_minutes || '60', 10) || 60, sort: parseInt(x.fields.sort || '0', 10) }));
  m.sort((a, b) => a.sort - b.sort);
  const sv = services.filter(x => x.fields.active !== 'false').map(x => ({ id: x.id, handle: x.handle, name: x.fields.name, duration: parseInt(x.fields.duration_minutes || '60', 10) || 60, price: x.fields.price_from || '' }));
  const busy = bookings.filter(b => b.fields.start && b.fields.end && b.fields.status !== 'cancelled').map(b => ({ mechanic: b.fields.mechanic_handle, start: new Date(b.fields.start).getTime(), end: new Date(b.fields.end).getTime() }));
  return { mechanics: m, services: sv, busy };
}
async function serviceBlocks(env, fromIso, toIso) {
  const blocks = [];
  try {
    const events = await gcalList(env, fromIso, toIso, env.SERVICE_CALENDAR_ID);
    for (const ev of events) {
      const mm = /^BLOCK\s+(\S+)/i.exec(ev.summary || ''); if (!mm) continue;
      const s = ev.start.dateTime ? new Date(ev.start.dateTime).getTime() : localToUtc(ev.start.date, '00:00');
      const e = ev.end.dateTime ? new Date(ev.end.dateTime).getTime() : localToUtc(ev.end.date, '00:00');
      blocks.push({ mechanic: mm[1].toLowerCase(), start: s, end: e });
    }
  } catch (e) { console.warn('service gcal list skipped:', e && e.message); }
  return blocks;
}
function freeStarts(mech, dateStr, durationMin, busy, blocks, nowPlusLead) {
  if (mech.daysOff.includes(dateStr)) return [];
  const wd = WD[new Date(dateStr + 'T12:00:00Z').getUTCDay()];
  const ranges = mech.shifts[wd] || []; const out = [];
  for (const [a, b] of ranges) {
    const rs = localToUtc(dateStr, a), re = localToUtc(dateStr, b);
    for (let t = rs; t + durationMin * 60000 <= re; t += mech.slot * 60000) {
      const tEnd = t + durationMin * 60000;
      if (t < nowPlusLead) continue;
      const clash = busy.some(x => x.mechanic === mech.handle && x.start < tEnd && x.end > t) || blocks.some(x => (x.mechanic === 'all' || x.mechanic === mech.handle) && x.start < tEnd && x.end > t);
      if (!clash) out.push(localHHMM(t));
    }
  }
  return out;
}
async function handleServiceSlots(url, env) {
  const from = url.searchParams.get('from') || localDateKey(Date.now());
  const days = Math.min(parseInt(url.searchParams.get('days') || '28', 10) || 28, 60);
  const serviceHandle = url.searchParams.get('service'); const mechanicHandle = url.searchParams.get('mechanic') || 'any';
  const ctx = await serviceContext(env);
  const service = ctx.services.find(s => s.handle === serviceHandle) || { duration: 60 };
  const toMs = localToUtc(from, '00:00') + days * DAY; const to = new Date(toMs).toISOString().slice(0, 10);
  const blocks = await serviceBlocks(env, from, to);
  const lead = Date.now() + (parseInt(env.SERVICE_LEAD_MINUTES || '120', 10) || 120) * 60000;
  const mechs = mechanicHandle === 'any' ? ctx.mechanics : ctx.mechanics.filter(m => m.handle === mechanicHandle);
  const result = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(localToUtc(from, '12:00') + i * DAY); const key = localDateKey(d.getTime());
    const perMech = {};
    for (const m of mechs) { const f = freeStarts(m, key, service.duration, ctx.busy, blocks, lead); if (f.length) perMech[m.handle] = f; }
    if (Object.keys(perMech).length) result[key] = perMech;
  }
  return json({ from, days, duration: service.duration, mechanics: ctx.mechanics.map(m => ({ handle: m.handle, name: m.name })), slots: result }, 200, { 'Cache-Control': 'private, max-age=30' });
}
async function sendMail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_FROM || !to) return false;
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.NOTIFY_FROM, to: Array.isArray(to) ? to : [to], subject, html }) });
  if (!res.ok) console.warn('resend failed', res.status, await res.text()); return res.ok;
}
async function handleServiceBook(request, env, customerId) {
  const body = await readJson(request); if (!body) return json({ error: 'invalid' }, 400);
  const { mechanic, service, start, name, phone, email, bike, note } = body;
  if (!service || !start || !name || !phone) return json({ error: 'invalid' }, 400);
  const ctx = await serviceContext(env);
  const sv = ctx.services.find(x => x.handle === service); if (!sv) return json({ error: 'invalid' }, 400);
  const startMs = new Date(start).getTime(); if (!startMs || startMs < Date.now()) return json({ error: 'invalid' }, 400);
  const dateKey = localDateKey(startMs), hhmm = localHHMM(startMs);
  const blocks = await serviceBlocks(env, dateKey, dateKey);
  const lead = Date.now() + (parseInt(env.SERVICE_LEAD_MINUTES || '120', 10) || 120) * 60000;
  let candidates = mechanic && mechanic !== 'any' ? ctx.mechanics.filter(m => m.handle === mechanic) : ctx.mechanics;
  const m = candidates.find(mm => freeStarts(mm, dateKey, sv.duration, ctx.busy, blocks, lead).includes(hhmm));
  if (!m) return json({ error: 'slot_taken' }, 409);
  const endMs = startMs + sv.duration * 60000;
  const reference = 'S' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  let eventId = '';
  try { eventId = await gcalInsert(env, { calendarId: env.SERVICE_CALENDAR_ID, summary: `[${m.name}] ${sv.name} — ${name}`, description: `Резервация ${reference}\nМеханик: ${m.name}\nУслуга: ${sv.name} (${sv.duration} мин)\nКлиент: ${name}\nТел: ${phone}\nИмейл: ${email || '-'}\nКолело: ${bike || '-'}\n${note || ''}`, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), mode: 'short' }); } catch (e) { console.warn('service gcal insert skipped:', e && e.message); }
  const fields = [['reference', reference], ['mechanic', m.id], ['mechanic_handle', m.handle], ['service', sv.id], ['service_handle', sv.handle], ['start', new Date(startMs).toISOString()], ['end', new Date(endMs).toISOString()], ['status', 'pending'], ['customer_name', name], ['phone', phone], ['email', email || ''], ['bike', bike || ''], ['note', note || ''], ['price', sv.price || ''], ['calendar_event', eventId], ['customer_id', customerId ? String(customerId) : '']].map(([key, value]) => ({ key, value }));
  await metaobjectUpsert(env, 'service_booking', reference.toLowerCase(), fields);
  const when = new Intl.DateTimeFormat('bg-BG', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }).format(new Date(startMs));
  const html = `<p>Резервация <strong>${reference}</strong></p><p><strong>${sv.name}</strong> · ${when}<br>Механик: ${m.name}<br>Продължителност: ${sv.duration} мин${sv.price ? ' · от €' + sv.price : ''}</p><p>Клиент: ${name} · ${phone}${email ? ' · ' + email : ''}<br>Колело: ${bike || '-'}<br>${note || ''}</p>`;
  await Promise.all([
    sendMail(env, { to: env.NOTIFY_TO, subject: `Нов час за сервиз ${reference} — ${sv.name}, ${when}`, html }),
    email ? sendMail(env, { to: email, subject: `2gether Bikes — потвърждение за сервиз ${reference}`, html: `<p>Здравей, ${name}!</p><p>Записахме те за сервиз. Очакваме те в магазина във Варна.</p>${html}<p>Ако трябва да промениш часа, обади се на магазина.</p>` }) : Promise.resolve(false),
  ]);
  return json({ ok: true, reference, mechanic: m.name, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
}

/* Google service-account JWT → access token (RS256 via WebCrypto) */
async function gcalToken(env) {
  // Path 1 — OAuth refresh token (for Workspace orgs that block service-account keys)
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    if (!r.ok) throw new Error('google oauth refresh failed ' + r.status);
    return (await r.json()).access_token;
  }
  // Path 2 — service account (GOOGLE_SA_EMAIL + GOOGLE_SA_KEY)
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_KEY) throw new Error('gcal not configured');
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: env.GOOGLE_SA_EMAIL, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const pem = env.GOOGLE_SA_KEY.replace(/\\n/g, '\n').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const keyData = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const jwt = unsigned + '.' + btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt });
  if (!res.ok) throw new Error('gcal token ' + res.status);
  return (await res.json()).access_token;
}
async function gcalList(env, fromIso, toIso, calendarId) {
  calendarId = calendarId || env.GOOGLE_CALENDAR_ID;
  if (!calendarId) return [];
  const token = await gcalToken(env);
  const q = new URLSearchParams({ timeMin: new Date(fromIso).toISOString(), timeMax: new Date(new Date(toIso).getTime() + DAY).toISOString(), singleEvents: 'true', maxResults: '500' });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('gcal list ' + res.status);
  return (await res.json()).items || [];
}
async function gcalInsert(env, { summary, description, start, end, mode, calendarId }) {
  calendarId = calendarId || env.GOOGLE_CALENDAR_ID;
  if (!calendarId) return '';
  const token = await gcalToken(env);
  const body = mode === 'long'
    ? { summary, description, start: { date: dayKey(start) }, end: { date: dayKey(new Date(new Date(end).getTime() + DAY)) } }
    : { summary, description, start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } };
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('gcal insert ' + res.status);
  return (await res.json()).id || '';
}

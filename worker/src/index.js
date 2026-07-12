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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

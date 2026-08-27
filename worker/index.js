/**
 * Cloudflare Worker API for Model Value Map.
 * Holds the most up-to-date data as an API endpoint.
 *
 * Endpoints:
 * - GET / (or /api/data): returns the latest cached live data payload.
 * - POST / (or /api/data): validates and stores an updated payload.
 * - OPTIONS: handles CORS preflight.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// In-memory store fallback when KV binding (DATA_KV) is not configured
let memoryStore = null;

export function resetMemoryStore() {
  memoryStore = null;
}

/**
 * Validates the schema and values of the posted data format.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validatePayload(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Payload must be a non-null object' };
  }

  // 1. Timestamp
  if (typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t <= 0) {
    return { valid: false, error: 'Payload must contain a positive numeric timestamp "t"' };
  }

  // 2. Live object
  if (!data.live || typeof data.live !== 'object' || Array.isArray(data.live)) {
    return { valid: false, error: 'Payload must contain a "live" object' };
  }

  const live = data.live;

  // 3. Leaderboard
  if (!Array.isArray(live.leaderboard) || live.leaderboard.length === 0) {
    return { valid: false, error: '"live.leaderboard" must be a non-empty array' };
  }
  for (let i = 0; i < live.leaderboard.length; i++) {
    const row = live.leaderboard[i];
    if (!row || typeof row !== 'object') {
      return { valid: false, error: `Leaderboard row at index ${i} must be an object` };
    }
    if (typeof row.model !== 'string' || !row.model.trim()) {
      return { valid: false, error: `Leaderboard row at index ${i} is missing a valid "model" string` };
    }
    if (typeof row.author !== 'string') {
      return { valid: false, error: `Leaderboard row at index ${i} is missing an "author" string` };
    }
    if (typeof row.rank !== 'number' || !Number.isFinite(row.rank) || row.rank <= 0) {
      return { valid: false, error: `Leaderboard row at index ${i} is missing a valid positive "rank" number` };
    }
  }

  // 4. Token Cost
  if (!Array.isArray(live.tokenCost)) {
    return { valid: false, error: '"live.tokenCost" must be an array' };
  }
  for (let i = 0; i < live.tokenCost.length; i++) {
    const tc = live.tokenCost[i];
    if (!tc || typeof tc !== 'object') {
      return { valid: false, error: `Token cost row at index ${i} must be an object` };
    }
    if (typeof tc.model !== 'string' || !tc.model.trim()) {
      return { valid: false, error: `Token cost row at index ${i} is missing a "model" string` };
    }
    if (typeof tc.output !== 'number' || !Number.isFinite(tc.output) || tc.output < 0) {
      return { valid: false, error: `Token cost row at index ${i} is missing a valid non-negative "output" number` };
    }
    if (typeof tc.total !== 'number' || !Number.isFinite(tc.total) || tc.total < 0) {
      return { valid: false, error: `Token cost row at index ${i} is missing a valid non-negative "total" number` };
    }
  }

  // 5. OpenCode per-model pages
  if (!live.ocPages || typeof live.ocPages !== 'object' || Array.isArray(live.ocPages)) {
    return { valid: false, error: '"live.ocPages" must be an object map' };
  }

  // 6. Artificial Analysis index
  if (!Array.isArray(live.aaIndex)) {
    return { valid: false, error: '"live.aaIndex" must be an array of [slug, record] entries' };
  }
  for (let i = 0; i < live.aaIndex.length; i++) {
    const entry = live.aaIndex[i];
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== 'string') {
      return { valid: false, error: `aaIndex entry at index ${i} must be a [slug, record] pair` };
    }
    const rec = entry[1];
    if (!rec || typeof rec !== 'object') {
      return { valid: false, error: `aaIndex entry at index ${i} must contain a record object` };
    }
    if (typeof rec.intelligenceIndex !== 'number' || !Number.isFinite(rec.intelligenceIndex) || rec.intelligenceIndex < 0) {
      return { valid: false, error: `aaIndex entry at index ${i} (${entry[0]}) must have a non-negative numeric "intelligenceIndex"` };
    }
  }

  // 7. Artificial Analysis per-model pages
  if (!live.aaPages || typeof live.aaPages !== 'object' || Array.isArray(live.aaPages)) {
    return { valid: false, error: '"live.aaPages" must be an object map' };
  }

  return { valid: true };
}

export async function handleRequest(request, env = {}) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const kv = env.DATA_KV || env.model_value_map_KV;

  if (request.method === 'GET') {
    let raw = null;
    if (kv && typeof kv.get === 'function') {
      raw = await kv.get('latest');
    } else {
      raw = memoryStore;
    }

    if (!raw) {
      return new Response(JSON.stringify({ error: 'No data stored yet' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    return new Response(typeof raw === 'string' ? raw : JSON.stringify(raw), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
        ...CORS_HEADERS,
      },
    });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return new Response(JSON.stringify({ ok: false, error: 'Malformed JSON in request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    const check = validatePayload(body);
    if (!check.valid) {
      return new Response(JSON.stringify({ ok: false, error: check.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    const serialized = JSON.stringify(body);
    if (kv && typeof kv.put === 'function') {
      await kv.put('latest', serialized);
    } else {
      memoryStore = serialized;
    }

    return new Response(JSON.stringify({ ok: true, message: 'Data updated successfully', t: body.t }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};

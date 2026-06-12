import { verifyAuth } from './auth';
import { handleScheduled } from './cron';

export interface Env {
  WHITELIST_KV: KVNamespace;
  R2: R2Bucket;
  REQUIRE_WHITELIST: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, DELETE, HEAD, OPTIONS',
          // All custom request headers that clients may send must be listed here.
          // X-SHA-256 is used by BUD-02/06 for content-addressing.
          // X-Expire-Days is our custom TTL extension.
          // X-Content-Length and X-Content-Type are used by BUD-06 preflight.
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256, X-Expire-Days, X-Content-Length, X-Content-Type',
          // Cache preflight result for 24 hours (BUD-01 recommendation)
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      // Expose X-Reason so browsers can read error messages cross-origin (BUD-01)
      'Access-Control-Expose-Headers': 'X-Reason, Link, Blossom-Version',
      'Blossom-Version': '2.0.0',
    };

    try {
      if (path === '/') {
          return new Response(JSON.stringify({
              server: "Nostr Blossom Media Server",
              version: "1.0.0",
              supported_nips: [98],
              supported_buds: [1, 2, 6, 11]
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
      }

      if (method === 'PUT' && path === '/upload') {
        return await handleUpload(request, env, corsHeaders, ctx);
      }

      if (method === 'GET' && path.startsWith('/list/')) {
        const targetPubkey = path.substring(6);
        return await handleList(targetPubkey, env, corsHeaders);
      }

      // Match /:sha256
      const sha256Match = path.match(/^\/([a-f0-9]{64})$/);
      if (sha256Match) {
          const sha256 = sha256Match[1];
          if (method === 'GET') {
              return await handleGet(sha256, request, env, corsHeaders, ctx);
          } else if (method === 'HEAD') {
              return await handleHead(sha256, request, env, corsHeaders, ctx);
          } else if (method === 'DELETE') {
              return await handleDelete(sha256, request, env, corsHeaders);
          }
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (e: any) {
        return new Response(JSON.stringify({ message: "Internal Server Error", error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleScheduled(env);
  }
};

async function handleUpload(request: Request, env: Env, corsHeaders: HeadersInit, ctx: ExecutionContext): Promise<Response> {
    const authResult = await verifyAuth(request, env);
    if (!authResult.authorized) {
        return new Response(JSON.stringify({ message: authResult.error }), { status: authResult.status || 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!authResult.expectedHash) {
         return new Response(JSON.stringify({ message: 'Missing "x" tag with expected SHA-256 in auth event' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!request.body) {
         return new Response(JSON.stringify({ message: 'Missing request body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const expectedHash = authResult.expectedHash;
    const pubkey = authResult.pubkey!;
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
    const expireDaysHeader = request.headers.get('X-Expire-Days');

    let expireAtStr = '';
    if (expireDaysHeader) {
        const days = parseInt(expireDaysHeader, 10);
        if (!isNaN(days) && days > 0) {
            const expireAtUnix = Math.floor(Date.now() / 1000) + (days * 24 * 60 * 60);
            expireAtStr = expireAtUnix.toString();
        }
    }

    const customMetadata: Record<string, string> = {
        pubkey: pubkey,
        type: contentType,
        expectedHash: expectedHash
    };
    if (expireAtStr) {
        customMetadata.expireAt = expireAtStr;
    }

    // 1. Idempotency check: if this exact blob is already stored, skip the upload.
    // Blossom is content-addressed — same SHA-256 means identical bytes, so there
    // is never a need to re-write the data. We only skip if the stored object is
    // not expired; expired objects must be overwritten.
    const existing = await env.R2.head(expectedHash);
    if (existing) {
        const isExpired = existing.customMetadata?.expireAt
            ? parseInt(existing.customMetadata.expireAt, 10) < Math.floor(Date.now() / 1000)
            : false;

        if (!isExpired) {
            // Return a BlobDescriptor for the already-stored blob without re-uploading.
            const blobDescriptor = {
                url: `${new URL(request.url).origin}/${expectedHash}`,
                sha256: expectedHash,
                size: existing.size,
                type: existing.httpMetadata?.contentType || contentType,
                uploaded: Math.floor(existing.uploaded.getTime() / 1000),
            };
            return new Response(JSON.stringify(blobDescriptor), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
        // Expired blob: fall through to overwrite it below.
    }

    // 2. Tee the stream to upload and hash concurrently
    const [r2Stream, hashStream] = request.body.tee();

    // 3. Initialize streaming SHA-256 (Memory-efficient chunk processing)
    // Cloudflare Workers provides crypto.DigestStream
    const digestStream = new crypto.DigestStream("SHA-256");
    const hashPromise = hashStream.pipeTo(digestStream).then(() => digestStream.digest);

    // 4. Start R2 upload using r2Stream
    const r2PutPromise = env.R2.put(expectedHash, r2Stream, {
        httpMetadata: { contentType: contentType },
        customMetadata: customMetadata
    });

    // 5. Await both in parallel
    const [object, digest] = await Promise.all([r2PutPromise, hashPromise]);


    // 5. Convert binary digest to Hex string
    const hashArray = Array.from(new Uint8Array(digest));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // 6. Enforce Content-Address Integrity
    if (hashHex !== expectedHash) {
        // Safe Cleanup: Delete mismatched blob from R2 asynchronously
        ctx.waitUntil(env.R2.delete(expectedHash));
        return new Response(JSON.stringify({
            message: `Hash mismatch: uploaded file hash (${hashHex}) does not match expected hash (${expectedHash})`
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    const blobDescriptor = {
        url: `${new URL(request.url).origin}/${expectedHash}`,
        sha256: expectedHash,
        size: object?.size || 0,
        type: contentType,
        uploaded: Math.floor(Date.now() / 1000)
    };

    return new Response(JSON.stringify(blobDescriptor), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

async function handleGet(sha256: string, request: Request, env: Env, corsHeaders: HeadersInit, ctx: ExecutionContext): Promise<Response> {
    const object = await env.R2.get(sha256, {
        onlyIf: request.headers,
    });

    if (object === null) {
        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }

    // Handle R2 object but no body (e.g. Range Not Satisfiable)
    if (!('body' in object)) {
         return new Response('Not Modified', { status: 304, headers: corsHeaders });
    }

    // Lazy deletion check
    if (object.customMetadata && object.customMetadata.expireAt) {
        const expireAt = parseInt(object.customMetadata.expireAt, 10);
        const now = Math.floor(Date.now() / 1000);
        if (expireAt < now) {
            ctx.waitUntil(env.R2.delete(sha256));
            return new Response('Not Found (Expired)', { status: 404, headers: corsHeaders });
        }
    }

    const headers = new Headers(corsHeaders);
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);

    // Range support
    const status = object.range ? 206 : 200;
    if (object.range && 'offset' in object.range && 'length' in object.range) {
         const range = object.range as {offset: number, length: number};
         headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    }

    return new Response(object.body as unknown as ReadableStream, {
        status,
        headers,
    });
}

async function handleHead(sha256: string, request: Request, env: Env, corsHeaders: HeadersInit, ctx: ExecutionContext): Promise<Response> {
     const object = await env.R2.head(sha256);
     if (object === null) {
        return new Response('Not Found', { status: 404, headers: corsHeaders });
     }

     if (object.customMetadata && object.customMetadata.expireAt) {
        const expireAt = parseInt(object.customMetadata.expireAt, 10);
        const now = Math.floor(Date.now() / 1000);
        if (expireAt < now) {
            ctx.waitUntil(env.R2.delete(sha256));
            return new Response('Not Found (Expired)', { status: 404, headers: corsHeaders });
        }
    }

     const headers = new Headers(corsHeaders);
     object.writeHttpMetadata(headers);
     headers.set('etag', object.httpEtag);
     headers.set('content-length', object.size.toString());

     return new Response(null, {
         status: 200,
         headers
     });
}

async function handleDelete(sha256: string, request: Request, env: Env, corsHeaders: HeadersInit): Promise<Response> {
    const authResult = await verifyAuth(request, env);
    if (!authResult.authorized) {
        return new Response(JSON.stringify({ message: authResult.error }), { status: authResult.status || 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const pubkey = authResult.pubkey;
    const object = await env.R2.head(sha256);

    if (object === null) {
        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }

    if (object.customMetadata?.pubkey !== pubkey) {
        return new Response(JSON.stringify({ message: 'Forbidden: You do not own this blob' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    await env.R2.delete(sha256);
    return new Response(JSON.stringify({ message: 'Deleted successfully' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleList(pubkey: string, env: Env, corsHeaders: HeadersInit): Promise<Response> {
    const options: R2ListOptions = {
        limit: 1000,
        include: ['customMetadata', 'httpMetadata']
    } as R2ListOptions;

    let listed = await env.R2.list(options);
    let allObjects = listed.objects;

    while (listed.truncated) {
        listed = await env.R2.list({
            ...options,
            cursor: listed.cursor,
        });
        allObjects = allObjects.concat(listed.objects);
    }

    const userBlobs = allObjects
        .filter(obj => obj.customMetadata && obj.customMetadata.pubkey === pubkey)
        .map(obj => ({
            url: `/${obj.key}`, // Standard Blossom List doesn't specify absolute URL, but usually it's just descriptor
            sha256: obj.key,
            size: obj.size,
            type: obj.customMetadata?.type || 'application/octet-stream',
            uploaded: Math.floor(obj.uploaded.getTime() / 1000)
        }));

    return new Response(JSON.stringify(userBlobs), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

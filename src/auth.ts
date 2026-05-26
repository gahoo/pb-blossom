import { verifyEvent } from 'nostr-tools/pure';
import { Env } from './index';

export async function verifyAuth(request: Request, env: Env): Promise<{ authorized: boolean; pubkey?: string; expectedHash?: string; error?: string; status?: number; event?: any }> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Nostr ')) {
        return { authorized: false, error: 'Missing or invalid Authorization header', status: 401 };
    }

    const base64Event = authHeader.substring(6);
    let event;
    try {
        const jsonEvent = atob(base64Event);
        event = JSON.parse(jsonEvent);
    } catch (e) {
        return { authorized: false, error: 'Invalid base64 encoded JSON event', status: 400 };
    }

    if (event.kind !== 24242) {
        return { authorized: false, error: 'Event kind must be 24242', status: 400 };
    }

    try {
        if (!verifyEvent(event)) {
             return { authorized: false, error: 'Invalid Nostr signature', status: 401 };
        }
    } catch (e) {
        return { authorized: false, error: 'Error verifying Nostr signature', status: 401 };
    }

    let tTag = null;
    let xTag = null;
    let serverTag = null;

    for (const tag of event.tags) {
        if (tag[0] === 't') {
            tTag = tag[1];
        } else if (tag[0] === 'x') {
            xTag = tag[1];
        } else if (tag[0] === 'server') {
            serverTag = tag[1];
        }
    }

    const requestUrl = new URL(request.url);
    if (serverTag && serverTag !== requestUrl.hostname) {
        return {
            authorized: false,
            error: `Token target mismatch: token issued for '${serverTag}', but target is '${requestUrl.hostname}'`,
            status: 403
        };
    }

    if (request.method === 'PUT' && tTag !== 'upload') {
        return { authorized: false, error: 'Missing or invalid "t" tag, must be "upload" for PUT requests', status: 400 };
    }

    if (request.method === 'DELETE' && tTag !== 'delete') {
         return { authorized: false, error: 'Missing or invalid "t" tag, must be "delete" for DELETE requests', status: 400 };
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    // BUD-11 might not specify exact time frame, but 10 minutes (600s) is a good standard for short-lived auth tokens
    if (Math.abs(now - event.created_at) > 600) {
         return { authorized: false, error: 'Auth event expired or too far in the future', status: 401 };
    }

    const pubkey = event.pubkey;

    if (env.REQUIRE_WHITELIST === 'true' && env.WHITELIST_KV) {
        const isWhitelisted = await env.WHITELIST_KV.get(pubkey);
        if (!isWhitelisted) {
            return { authorized: false, error: 'Pubkey not in whitelist', status: 403 };
        }
    }

    return { authorized: true, pubkey: pubkey, expectedHash: xTag || undefined, event };
}

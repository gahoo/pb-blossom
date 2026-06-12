import { verifyEvent } from 'nostr-tools/pure';
import { Env } from './index';

/**
 * Decodes a Base64 or Base64url (URL-safe, no-padding) encoded string.
 *
 * BUD-11 requires clients to send the auth event encoded as Base64url without
 * padding (as used by JWTs). However, some clients may still send standard
 * Base64. This function handles both formats.
 */
function base64Decode(encoded: string): string {
    // Convert Base64url to standard Base64 if needed
    const standard = encoded
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .replace(/\s/g, '');
    // Add back padding if stripped
    const padded = standard + '=='.slice(0, (4 - (standard.length % 4)) % 4);
    return atob(padded);
}

export async function verifyAuth(request: Request, env: Env): Promise<{ authorized: boolean; pubkey?: string; expectedHash?: string; error?: string; status?: number; event?: any }> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Nostr ')) {
        return { authorized: false, error: 'Missing or invalid Authorization header', status: 401 };
    }

    const encodedEvent = authHeader.substring(6);
    let event;
    try {
        const jsonEvent = base64Decode(encodedEvent);
        event = JSON.parse(jsonEvent);
    } catch (e) {
        return { authorized: false, error: 'Invalid Base64/Base64url encoded JSON event', status: 400 };
    }

    if (event.kind !== 24242) {
        return { authorized: false, error: 'Event kind must be 24242 (BUD-11)', status: 400 };
    }

    try {
        if (!verifyEvent(event)) {
             return { authorized: false, error: 'Invalid Nostr signature', status: 401 };
        }
    } catch (e) {
        return { authorized: false, error: 'Error verifying Nostr signature', status: 401 };
    }

    let tTag: string | null = null;
    let xTag: string | null = null;
    let serverTag: string | null = null;
    let expirationTag: string | null = null;

    for (const tag of event.tags) {
        if (tag[0] === 't') {
            tTag = tag[1];
        } else if (tag[0] === 'x') {
            xTag = tag[1];
        } else if (tag[0] === 'server') {
            serverTag = tag[1];
        } else if (tag[0] === 'expiration') {
            expirationTag = tag[1];
        }
    }

    // BUD-11: Validate the 'expiration' tag (NIP-40)
    // This is the primary validity mechanism — NOT the created_at window.
    const now = Math.floor(Date.now() / 1000);
    if (expirationTag) {
        const expiration = parseInt(expirationTag, 10);
        if (isNaN(expiration)) {
            return { authorized: false, error: 'Invalid expiration tag value', status: 400 };
        }
        if (now > expiration) {
            return { authorized: false, error: 'Auth token has expired (expiration tag)', status: 401 };
        }
    } else {
        // BUD-11 REQUIRES the expiration tag for upload and delete actions.
        // For other actions (get, list) we allow missing expiration as a fallback,
        // but enforce a reasonable created_at window.
        if (request.method === 'PUT' || request.method === 'DELETE') {
            return { authorized: false, error: 'Missing required "expiration" tag (BUD-11)', status: 400 };
        }
    }

    // Clock skew protection: reject events created more than 5 minutes in the future.
    // We do NOT enforce a minimum age — the expiration tag handles that.
    if (event.created_at > now + 300) {
        return { authorized: false, error: 'Auth event created_at is too far in the future (max 5 minutes)', status: 401 };
    }

    // For methods without expiration tag, apply a fallback 10-minute window on created_at
    if (!expirationTag && Math.abs(now - event.created_at) > 600) {
        return { authorized: false, error: 'Auth event expired or too far in the past (no expiration tag)', status: 401 };
    }

    // Validate the 'server' tag if present — must match this server's hostname
    const requestUrl = new URL(request.url);
    if (serverTag && serverTag.toLowerCase() !== requestUrl.hostname.toLowerCase()) {
        return {
            authorized: false,
            error: `Token target mismatch: token issued for '${serverTag}', but target is '${requestUrl.hostname}'`,
            status: 403
        };
    }

    // Validate the 't' (action) tag matches the HTTP method
    if (request.method === 'PUT' && tTag !== 'upload') {
        return { authorized: false, error: 'Missing or invalid "t" tag, must be "upload" for PUT requests', status: 400 };
    }

    if (request.method === 'DELETE' && tTag !== 'delete') {
         return { authorized: false, error: 'Missing or invalid "t" tag, must be "delete" for DELETE requests', status: 400 };
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

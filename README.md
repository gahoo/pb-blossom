# Blossom Server on Cloudflare Workers

A lightweight, serverless implementation of a Blossom (Blobs stored simply on mediaservers) media server. Built with Cloudflare Workers, R2 object storage, and KV for blazingly fast, distributed, and cost-effective file hosting using Nostr for authentication.

## Features

- **Serverless & Edge-Optimized**: Powered by Cloudflare Workers for global low-latency responses.
- **Object Storage**: Leverages Cloudflare R2 for reliable and scalable file storage.
- **Nostr Authentication**: Uses Nostr events (Kind `24242`) for robust authorization (BUD-11 / NIP-98).
- **Content-Addressable Storage**: Files are addressed by their SHA-256 hashes to guarantee data integrity.
- **Expiration & Cleanup**: Built-in support for short-lived blobs (`X-Expire-Days`) with an automated cron job that sweeps expired files daily to save space.
- **Whitelist Access**: Optional Cloudflare KV-backed whitelist to restrict uploads and management to authorized pubkeys only.

## Supported Protocols

This server implements the following Blossom Upgrade Documents (BUDs):

- **BUD-01**: Server requirements and blob retrieval (`GET /<sha256>`, `HEAD /<sha256>`)
- **BUD-02**: Blob upload (`PUT /upload`)
- **BUD-06**: Upload requirements
- **BUD-11**: Nostr Authorization (Event Kind `24242`)
- **BUD-12**: Blob management endpoints (`DELETE /<sha256>`, `GET /list/<pubkey>`)

*(Also supports NIP-98 HTTP Auth style verification).*

## Prerequisites

Before deploying, ensure you have the following ready:
- A Cloudflare account
- Node.js installed on your machine
- Wrangler CLI installed (`npm install -g wrangler`)
- Logged into Cloudflare via Wrangler (`wrangler login`)

## Deployment Guide

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/gahoo/pb-blossom.git
cd pb-blossom
npm install
```

### 2. Set Up Cloudflare R2 Bucket

You need an R2 bucket to store the blobs. Create it using Wrangler or the Cloudflare Dashboard:

```bash
wrangler r2 bucket create blossom-bucket
```

Update your `wrangler.toml` to link the R2 bucket. Change the `bucket_name` to the one you just created:

```toml
[[r2_buckets]]
binding = "R2"
bucket_name = "blossom-bucket" # <-- Change this
```

### 3. Set Up Cloudflare KV Namespace (For Whitelist)

The server supports a whitelist to restrict who can upload files. Create a KV namespace for this:

```bash
wrangler kv:namespace create "WHITELIST_KV"
```

Wrangler will output the configuration block for your `wrangler.toml`. Copy the `id` and update your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "WHITELIST_KV"
id = "<your-generated-kv-id>" # <-- Change this
```

### 4. Configuration

In your `wrangler.toml`, you can toggle the whitelist requirement:

```toml
[vars]
# Set to "false" to allow public uploads, or "true" to require a whitelisted pubkey
REQUIRE_WHITELIST = "true"
```

#### Managing the Whitelist
If `REQUIRE_WHITELIST = "true"`, users must be whitelisted to upload or delete files. You can add a Nostr pubkey (hex format) to the KV namespace using Wrangler:

```bash
wrangler kv key put --namespace-id=WHITELIST_KV "<user-hex-pubkey>" "true"
```

### 5. Deploy to Cloudflare

Once configured, deploy the worker to Cloudflare:

```bash
npm run deploy
# or manually via wrangler
wrangler deploy
```

Wrangler will output your assigned worker URL (e.g., `https://blossom-server.<your-subdomain>.workers.dev`). You can now use this URL as your Blossom server in compatible Nostr clients!


## API Usage Examples

The following examples show how to interact with the Blossom server using `curl`.

### Understanding Nostr Authorization (`Kind 24242`)

When uploading or deleting a file, Blossom requires the user's Nostr identity (their public key) to be verified via a cryptographic signature. This is done by passing a Base64-encoded Nostr Event in the `Authorization` header.

**Why the file hash is required for uploads:**
To ensure data integrity, the SHA-256 hash of the file you are uploading **must** be embedded inside this signed event using an `x` tag. The server will reject the upload if the actual file's hash does not match the hash you signed.

A valid `Kind 24242` JSON event for an upload looks like this before Base64 encoding:

```json
{
  "kind": 24242,
  "created_at": 1716700000,
  "pubkey": "<your-hex-pubkey>", // This is the identity checked against the whitelist
  "content": "Upload Authorization",
  "tags": [
    ["t", "upload"], // The action being authorized
    ["x", "<sha256-hash-of-the-file>"], // MUST match the file being uploaded
    ["server", "blossom-server.<your-subdomain>.workers.dev"] // Optional, prevents replay attacks
  ],
  "id": "<event-id>",
  "sig": "<your-private-key-signature>"
}
```

Once this JSON is created and signed by your Nostr client, it is Base64 encoded and passed to the server: `Authorization: Nostr <base64-string>`.


### 1. Upload a Blob
Upload a file. This requires an authorization token where the `t` tag is set to `upload` and an `x` tag containing the expected SHA-256 hash of the file.

```bash
curl -X PUT https://blossom-server.<your-subdomain>.workers.dev/upload \
  -H "Authorization: Nostr <base64-encoded-kind-24242-event>" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@my-image.jpg"
```

### 2. Retrieve a Blob
Retrieve a file by its SHA-256 hash. This endpoint is public.

```bash
curl -O https://blossom-server.<your-subdomain>.workers.dev/<sha256-hash>
```

### 3. List User's Blobs
List all blobs uploaded by a specific Nostr pubkey. This endpoint is public.

```bash
curl https://blossom-server.<your-subdomain>.workers.dev/list/<user-hex-pubkey>
```

### 4. Delete a Blob
Delete a file by its SHA-256 hash. This requires an authorization token where the `t` tag is set to `delete`. You can only delete blobs that you own.

```bash
curl -X DELETE https://blossom-server.<your-subdomain>.workers.dev/<sha256-hash> \
  -H "Authorization: Nostr <base64-encoded-kind-24242-event>"
```

## Development

To run a local development server:

```bash
npm run dev
```

## Automated Cleanup
The server comes pre-configured with a Cloudflare Cron Trigger in `wrangler.toml`:
```toml
[triggers]
crons = ["0 3 * * *"] # Runs every day at 3 AM
```
This automatically invokes the `scheduled` handler to scan your R2 bucket and delete any blobs that have exceeded their requested expiration time, keeping your storage costs low!

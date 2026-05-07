import { Env } from './index';

export async function handleScheduled(env: Env): Promise<void> {
    console.log("Starting cron sweep for expired blobs...");
    let cursor: string | undefined = undefined;
    let deletedCount = 0;

    while (true) {
        const listResult: R2Objects = await env.R2.list({
            limit: 1000,
            cursor: cursor,
            include: ['customMetadata', 'httpMetadata']
        } as R2ListOptions);

        const now = Math.floor(Date.now() / 1000);
        const keysToDelete: string[] = [];

        for (const obj of listResult.objects) {
            if (obj.customMetadata && obj.customMetadata.expireAt) {
                const expireAt = parseInt(obj.customMetadata.expireAt, 10);
                if (expireAt < now) {
                    keysToDelete.push(obj.key);
                }
            }
        }

        if (keysToDelete.length > 0) {
            await env.R2.delete(keysToDelete);
            deletedCount += keysToDelete.length;
            console.log(`Deleted ${keysToDelete.length} expired blobs in this batch.`);
        }

        if (!listResult.truncated) {
            break;
        }
        cursor = listResult.cursor;
    }

    console.log(`Cron sweep finished. Total deleted: ${deletedCount}`);
}

/**
 * Entry point. `pnpm --filter @avo/api run dev`
 */

import { buildApp } from './app';
import { env } from './env';

const app = await buildApp();

await app.listen({ port: env.port, host: '0.0.0.0' });
app.log.info(`AVO API on http://localhost:${env.port}`);

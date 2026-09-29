import { registerRootComponent } from 'expo';

import Boot from './Boot';

// BOOT, NOT APP. `Boot` resolves the cached salon identity — hex and name —
// before it imports `App`, so the PIN screen's first frame is already the salon's
// and no stylesheet is built twice. See Boot.tsx and src/theme/live.ts.
registerRootComponent(Boot);

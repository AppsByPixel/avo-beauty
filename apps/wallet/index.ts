import { registerRootComponent } from 'expo';

import Boot from './Boot';

// registerRootComponent calls AppRegistry.registerComponent('main', () => Boot);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
//
// BOOT, NOT APP. `Boot` resolves the salon's cached brand hex and writes it onto
// the palette before it imports `App`, so the first frame is already in the
// salon's colour and no stylesheet is built twice. See Boot.tsx and
// src/theme/live.ts.
registerRootComponent(Boot);

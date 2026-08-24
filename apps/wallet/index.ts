import { registerRootComponent } from 'expo';

import Boot from './Boot';

// registerRootComponent calls AppRegistry.registerComponent('main', () => Boot);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
//
// BOOT, NOT APP, and the indirection is not optional. `Boot` resolves the salon's
// brand hex and writes it onto the palette before it imports `App`, because a
// React Native stylesheet copies a colour when its module is evaluated and never
// re-reads it. Registering `App` here would evaluate every screen's stylesheet
// with the default sage and no salon could ever be re-branded. See Boot.tsx and
// src/theme/sealed.ts.
registerRootComponent(Boot);

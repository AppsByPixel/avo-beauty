import { registerRootComponent } from 'expo';

import Boot from './Boot';

// BOOT, NOT APP, and the indirection is not optional. `Boot` resolves the salon's
// brand hex and name before it imports `App`, because a React Native stylesheet
// copies a colour when its module is evaluated and never re-reads it. Registering
// `App` here would evaluate every screen's stylesheet with the default sage and no
// salon could ever be re-branded. See Boot.tsx and src/theme/sealed.ts.
registerRootComponent(Boot);

// Metro, configured for the pnpm workspace.
//
// @avo/types and @avo/tokens live outside this app's directory and are symlinked
// in by pnpm, so Metro has to watch the workspace root and know where to find
// the root node_modules. Hierarchical lookup stays ON: pnpm's isolated layout
// puts a package's own dependencies (zod, inside @avo/types) next to it rather
// than at the root, and disabling the walk-up breaks that.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;

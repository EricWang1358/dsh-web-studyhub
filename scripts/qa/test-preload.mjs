/* Test workers enforce the network boundary. Real programs spawned by a test may opt into only the source loader. */
import './test-network.mjs';
export { cacheLocalImports } from './test-module-loader.mjs';

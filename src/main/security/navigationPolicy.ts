/**
 * Main-process view of the navigation URL policy.
 *
 * The policy itself lives in `shared/navigationPolicy` (#1359) because the MCP
 * server runs the same check on the lanes that never reach a main RPC handler.
 * This module stays as the import path main already uses.
 */
export {
  DNS_LOOKUP_TIMEOUT_MS,
  validateResolvedNavigationUrl,
} from '../../shared/navigationPolicy';

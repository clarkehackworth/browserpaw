import { initNativeHostListener } from './native-host';
import { initWatchdogs } from './watchdogs';
import { initUrlPolicy } from './url-policy';

/**
 * Background script entry point
 * Initializes core native messaging bridge listener and watchdog cluster
 */
export default defineBackground(() => {
  // Initialize core services
  initNativeHostListener();
  initWatchdogs();
  void initUrlPolicy().catch((e) => console.error('[url-policy] init failed', e));
});

/**
 * Names of what the app keeps on this device, in a module with no dependencies: sign-out
 * (loaded on every page) must find them without pulling in Yjs and the board code.
 */

/** Prefix of the IndexedDB databases holding offline copies of boards. */
export const LOCAL_CACHE_PREFIX = "whiteboard:board:";

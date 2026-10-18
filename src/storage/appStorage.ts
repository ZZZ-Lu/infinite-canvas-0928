/**
 * AppStorage provides a unified key-value storage wrapper for synchronous UI settings
 * and app state, with localStorage persistence and memory fallback.
 */

class AppStorage {
  private memoryMap = new Map<string, string>();

  constructor() {
    this.initFromLocalStorage();
  }

  private initFromLocalStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          const val = localStorage.getItem(key);
          if (val !== null) {
            this.memoryMap.set(key, val);
          }
        }
      }
    } catch (e) {
      console.warn('[appStorage] Could not initialize from localStorage:', e);
    }
  }

  getItem(key: string): string | null {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const val = localStorage.getItem(key);
        if (val !== null) {
          this.memoryMap.set(key, val);
          return val;
        }
      } catch {
        // Fall back to memoryMap
      }
    }
    return this.memoryMap.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.memoryMap.set(key, value);
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.setItem(key, value);
      } catch (e) {
        console.warn(`[appStorage] Failed to setItem for ${key}:`, e);
      }
    }
  }

  removeItem(key: string): void {
    this.memoryMap.delete(key);
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        console.warn(`[appStorage] Failed to removeItem for ${key}:`, e);
      }
    }
  }

  clear(): void {
    this.memoryMap.clear();
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.clear();
      } catch (e) {
        console.warn('[appStorage] Failed to clear localStorage:', e);
      }
    }
  }
}

export const appStorage = new AppStorage();

export function flushAppStorage(): void {
  // Sync memory cache state if needed
}

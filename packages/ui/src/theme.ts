export type ThemeMode = "auto" | "light" | "dark";

export const THEME_STORAGE_KEY = "camelthorn.theme";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "auto" || value === "light" || value === "dark";
}

/** Auto removes data-theme so the prefers-color-scheme rule applies. */
export function applyTheme(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredTheme(storage: Storage | undefined = defaultStorage()): ThemeMode {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeMode(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Returns false when storage is unavailable (private mode, quota). */
export function storeTheme(
  mode: ThemeMode,
  storage: Storage | undefined = defaultStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

// Apply the stored theme before first paint. Same key as @camelthorn/ui THEME_STORAGE_KEY.
// Auto (or anything unknown, or blocked storage) leaves data-theme unset.
// Loaded synchronously from <head> so the CSP can stay at script-src 'self' (no inline script).
try {
  var t = localStorage.getItem("camelthorn.theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch {
  // Storage blocked: keep Auto.
}

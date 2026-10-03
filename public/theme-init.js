// Apply persisted display preferences before first paint. [data-theme] always
// carries the resolved theme: "system" (or an unset theme) is resolved from
// prefers-color-scheme here, and src/lib/theme.ts keeps it in step with the
// OS afterwards. An unset language follows the browser's first preferred
// language (zh* -> zh-CN, else en), the same rule as defaultLanguage() in
// src/lib/i18n.tsx.
// Lives as an external file (not inline) so the CSP can stay 'self'-only.
(function () {
  var root = document.documentElement;
  var t = null;
  try {
    var language = localStorage.getItem("memo:language");
    if (language !== "zh-CN" && language !== "en") {
      var preferred = (navigator.languages && navigator.languages[0]) || navigator.language || "";
      language = preferred.toLowerCase().indexOf("zh") === 0 ? "zh-CN" : "en";
    }
    root.lang = language;
    t = localStorage.getItem("memo:theme");
  } catch (e) {}

  if (t === "light" || t === "dark") {
    root.setAttribute("data-theme", t);
    // An explicit choice paints both media-qualified theme-colors; "system"
    // leaves the pair alone so the browser chrome follows the OS.
    var color = t === "dark" ? "#0c0e13" : "#f3f4f7";
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) {
      metas[i].setAttribute("content", color);
    }
  } else {
    var dark = false;
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {}
    root.setAttribute("data-theme", dark ? "dark" : "light");
  }
})();

// Apply persisted display preferences before first paint. "system" (or an
// unset theme) falls through to prefers-color-scheme; language defaults to
// English until the user explicitly selects Simplified Chinese.
// Lives as an external file (not inline) so the CSP can stay 'self'-only.
(function () {
  try {
    var language = localStorage.getItem("memo:language");
    document.documentElement.lang = language === "zh-CN" ? "zh-CN" : "en";

    var t = localStorage.getItem("memo:theme");
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
      var color = t === "dark" ? "#0c0e13" : "#f3f4f7";
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i += 1) {
        metas[i].setAttribute("content", color);
      }
    }
  } catch (e) {}
})();

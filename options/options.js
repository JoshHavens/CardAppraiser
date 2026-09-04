(function () {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;

  const DEFAULTS = {
    engine: "photo",
    apiKey: "",
    model: "claude-haiku-4-5",
    pollInterval: 1000,
    highlightGrade: "Ungraded",
    diffThreshold: 12,
    debug: false,
  };

  const $ = (id) => document.getElementById(id);

  function toggleVision() {
    $("vision-fields").style.opacity = $("engine").value === "vision" ? "1" : "0.5";
  }

  async function load() {
    const s = await api.storage.local.get(DEFAULTS);
    $("engine").value = s.engine;
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("pollInterval").value = s.pollInterval;
    $("diffThreshold").value = s.diffThreshold;
    $("highlightGrade").value = s.highlightGrade;
    $("debug").checked = !!s.debug;
    toggleVision();
  }

  async function save() {
    const s = {
      engine: $("engine").value,
      apiKey: $("apiKey").value.trim(),
      model: $("model").value,
      pollInterval: Math.max(300, parseInt($("pollInterval").value, 10) || 1000),
      diffThreshold: Math.max(2, parseInt($("diffThreshold").value, 10) || 12),
      highlightGrade: $("highlightGrade").value,
      debug: $("debug").checked,
    };
    await api.storage.local.set(s);
    const saved = $("saved");
    saved.textContent = "Saved. Reload the Whatnot tab to apply.";
    setTimeout(() => (saved.textContent = ""), 4000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    load();
    $("engine").addEventListener("change", toggleVision);
    $("save").addEventListener("click", save);
  });
})();

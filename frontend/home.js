const entry = document.querySelector(".home-entry");

entry?.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (entry.dataset.leaving === "true") return;
  entry.dataset.leaving = "true";
  sessionStorage.setItem("latsoal-enter-transition", "true");
  window.setTimeout(() => {
    window.location.assign(entry.href);
  }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 520);
});

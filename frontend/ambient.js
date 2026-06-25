(() => {
  if (document.querySelector(".ambient-motion-field")) return;

  const field = document.createElement("div");
  field.className = "ambient-motion-field";
  field.setAttribute("aria-hidden", "true");

  const orbitConfig = [
    {name: "inner", planetSize: "7px", glowSize: "12px", duration: "24s", direction: "normal"},
    {name: "middle", planetSize: "13px", glowSize: "20px", duration: "36s", direction: "reverse"},
    {
      name: "outer",
      planetSize: "22px",
      glowSize: "32px",
      duration: "54s",
      direction: "normal",
      moon: true,
      moonOrbitSize: "48px",
      moonSize: "5px",
    },
  ];

  for (const config of orbitConfig) {
    const orbit = document.createElement("span");
    orbit.className = `ambient-orbit ambient-orbit--${config.name}`;
    orbit.style.setProperty("--planet-size", config.planetSize);
    orbit.style.setProperty("--planet-glow", config.glowSize);
    orbit.style.setProperty("--orbit-duration", config.duration);
    orbit.style.setProperty("--orbit-direction", config.direction);

    const planet = document.createElement("span");
    planet.className = "ambient-planet";
    orbit.append(planet);

    if (config.moon) {
      orbit.style.setProperty("--moon-orbit-size", config.moonOrbitSize);
      orbit.style.setProperty("--moon-size", config.moonSize);
      const moonOrbit = document.createElement("span");
      moonOrbit.className = "ambient-moon-orbit";
      const moon = document.createElement("span");
      moon.className = "ambient-moon";
      moonOrbit.append(moon);
      planet.append(moonOrbit);
    }

    field.append(orbit);
  }

  for (const name of ["one", "two"]) {
    const line = document.createElement("span");
    line.className = `ambient-moving-line ambient-moving-line--${name}`;
    field.append(line);
  }

  const glyphConfig = [
    {name: "one", symbol: "∑", depth: 7},
    {name: "two", symbol: "π", depth: 11},
    {name: "three", symbol: "A", depth: 8},
    {name: "four", symbol: "√", depth: 14},
    {name: "five", symbol: "?", depth: 10},
  ];

  const glyphSymbols = {
    one: "\u2211",
    two: "\u03c0",
    three: "A",
    four: "\u221a",
    five: "?",
  };

  const glyphs = glyphConfig.map((config) => {
    const glyph = document.createElement("span");
    glyph.className = `ambient-glyph ambient-glyph--${config.name}`;
    glyph.dataset.depth = String(config.depth);

    const visual = document.createElement("span");
    visual.className = "ambient-glyph__visual";
    visual.textContent = glyphSymbols[config.name] || config.symbol;
    glyph.append(visual);
    field.append(glyph);
    return glyph;
  });

  document.body.prepend(field);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const precisePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const activeAnimations = new Set();
  let pointerFrame = 0;
  let motionEnabled = false;

  const randomBetween = (min, max) => min + Math.random() * (max - min);

  function animateGlyph(glyph, current = {x: 0, y: 0, rotation: 0, opacity: 0.5}) {
    if (!motionEnabled) return;
    if (typeof glyph.animate !== "function") {
      field.classList.add("ambient-motion-fallback");
      return;
    }

    const mobile = window.innerWidth <= 640;
    const range = mobile ? 34 : 72;
    const next = {
      x: randomBetween(-range, range),
      y: randomBetween(-range * 0.8, range * 0.8),
      rotation: randomBetween(-8, 8),
      opacity: randomBetween(0.42, 0.68),
    };

    const animation = glyph.animate([
      {
        transform: `translate3d(${current.x}px, ${current.y}px, 0) rotate(${current.rotation}deg)`,
        opacity: current.opacity,
      },
      {
        transform: `translate3d(${next.x}px, ${next.y}px, 0) rotate(${next.rotation}deg)`,
        opacity: next.opacity,
      },
    ], {
      duration: randomBetween(12000, 21000),
      easing: "cubic-bezier(.16, 1, .3, 1)",
      fill: "forwards",
    });

    activeAnimations.add(animation);
    if (document.hidden) animation.pause();

    animation.finished
      .then(() => {
        activeAnimations.delete(animation);
        animation.cancel();
        animateGlyph(glyph, next);
      })
      .catch(() => activeAnimations.delete(animation));
  }

  function applyParallax(event) {
    if (!motionEnabled || !precisePointer.matches) return;
    const x = (event.clientX / window.innerWidth - 0.5) * 2;
    const y = (event.clientY / window.innerHeight - 0.5) * 2;

    cancelAnimationFrame(pointerFrame);
    pointerFrame = requestAnimationFrame(() => {
      for (const glyph of glyphs) {
        const depth = Number(glyph.dataset.depth || 0);
        const visual = glyph.firstElementChild;
        visual.style.setProperty("--parallax-x", `${x * depth}px`);
        visual.style.setProperty("--parallax-y", `${y * depth}px`);
      }
    });
  }

  function resetParallax() {
    cancelAnimationFrame(pointerFrame);
    pointerFrame = requestAnimationFrame(() => {
      for (const glyph of glyphs) {
        const visual = glyph.firstElementChild;
        visual.style.setProperty("--parallax-x", "0px");
        visual.style.setProperty("--parallax-y", "0px");
      }
    });
  }

  function startMotion() {
    if (motionEnabled || reducedMotion.matches) return;
    motionEnabled = true;
    glyphs.forEach((glyph, index) => {
      window.setTimeout(() => animateGlyph(glyph), index * 260);
    });
    if (precisePointer.matches) {
      window.addEventListener("pointermove", applyParallax, {passive: true});
      document.documentElement.addEventListener("pointerleave", resetParallax);
    }
  }

  function stopMotion() {
    motionEnabled = false;
    for (const animation of activeAnimations) animation.cancel();
    activeAnimations.clear();
    window.removeEventListener("pointermove", applyParallax);
    document.documentElement.removeEventListener("pointerleave", resetParallax);
    for (const glyph of glyphs) glyph.removeAttribute("style");
    resetParallax();
  }

  function syncMotionPreference() {
    if (reducedMotion.matches) stopMotion();
    else startMotion();
  }

  function syncVisibility() {
    document.documentElement.classList.toggle("ambient-motion-paused", document.hidden);
    for (const animation of activeAnimations) {
      if (document.hidden) animation.pause();
      else animation.play();
    }
  }

  document.addEventListener("visibilitychange", syncVisibility);
  reducedMotion.addEventListener?.("change", syncMotionPreference);
  precisePointer.addEventListener?.("change", () => {
    stopMotion();
    startMotion();
  });
  syncVisibility();
  syncMotionPreference();
})();

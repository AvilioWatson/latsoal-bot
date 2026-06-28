(() => {
  if (document.querySelector(".ambient-motion-field")) return;

  const field = document.createElement("div");
  field.className = "ambient-motion-field";
  field.setAttribute("aria-hidden", "true");

  const orbitConfig = [
    {name: "inner", planetSize: "7px", glowSize: "12px", duration: "24s", direction: "normal"},
    {name: "middle", planetSize: "13px", glowSize: "20px", duration: "36s", direction: "normal"},
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

  const cometCount = window.innerWidth <= 640 ? 2 : 4;
  const comets = Array.from({length: cometCount}, (_, index) => {
    const comet = document.createElement("span");
    comet.className = "ambient-comet";
    comet.dataset.speed = String(0.92 + index * 0.12);

    const core = document.createElement("span");
    core.className = "ambient-comet__core";
    comet.append(core);
    field.append(comet);

    const trail = Array.from({length: window.innerWidth <= 640 ? 28 : 44}, () => {
      const particle = document.createElement("span");
      particle.className = "ambient-comet-trail";
      field.append(particle);
      return particle;
    });
    return {comet, trail};
  });

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
  let cometFrame = 0;
  let lastCometTime = 0;
  let motionEnabled = false;
  const COMET_GRAVITY = 2600000;
  const COMET_MIN_DISTANCE = 36;
  const COMET_TRAIL_GAP = 7;

  const randomBetween = (min, max) => min + Math.random() * (max - min);

  function randomEdgePoint(width, height, margin) {
    const edge = Math.floor(Math.random() * 4);
    if (edge === 0) return {x: randomBetween(-margin, width + margin), y: -margin};
    if (edge === 1) return {x: width + margin, y: randomBetween(-margin, height + margin)};
    if (edge === 2) return {x: randomBetween(-margin, width + margin), y: height + margin};
    return {x: -margin, y: randomBetween(-margin, height + margin)};
  }

  function resetComet(cometState, delay = 0) {
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const margin = Math.max(width, height) * 0.22 + 120;
    const start = randomEdgePoint(width, height, margin);
    const centerWindow = Math.min(width, height) * 0.18;
    const target = {
      x: width / 2 + randomBetween(-centerWindow, centerWindow),
      y: height / 2 + randomBetween(-centerWindow, centerWindow),
    };

    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const speed = randomBetween(330, 520) * Number(cometState.comet.dataset.speed || 1);
    const tangent = randomBetween(-210, 210);
    cometState.motion = {
      x: start.x,
      y: start.y,
      vx: (dx / distance) * speed + (-dy / distance) * tangent,
      vy: (dy / distance) * speed + (dx / distance) * tangent,
      pull: randomBetween(1.05, 1.45),
      speedLimit: randomBetween(1150, 1520),
      opacity: 0,
      delay,
      age: 0,
      hasEntered: false,
      trail: [],
    };
    cometState.comet.style.opacity = "0";
    for (const particle of cometState.trail) particle.style.opacity = "0";
  }

  function animateComets(timestamp = 0) {
    if (!motionEnabled) return;
    const dt = Math.min(0.04, Math.max(0.001, (timestamp - lastCometTime) / 1000 || 0.016));
    lastCometTime = timestamp;
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const centerX = width / 2;
    const centerY = height / 2;
    const margin = Math.max(width, height) * 0.24 + 120;

    for (const cometState of comets) {
      if (!cometState.motion) resetComet(cometState, randomBetween(0, 1.6));
      const state = cometState.motion;
      if (state.delay > 0) {
        state.delay -= dt;
        cometState.comet.style.opacity = "0";
        for (const particle of cometState.trail) particle.style.opacity = "0";
        continue;
      }

      const dx = centerX - state.x;
      const dy = centerY - state.y;
      const distanceSquared = Math.max(COMET_MIN_DISTANCE ** 2, dx * dx + dy * dy);
      const distance = Math.sqrt(distanceSquared);
      const acceleration = (COMET_GRAVITY / distanceSquared) * state.pull;
      state.vx += (dx / distance) * acceleration * dt;
      state.vy += (dy / distance) * acceleration * dt;
      const speed = Math.hypot(state.vx, state.vy);
      if (speed > state.speedLimit) {
        state.vx = (state.vx / speed) * state.speedLimit;
        state.vy = (state.vy / speed) * state.speedLimit;
      }
      const previous = {x: state.x, y: state.y};
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      state.age += dt;
      state.opacity = Math.min(0.72, state.opacity + dt * 0.85);
      if (state.x > -24 && state.x < width + 24 && state.y > -24 && state.y < height + 24) state.hasEntered = true;
      const gap = Math.hypot(state.x - previous.x, state.y - previous.y);
      const steps = Math.max(1, Math.ceil(gap / COMET_TRAIL_GAP));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        state.trail.push({
          x: previous.x + (state.x - previous.x) * t,
          y: previous.y + (state.y - previous.y) * t,
        });
      }
      const maxTrail = cometState.trail.length * 3;
      if (state.trail.length > maxTrail) state.trail.splice(0, state.trail.length - maxTrail);

      const angle = Math.atan2(state.vy, state.vx) * 180 / Math.PI;
      cometState.comet.style.opacity = String(state.opacity);
      cometState.comet.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) rotate(${angle}deg)`;

      const trailLength = state.trail.length;
      cometState.trail.forEach((particle, index) => {
        if (trailLength < 2) {
          particle.style.opacity = "0";
          return;
        }
        const frac = index / Math.max(cometState.trail.length - 1, 1);
        const sampleIndex = Math.max(0, Math.floor(frac * (trailLength - 1)));
        const point = state.trail[sampleIndex];
        const alpha = Math.min(0.68, state.opacity * frac ** 0.5);
        const size = Math.max(0.7, 7.4 * frac ** 0.38);
        particle.style.opacity = String(alpha);
        particle.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%) scale(${size / 4})`;
      });

      if (
        state.age > 8 ||
        (state.hasEntered && (
          state.x < -margin ||
          state.x > width + margin ||
          state.y < -margin ||
          state.y > height + margin
        ))
      ) {
        resetComet(cometState, randomBetween(0.18, 1.1));
      }
    }

    cometFrame = requestAnimationFrame(animateComets);
  }

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
    lastCometTime = performance.now();
    comets.forEach((comet, index) => resetComet(comet, index * 0.38));
    cometFrame = requestAnimationFrame(animateComets);
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
    cancelAnimationFrame(cometFrame);
    for (const animation of activeAnimations) animation.cancel();
    activeAnimations.clear();
    window.removeEventListener("pointermove", applyParallax);
    document.documentElement.removeEventListener("pointerleave", resetParallax);
    for (const cometState of comets) {
      cometState.comet.removeAttribute("style");
      cometState.motion = null;
      for (const particle of cometState.trail) particle.removeAttribute("style");
    }
    for (const glyph of glyphs) glyph.removeAttribute("style");
    resetParallax();
  }

  function syncMotionPreference() {
    if (reducedMotion.matches) stopMotion();
    else startMotion();
  }

  function syncVisibility() {
    document.documentElement.classList.toggle("ambient-motion-paused", document.hidden);
    cancelAnimationFrame(cometFrame);
    if (!document.hidden && motionEnabled) {
      lastCometTime = performance.now();
      cometFrame = requestAnimationFrame(animateComets);
    }
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

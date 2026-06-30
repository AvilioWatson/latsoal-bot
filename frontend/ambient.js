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

  const cometCanvas = document.createElement("canvas");
  cometCanvas.className = "ambient-comet-canvas";
  field.append(cometCanvas);
  const cometContext = cometCanvas.getContext("2d", {alpha: true});

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
  const COMET_FIXED_STEP = 1000 / 60;
  const COMET_TIME_SCALE = 4;
  const COMET_TRAIL_LIMIT = 280;
  const COMET_DISSOLVE_RATE = 7;
  const COMET_ABSORB_RADIUS = 15;
  const cometState = {
    active: false,
    cooldown: 0,
    trail: [],
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    spawnR: 0,
    dissolveCarry: 0,
  };

  const randomBetween = (min, max) => min + Math.random() * (max - min);

  function cometGravity() {
    return Math.max(62000, Math.min(window.innerWidth || 1, window.innerHeight || 1) * 135);
  }

  function solarCenter(width = window.innerWidth || 1, height = window.innerHeight || 1) {
    return {
      x: width / 2,
      y: height / 2,
    };
  }

  function outerScreenRadius(width = window.innerWidth || 1, height = window.innerHeight || 1) {
    const halfDiagonal = Math.hypot(width, height) / 2;
    const orbitClearance = Math.min(width, height) * 0.57;
    return Math.max(halfDiagonal + 90, orbitClearance);
  }

  function resizeCometCanvas() {
    if (!cometContext) return;
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const targetWidth = Math.ceil(width * ratio);
    const targetHeight = Math.ceil(height * ratio);
    if (cometCanvas.width !== targetWidth || cometCanvas.height !== targetHeight) {
      cometCanvas.width = targetWidth;
      cometCanvas.height = targetHeight;
      cometCanvas.style.width = `${width}px`;
      cometCanvas.style.height = `${height}px`;
    }
    cometContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function clearCometCanvas() {
    if (!cometContext) return;
    cometContext.clearRect(0, 0, window.innerWidth || 1, window.innerHeight || 1);
  }

  function resetCometTrail() {
    cometState.active = false;
    cometState.cooldown = 0;
    cometState.trail = [];
    clearCometCanvas();
  }

  function spawnComet() {
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const center = solarCenter(width, height);
    const spawnR = outerScreenRadius(width, height);
    const phi = randomBetween(0, Math.PI * 2);
    const x = center.x + spawnR * Math.cos(phi);
    const y = center.y + spawnR * Math.sin(phi);
    const aimMin = Math.min(95, spawnR * 0.2);
    const aimMax = Math.max(aimMin + 35, Math.min(240, spawnR * 0.42));
    const aimDist = randomBetween(aimMin, aimMax);
    const aimAngle = randomBetween(0, Math.PI * 2);
    const aimX = center.x + aimDist * Math.cos(aimAngle);
    const aimY = center.y + aimDist * Math.sin(aimAngle);
    const dx = aimX - x;
    const dy = aimY - y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const approachX = dx / distance;
    const approachY = dy / distance;
    const escapeVelocity = Math.sqrt(2 * cometGravity() / spawnR);
    const speed = escapeVelocity * randomBetween(1.1, 1.32);
    const tangentSign = Math.random() < 0.5 ? -1 : 1;
    const tangentSpeed = speed * randomBetween(0.18, 0.34) * tangentSign;

    cometState.active = true;
    cometState.cooldown = 0;
    cometState.trail = [];
    cometState.x = x;
    cometState.y = y;
    cometState.vx = speed * approachX - tangentSpeed * approachY;
    cometState.vy = speed * approachY + tangentSpeed * approachX;
    cometState.spawnR = spawnR;
    cometState.dissolveCarry = 0;
  }

  function updateCometStep(stepScale = 1) {
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const center = solarCenter(width, height);

    if (!cometState.active) {
      if (cometState.trail.length > 0) {
        cometState.dissolveCarry += COMET_DISSOLVE_RATE * stepScale;
        const removeCount = Math.floor(cometState.dissolveCarry);
        if (removeCount > 0) {
          cometState.trail.splice(0, removeCount);
          cometState.dissolveCarry -= removeCount;
        }
      }
      if (cometState.cooldown > 0) cometState.cooldown -= stepScale;
      if (cometState.cooldown <= 0 && cometState.trail.length === 0) spawnComet();
      return;
    }

    const dx = center.x - cometState.x;
    const dy = center.y - cometState.y;
    const r = Math.max(1, Math.hypot(dx, dy));
    const acceleration = cometGravity() / (r * r);
    cometState.vx += acceleration * dx / r * stepScale;
    cometState.vy += acceleration * dy / r * stepScale;
    cometState.x += cometState.vx * stepScale;
    cometState.y += cometState.vy * stepScale;
    cometState.trail.push({x: cometState.x, y: cometState.y});
    if (cometState.trail.length > COMET_TRAIL_LIMIT) {
      cometState.trail.splice(0, cometState.trail.length - COMET_TRAIL_LIMIT);
    }

    const rx = cometState.x - center.x;
    const ry = cometState.y - center.y;
    const rd = Math.max(1, Math.hypot(rx, ry));
    const radialVelocity = (cometState.vx * rx + cometState.vy * ry) / rd;
    if (rd > cometState.spawnR * 1.02 && radialVelocity > 0) {
      cometState.active = false;
      cometState.cooldown = Math.floor(randomBetween(200, 380));
      cometState.dissolveCarry = 0;
    }
    if (r < COMET_ABSORB_RADIUS) {
      cometState.active = false;
      cometState.cooldown = Math.floor(randomBetween(160, 260));
      cometState.dissolveCarry = 0;
    }
  }

  function drawCircle(x, y, radius, color) {
    cometContext.beginPath();
    cometContext.arc(x, y, radius, 0, Math.PI * 2);
    cometContext.fillStyle = color;
    cometContext.fill();
  }

  function drawCometTrail() {
    const trail = cometState.trail;
    const count = trail.length;
    if (count === 0) return;

    for (let i = 0; i < count; i += 1) {
      const point = trail[i];
      const frac = count === 1 ? 1 : i / (count - 1);
      const alpha = Math.pow(frac, 0.5) * 0.73;
      const size = Math.max(Math.pow(frac, 0.38) * 3.8, 0.5);
      drawCircle(point.x, point.y, size, `rgba(255, 210, 120, ${alpha})`);
      if (frac > 0.5) {
        drawCircle(point.x, point.y, size * 0.44, `rgba(255, 240, 180, ${alpha * 0.95})`);
      }

      if (i < count - 1) {
        const next = trail[i + 1];
        const gap = Math.hypot(next.x - point.x, next.y - point.y);
        const steps = Math.min(14, Math.ceil(gap / (size * 2.4)));
        if (steps > 1) {
          for (let s = 1; s < steps; s += 1) {
            const t = s / steps;
            const ix = point.x + (next.x - point.x) * t;
            const iy = point.y + (next.y - point.y) * t;
            drawCircle(ix, iy, size * 0.55, `rgba(230, 170, 70, ${alpha * 0.42})`);
          }
        }
      }
    }
  }

  function drawCometHead() {
    if (!cometState.active) return;
    const glow = cometContext.createRadialGradient(
      cometState.x,
      cometState.y,
      0,
      cometState.x,
      cometState.y,
      16,
    );
    glow.addColorStop(0, "rgba(255, 255, 255, 1)");
    glow.addColorStop(0.35, "rgba(255, 235, 180, 0.9)");
    glow.addColorStop(1, "rgba(230, 150, 45, 0)");
    drawCircle(cometState.x, cometState.y, 16, glow);
    drawCircle(cometState.x, cometState.y, 3.5, "rgba(255, 255, 255, 1)");
  }

  function drawAmbientSun() {
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const center = solarCenter(width, height);
    const radius = Math.max(20, Math.min(width, height) * 0.035);
    const glow = cometContext.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius * 2.4);
    glow.addColorStop(0, "rgba(255, 244, 205, 0.95)");
    glow.addColorStop(0.32, "rgba(225, 177, 84, 0.72)");
    glow.addColorStop(1, "rgba(225, 177, 84, 0)");
    drawCircle(center.x, center.y, radius * 2.4, glow);
    drawCircle(center.x, center.y, radius * 0.54, "rgba(255, 241, 197, 0.96)");
  }

  function renderComet() {
    if (!cometContext) return;
    clearCometCanvas();
    cometContext.save();
    cometContext.globalCompositeOperation = "source-over";
    drawCometTrail();
    drawCometHead();
    cometContext.globalCompositeOperation = "source-over";
    drawAmbientSun();
    cometContext.restore();
  }

  function animateComets(timestamp = 0) {
    if (!motionEnabled || !cometContext) return;
    const delta = Math.min(100, Math.max(0, timestamp - lastCometTime || COMET_FIXED_STEP));
    lastCometTime = timestamp;
    updateCometStep(delta / COMET_FIXED_STEP / COMET_TIME_SCALE);
    renderComet();
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
    if (motionEnabled || reducedMotion.matches || !cometContext) return;
    motionEnabled = true;
    resizeCometCanvas();
    spawnComet();
    lastCometTime = performance.now();
    cometFrame = requestAnimationFrame(animateComets);
    glyphs.forEach((glyph, index) => {
      window.setTimeout(() => animateGlyph(glyph), index * 260);
    });
    window.addEventListener("resize", handleCometResize, {passive: true});
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
    window.removeEventListener("resize", handleCometResize);
    window.removeEventListener("pointermove", applyParallax);
    document.documentElement.removeEventListener("pointerleave", resetParallax);
    resetCometTrail();
    for (const glyph of glyphs) glyph.removeAttribute("style");
    resetParallax();
  }

  function handleCometResize() {
    resizeCometCanvas();
    if (motionEnabled) spawnComet();
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

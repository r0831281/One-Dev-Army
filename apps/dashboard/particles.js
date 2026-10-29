import { state } from "./core.js";
let stopGateParticles = null;
function startGateParticles(canvas) {
  if (stopGateParticles) stopGateParticles();
  const context = canvas.getContext("2d");
  if (!context) return;
  let frame = 0;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  const pointer = { active: false, x: 0.5, y: 0.5 };
  const particles = Array.from({ length: 34 }, (_, index) => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.012 + Math.random() * 0.026;
    return {
      x: Math.random(),
      y: Math.random(),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.65,
      radius: index % 5 === 0 ? 2.2 : 1.25 + Math.random() * 0.45,
      phase: Math.random() * Math.PI * 2,
      depth: 0.65 + Math.random() * 0.7,
      cyan: index % 4 === 0,
    };
  });
  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const draw = (advance, time = 0, delta = 0) => {
    context.clearRect(0, 0, width, height);
    for (const particle of particles) {
      if (advance) {
        const drift = Math.sin(time * 0.00045 + particle.phase) * 0.0025;
        particle.x += (particle.vx + drift) * delta * particle.depth;
        particle.y += (particle.vy + drift * 0.45) * delta * particle.depth;
        if (pointer.active) {
          const dx = pointer.x - particle.x;
          const dy = pointer.y - particle.y;
          const distance = Math.hypot(dx * width, dy * height);
          if (distance < 190 && distance > 1) {
            const pull = (1 - distance / 190) * 0.012 * delta;
            particle.x += dx * pull;
            particle.y += dy * pull;
          }
        }
        if (particle.x < 0) {
          particle.x = 0;
          particle.vx = Math.abs(particle.vx);
        } else if (particle.x > 1) {
          particle.x = 1;
          particle.vx = -Math.abs(particle.vx);
        }
        if (particle.y < 0) {
          particle.y = 0;
          particle.vy = Math.abs(particle.vy);
        } else if (particle.y > 1) {
          particle.y = 1;
          particle.vy = -Math.abs(particle.vy);
        }
      }
    }
    for (let left = 0; left < particles.length; left++) {
      const a = particles[left];
      const ax = a.x * width;
      const ay = a.y * height;
      for (let right = left + 1; right < particles.length; right++) {
        const b = particles[right];
        const bx = b.x * width;
        const by = b.y * height;
        const distance = Math.hypot(ax - bx, ay - by);
        if (distance < 145) {
          const shimmer = 0.8 + Math.sin(time * 0.0012 + a.phase + b.phase) * 0.2;
          const alpha = 0.16 * (1 - distance / 145) * shimmer;
          context.strokeStyle = `rgba(101,216,237,${alpha})`;
          context.lineWidth = 0.7;
          context.beginPath();
          context.moveTo(ax, ay);
          context.lineTo(bx, by);
          context.stroke();
        }
      }
      const pulse = 0.82 + Math.sin(time * 0.002 + a.phase) * 0.18;
      context.fillStyle = a.cyan ? "rgba(101,216,237,.78)" : "rgba(255,209,102,.7)";
      context.shadowColor = a.cyan ? "rgba(101,216,237,.55)" : "rgba(255,209,102,.42)";
      context.shadowBlur = a.radius * 4;
      context.beginPath();
      context.arc(ax, ay, a.radius * pulse, 0, Math.PI * 2);
      context.fill();
    }
    context.shadowBlur = 0;
  };
  resize();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || state.lowPower;
  if (reduced) draw(false);
  else {
    const animate = (time) => {
      if (time - lastFrame >= 32 && !document.hidden) {
        const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.08) : 0;
        draw(true, time, delta);
        lastFrame = time;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
  }
  const observer = new ResizeObserver(() => {
    resize();
    if (reduced) draw(false);
  });
  observer.observe(canvas);
  const host = canvas.parentElement;
  const trackPointer = (event) => {
    const bounds = canvas.getBoundingClientRect();
    pointer.active = true;
    pointer.x = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
    pointer.y = (event.clientY - bounds.top) / Math.max(bounds.height, 1);
  };
  const releasePointer = () => {
    pointer.active = false;
  };
  host?.addEventListener("pointermove", trackPointer);
  host?.addEventListener("pointerleave", releasePointer);
  stopGateParticles = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    host?.removeEventListener("pointermove", trackPointer);
    host?.removeEventListener("pointerleave", releasePointer);
    stopGateParticles = null;
  };
}

export { startGateParticles, stopGateParticles };

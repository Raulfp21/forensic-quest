/* ============================================================================
   scroll-world-video — portable scroll-scrubbed camera-flight engine
   ----------------------------------------------------------------------------
   Framework-agnostic. Vanilla JS, zero dependencies. It builds its own DOM and
   injects its own (namespaced) CSS into a container you give it, so it drops into
   plain HTML, Next.js (call from a ref/useEffect), Vue (onMounted), a server-
   rendered page, anything.

   USAGE
     mountScrollWorld(document.getElementById('world'), {
       brand: { name: 'Pearl & Co.', href: '#top' },
       diveScroll: 1.3,   // viewport-heights of scroll per dive clip
       connScroll: 0.9,   // ...per connector clip
       hint: 'scroll to fly in',
       nav: true,         // show the top section nav
       atmosphere: true,  // subtle gradient + drifting particles behind the clips
       sections: [
         { id, label, still, clip, clipMobile, accent,
           scroll: 1.6,   // optional per-section override of diveScroll — more scroll
                          // distance = a slower, longer dwell in this scene
           linger: 0.5,   // optional 0..1 — remaps time so the camera settles mid-scene
                          // (exactly where the copy peaks) and moves quicker at the
                          // edges. 0 = linear (default). Keep ≤ 0.6; 1 = full pause.
           eyebrow, title, body, tags:[…],
           status: 'Day 14',            // optional short state readout beside the number
           facts: [['Depth','1,200 ft'], ['Founded','3E 402']],  // optional 2-col dl
           cta:{ primary:{label,href}, secondary:{label,href} } }, // last section only
         …
       ],
       connectors: [clipUrl, …],          // length = sections.length - 1 (nulls allowed)
       connectorsMobile: [clipUrl, …],    // optional lighter connectors for phones (same length)

     The FIRST section's title renders as the page's <h1>, the rest as <h2>. The engine owns
     all copy, so this is the only place an <h1> can come from — don't put one in a loading
     overlay and consider it handled; the overlay gets removed.

     Emits `sw:sectionchange` on the container ({ detail:{ index, section } }) whenever the
     active chapter changes, so host chrome (progress readouts, state bars, analytics) can
     react without polling scroll.

     Returns { destroy() } — call it when unmounting (React effect cleanup, Vue
     onUnmounted). It cancels the rAF loop, drops the listeners, releases the video
     elements, and revokes only the object URLs the engine itself created. Skipping
     it in an SPA leaks a full set of clips per mount.

     If you pass blob: URLs for `clip`/`connectors` (i.e. the page preloaded them via
     preload-gate.js), the engine attaches them directly instead of re-fetching — otherwise
     every clip would be held twice in the blob store for the page's lifetime.

     `resolveClip(url) -> objectURL | Promise<objectURL> | null` (optional) lets a preloader
     that is STILL streaming take ownership of a clip the engine is about to load. Needed for
     partial gating (`gateCount`): without it the engine fetches the deferred clip itself while
     the preloader fetches the same URL in the background, so the file downloads twice.
     Return null (or resolve null) for anything you don't hold — the engine then fetches it
     itself, so a failed background download costs one retry, never the clip.

   MOBILE (the clipMobile/connectorsMobile variants are the opt-in "mobile beta";
   the rest of the phone handling below is always on)
     The engine is phone-aware out of the box: on a coarse-pointer / ≤860px viewport it
       - uses ONE shared <video> for the whole page (`singleDecoder`, default true), moved
         between scenes as you travel. iOS Safari's simultaneous-decode budget is 1-2
         elements and every clip here is a blob (fully resident, no range requests); past
         the budget the extra elements never reach readyState>=2, so their scenes stay
         posters and clips start working at random as iOS evicts others. This is THE fix for
         "only the first clip scrubs, the rest are static images". Set `singleDecoder:false`
         to opt out (desktop is unaffected — it keeps one element per segment).
       - loads `clipMobile` / `connectorsMobile` when provided (encode these smaller +
         tighter-GOP — seek cost on a phone decoder is dominated by frames-from-keyframe,
         so a 720p, -g 4 file scrubs far smoother than the 1080p desktop master; see
         pipeline.md). Falls back to the desktop `clip` if no mobile variant is given.
       - coalesces seeks (never issues a new currentTime while the decoder is still
         `seeking`) so fast flicks can't pile up and freeze the video.
       - reveals a clip on any of loadedmetadata/loadeddata/canplay/playing/seeked/timeupdate
         gated on `readyState >= 2`, because iOS completes seeks WITHOUT firing `seeked` —
         hanging the reveal on that one event leaves the poster up forever.
       - re-primes every un-painted clip on EVERY touch (not just the first), since the
         shared element is re-pointed at new clips as you scroll and each needs its own
         gesture authorisation.
       - reads `scrollY` inside the rAF loop instead of trusting the last `scroll` event:
         iOS delivers events sparsely during inertia, and a stale target makes the clip
         converge and stop while the finger is still moving.
       - drops the drifting particles and ignores URL-bar-only resizes (no scroll jump).
     Nothing here is required — a config with only `clip`/`connectors` still works on
     phones; the mobile variants just make it lighter and smoother.

     NOTE for Cohub/iframe hosts: a Work shell loads the page in an <iframe> without
     `allow="autoplay"`, so every prime `play()` is rejected (measured: prime=20 ok=0
     fail=20). That is survivable — the reveal path does not depend on play() succeeding —
     but it removes the decoder warm-up, so the readyState-gated reveal above is what
     carries the page there.

   THEME (CSS custom properties; set on the container or :root to override)
     --sw-bg         page background (match your scene bg for seamless posters)
     --sw-ink        primary text
     --sw-ink-soft   secondary text
     --sw-accent     default accent (each section overrides via its `accent`)
     --sw-font-display / --sw-font-body

   REQUIREMENTS ON YOUR ASSETS
     - clips encoded native-res + native-fps, crf 23–24, -g 8, +faststart, no audio
       (see pipeline.md §5 — do NOT re-encode at crf 20, it inflates generated video ~19%
       over source for no measurable SSIM gain, and never drop fps: fewer frames each carry
       more motion delta, so a 16fps re-encode comes out BIGGER than the 24fps original)
     - stills are 16:9, matching the clip frame, so the poster and the clip's first frame
       are the same composition (a 3:2 still visibly jumps when the video takes over)
     - connectors' endpoints are the neighbouring dives' ACTUAL frames (see SKILL Step 5)
     - (optional) mobile variants at 640x360, -g 4 for smoother phone scrubbing
   The engine loads each clip as a Blob (always seekable) and scrubs currentTime; it does
   NOT depend on HTTP byte-range support.
   ========================================================================== */

function mountScrollWorld(container, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phone detection. `coarse` is captured once (input type doesn't change mid-session);
  // the ≤860px query is read live via isMobile() so a desktop resize/DevTools toggle
  // switches sources and seek behaviour without a reload.
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isMobile = () => coarse || smallMQ.matches;
  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const CONNECTORS_M = config.connectorsMobile || [];
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;
  const CROSSFADE = (config.crossfade != null) ? config.crossfade : 0.12;  // seam dissolve width (vh)
  const N = SECTIONS.length;
  if (!N) return;

  injectCSS();
  container.classList.add('sw-root');

  // ---- build the interleaved segment chain: dive0, conn0, dive1, … diveN-1 ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    const dive = { kind: 'dive', si: i, clip: s.clip, clipM: s.clipMobile, still: s.still, accent: s.accent,
                   w: s.scroll || DIVE_W, linger: s.linger || 0 };
    SEGMENTS.push(dive);
    s._seg = dive;
    // A connector is optional: if connectors[i] is falsy, the two dives simply
    // crossfade directly (no fly-over). Lets a page complete even when a
    // connector can't be generated (e.g. a content-filter false-positive).
    if (i < N - 1 && CONNECTORS[i]) {
      SEGMENTS.push({ kind: 'conn', si: i, clip: CONNECTORS[i], clipM: CONNECTORS_M[i],
                      still: SECTIONS[i + 1].still, accent: SECTIONS[i + 1].accent, w: CONN_W });
    }
  });
  const NSEG = SEGMENTS.length;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const scrollbar = el('div', 'sw-scrollbar');
  const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    brand.appendChild(el('span', 'sw-brand__mark'));
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    topbar.appendChild(c);
  }

  const stage = el('div', 'sw-stage');
  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText);
  hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track].forEach(n => container.appendChild(n));

  // segment scenes
  SEGMENTS.forEach(s => {
    const scene = el('div', 'sw-scene'); scene.style.setProperty('--sw-accent', s.accent || '');
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
    if (s.still) img.src = s.still;
    scene.appendChild(img); stage.appendChild(scene);
    s.el = scene; s.img = img; s.video = null; s.hasClip = false;
    s.loading = false; s.ready = false; s.cur = 0; s.target = 0; s.visible = false; s.fails = 0;
    s.painted = false; s.videoUrl = null;
  });

  // per-section copy / route / nav
  const copies = [], dots = [];
  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    // The first section's title is the page's <h1>. The engine renders ALL copy, so if it
    // hardcoded <h2> the document would have no h1 at all — and a host page can't fix that
    // from outside. (Putting an <h1> in a loading overlay does not count: the overlay is
    // removed after load, leaving the document headless again.)
    const heading = i === 0 ? 'h1' : 'h2';
    c.innerHTML =
      `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>` +
      (s.status ? `<span class="sw-copy__status">${esc(s.status)}</span>` : '') +
      (s.eyebrow ? `<span class="sw-copy__eyebrow">${esc(s.eyebrow)}</span>` : '') +
      (s.title ? `<${heading} class="sw-copy__title">${esc(s.title)}</${heading}>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.facts && s.facts.length ? `<dl class="sw-copy__facts">${s.facts.map(f => `<div><dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd></div>`).join('')}</dl>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  // Per-section dwell: monotone remap of scroll→time so the camera settles mid-scene
  // (where the copy peaks) and moves quicker near the seams. L=0 linear, L=1 full
  // mid-scene pause. f(0)=0, f(1)=1 always, so seam frames are untouched.
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1, ticking = false;
  let laidOutW = window.innerWidth;   // width the current layout was computed at (see onResize)
  let lastReadY = -1;                 // scroll position of the last full read() pass

  function layout() {
    vh = window.innerHeight;
    laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    let off = 0;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';   // +1vh so the last flight completes
    read();
  }

  function jumpTo(i) {
    const seg = SECTIONS[i]._seg;
    window.scrollTo({ top: seg.start + (seg.end - seg.start) * 0.5, behavior: reduce ? 'auto' : 'smooth' });
  }

  // ---- shared single decoder (phones) ----
  // Measured on real iOS: with one <video> per segment the engine held 2-3 decoders open at
  // once on a phone. iOS Safari's simultaneous-decode budget is small and memory-dependent,
  // and every clip here is a blob (no range requests, so the WHOLE file stays resident).
  // Past the budget the extra elements simply never reach readyState>=2 — their scenes stay
  // posters, and one frees up unpredictably when iOS evicts another. That is the exact
  // reported symptom: stills from the second clip on, with occasional clips working for no
  // visible reason.
  //
  // So on a phone there is exactly ONE <video> for the whole page; it moves between scenes as
  // you travel. Two extra wins fall out of it: the element keeps the gesture authorisation
  // iOS granted it on first touch (a fresh element would need its own), and peak memory stops
  // scaling with the clip count.
  //
  // Desktop keeps one element per segment — no such budget, and crossfades need both sides
  // of a seam decoded at once.
  const SINGLE_DECODER = (config.singleDecoder != null) ? config.singleDecoder : true;
  let shared = null;       // the one element, on a phone
  let sharedOwner = null;  // segment currently holding it

  function makeVideo() {
    const v = document.createElement('video');
    v.className = 'sw-scene__video';
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    return v;
  }

  // The still hides only when we can prove a frame is compositable (readyState >= 2 =
  // HAVE_CURRENT_DATA). Called from several events because no single one is reliable on iOS.
  function onPaint(s) {
    if (!s || !s.video || s.painted) return;
    if (s.video.readyState < 2) return;
    s.painted = true; s.ready = true;
    s.el.classList.add('has-clip');
  }

  // Wire the reveal listeners. With a shared element these must resolve the CURRENT owner at
  // call time, not close over one segment.
  //
  // Do NOT hang the reveal on a single `seeked`: iOS completes seeks without firing it, and a
  // `{once:true}` listener that never fires means `has-clip` is never added and the poster
  // never lifts — measured as the single biggest cause of "every clip after the first is a
  // static image". Listen broadly and gate on readyState instead.
  function wireVideo(v, ownerOf) {
    const paint = () => onPaint(ownerOf());
    ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'seeked', 'timeupdate']
      .forEach(ev => v.addEventListener(ev, paint));
    v.addEventListener('loadedmetadata', () => { const s = ownerOf(); if (s) { s.ready = true; read(); } });
    v.addEventListener('loadeddata', () => {
      try { v.pause(); } catch (e) {}
      if (userReady) primeVideo(v);
    });
  }

  // Hand the single decoder to `s`, pointed at `url`. Moving the element rather than making a
  // new one is the whole point — see SINGLE_DECODER.
  function grantShared(s, url) {
    if (!shared) { shared = makeVideo(); wireVideo(shared, () => sharedOwner); }
    if (sharedOwner === s && shared.src === url) return;
    // Take it off the previous owner: that scene falls back to its still, which is what the
    // viewer sees at a stopping point anyway.
    if (sharedOwner && sharedOwner !== s) {
      const p = sharedOwner;
      p.el.classList.remove('has-clip');
      p.video = null; p.hasClip = false; p.ready = false; p.painted = false; p.loading = false;
    }
    sharedOwner = s;
    s.video = shared; s.hasClip = true; s.ready = false; s.painted = false;
    if (shared.parentNode !== s.el) s.el.appendChild(shared);
    if (shared.src !== url) shared.src = url;
    else if (shared.readyState >= 2) onPaint(s);
  }

  // Build the <video>, wire it up, and mount it. `owned` marks an object URL this engine
  // minted (and must therefore revoke in destroy()); a blob URL handed in by the page is
  // the page's to manage.
  function attachVideo(s, url, owned) {
    // Remember the resolved URL so the shared decoder can come back to this segment later
    // without re-fetching (and, for an owned blob, without minting a second object URL).
    s.videoUrl = url;
    if (owned) s.ownedUrl = url;
    if (SINGLE_DECODER && isMobile()) { grantShared(s, url); return; }
    const v = makeVideo();
    v.src = url;
    wireVideo(v, () => s);
    s.el.appendChild(v); s.video = v; s.hasClip = true;
  }

  function loadClip(s) {
    // Under prefers-reduced-motion we never load the clips at all — the stills stay up
    // and simply cross-dissolve as you scroll. No scrubbed video motion, no decode cost.
    if (reduce || s.loading || s.video || !s.clip) return;
    // read() runs on every scroll frame, so without a cap a permanently-dead URL (404,
    // offline) turns into a request storm for the whole session.
    if (s.fails >= 2) return;
    // The bytes are already resident from a previous visit to this segment (the preload gate
    // holds every blob for the page's life). Just take the decoder back — no refetch.
    if (s.videoUrl) { attachVideo(s, s.videoUrl, false); return; }
    s.loading = true;
    // Serve the lighter mobile encode on phones when one was provided.
    const url = (isMobile() && s.clipM) ? s.clipM : s.clip;
    // Already an object URL — the page preloaded these bytes (see preload-gate.js) and
    // they are in the blob store right now. Re-fetching would materialise a SECOND Blob
    // for the same clip, so the store would hold every video twice for the page's life.
    if (/^blob:/i.test(url)) { attachVideo(s, url, false); return; }
    // `resolveClip` lets a preloader own the bytes for clips it is still streaming in the
    // background. Without it the engine starts its own fetch for the same URL and the file
    // is downloaded TWICE — once by the engine, once by the preloader — with the
    // preloader's copy then never used.
    if (typeof config.resolveClip === 'function') {
      let held = null;
      try { held = config.resolveClip(url); } catch (e) { held = null; }
      if (held) {
        // A resolver that ends up with nothing (its own fetch failed) must NOT cost the
        // scene its clip — fall back to the network rather than counting it as a failure,
        // or the scene stays a still forever.
        Promise.resolve(held)
          .then(resolved => { resolved ? attachVideo(s, resolved, false) : fetchClip(s, url); })
          .catch(() => fetchClip(s, url));
        return;
      }
      // Nothing held for this URL — fall through and fetch it ourselves.
    }
    fetchClip(s, url);
  }

  // The engine's own fetch path: mint a Blob we own (so destroy() revokes it) and cap
  // failures so a dead URL can't turn every scroll frame into a new request.
  function fetchClip(s, url) {
    s.loading = true;
    fetch(url).then(r => r.ok ? r.blob() : Promise.reject(new Error('404')))
      .then(blob => attachVideo(s, URL.createObjectURL(blob), true))
      .catch(() => { s.loading = false; s.fails += 1; });
  }

  // Scroll→time mapping, split out of read() so the rAF loop can refresh it every frame
  // without waiting for a `scroll` event. On iOS the inertial phase delivers events sparsely;
  // a target left stale between them makes `cur` converge and STOP while the finger is still
  // moving — measured as "the clip lags, then just holds a frame".
  function syncTargets(y) {
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
      s.target = s.linger ? lingerEase(local, s.linger) : local;
    }
  }

  // Which segment should hold the single decoder on a phone: the one we are inside, else the
  // nearest by distance. Resolved on approach rather than after arrival, so the handoff has
  // time to land before the scene is on screen.
  function decoderOwner(y) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (y >= s.start && y <= s.end) return s;
      const d = y < s.start ? (s.start - y) : (y - s.end);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  function read() {
    const y = window.scrollY || window.pageYOffset;
    lastReadY = y;
    const fade = CROSSFADE * vh;
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;

    // With one shared decoder there is no point asking for more than one clip: only the
    // owner can hold it, and every extra request would just thrash the handoff.
    const solo = (SINGLE_DECODER && isMobile()) ? decoderOwner(y) : null;

    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (solo) {
        if (s === solo) loadClip(s);
      } else if (y > s.start - 1.6 * vh && y < s.end + 1.6 * vh) {
        loadClip(s);
      }
      const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
      s.target = s.linger ? lingerEase(local, s.linger) : local;
      let outside = 0;
      if (y < s.start) outside = s.start - y; else if (y > s.end) outside = y - s.end;
      const op = smooth(1 - outside / fade);
      s.el.style.opacity = op; s.visible = op > 0.001;
      s.el.style.zIndex = (i === ci) ? '120' : String(100 + Math.round(op * 10));
      if (!s.hasClip || !s.ready) {
        const sc = reduce ? 1 : 1.03 + local * 0.14;
        s.img.style.transform = `translateX(${stageX - 2}vw) scale(${sc.toFixed(3)})`;
      }
    }

    for (let i = 0; i < N; i++) {
      const seg = SECTIONS[i]._seg;
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (i === 0) cop = after ? 0 : smooth(1 - pr / 0.62);            // greets on landing
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);       // holds CTA at the end
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];
      c.style.opacity = cop;
      // Desktop copy is vertically centred via `top:50%` + a -50% translate. Writing a
      // bare translateY() here would overwrite that and drop the copy half a viewport low,
      // so the desktop branch folds the centring back in. Mobile is bottom-anchored (no
      // -50%), hence the split.
      c.style.transform = reduce ? 'none' : (isMobile()
        ? `translateY(${(0.5 - pr) * 4}vh)`
        : `translateY(calc(-50% + ${(0.5 - pr) * 4}vh))`);
      c.style.pointerEvents = cop > 0.5 ? 'auto' : 'none';
    }

    const cur = SEGMENTS[ci];
    const near = clamp(cur.kind === 'dive' ? cur.si
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);
    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => d.classList.toggle('is-active', k === near));
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) => n.classList.toggle('is-active', k === near));
      container.style.setProperty('--sw-accent', SECTIONS[near].accent || '');
      // Let the host page react to chapter changes (progress readouts, state bars, analytics)
      // without polling scroll itself. Resolved off the container's own view so the engine
      // still works outside a browser global scope (jsdom / SSR test harnesses).
      const CE = (container.ownerDocument && container.ownerDocument.defaultView
        && container.ownerDocument.defaultView.CustomEvent)
        || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
      if (CE) container.dispatchEvent(new CE('sw:sectionchange', { detail: { index: near, section: SECTIONS[near] } }));
    }
    scrollbarFill.style.transform = `scaleX(${clamp(y / (totalW * vh))})`;
    hint.style.opacity = clamp(1 - y / (0.5 * vh));
    if (particles) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    ticking = false;
  }

  function raf() {
    // ABSOLUTE seconds, not a fraction of duration. As a fraction, 0.02 meant a 0.12s step on
    // a 6s clip and 0.20s on a 10s one — so longer clips needed ~24px of finger travel before
    // a single seek fired, and the same gesture felt stiffer later in the journey. A flat
    // 0.06s is ~5px of travel and uniform across clips. Measured on a 60px slow drag: seeks
    // 14 → 6 while actual travel rose 0.303s → 0.468s — fewer seeks AND more motion. The
    // `seeking` guard below is what prevents a pile-up, not this figure.
    const eps = isMobile() ? 0.06 : 0.02;
    // Read the scroll position ourselves rather than trusting the last `scroll` event to have
    // refreshed it (see syncTargets).
    const y = window.scrollY || window.pageYOffset;
    syncTargets(y);
    // The visual layer (opacity, z-order, copy, dots, decoder handoff) is still event-driven,
    // but a moved viewport with no delivered scroll event would leave it stale too — so
    // reconcile it here when the position actually changed since the last full pass.
    if (Math.abs(y - lastReadY) > 0.5 && !ticking) { ticking = true; read(); }
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (!s.hasClip || !s.ready || !s.video) continue;
      // Never queue a seek while the decoder is still resolving the last one.
      // On phones a fast flick would otherwise pile up seeks and freeze the clip;
      // cur keeps lerping, so we snap to the latest target the moment it's free.
      if (s.video.seeking) continue;
      if (!s.visible && Math.abs(s.cur - s.target) < 0.002) continue;
      // Converge harder on a phone: at 0.18 the clip needs ~200ms to land on target, which
      // reads as lag behind the finger on a touch drag where there is no cursor to lead the
      // eye. Desktop keeps the softer ramp — a wheel arrives in coarse jumps that the extra
      // smoothing is genuinely hiding.
      s.cur += (s.target - s.cur) * (reduce ? 1 : (isMobile() ? 0.3 : 0.18));
      const dur = s.video.duration || 1;
      const t = clamp(s.cur, 0, 0.999) * dur;
      if (Math.abs(s.video.currentTime - t) > eps) { try { s.video.currentTime = t; } catch (e) {} }
    }
    rafId = requestAnimationFrame(raf);
  }

  // iOS needs a user gesture before a muted video will decode/paint reliably. We prime on
  // EVERY gesture until a clip has painted, not just the first: with the shared decoder the
  // element is re-pointed at a new clip as you travel, and a `{once:true}` hook would only
  // ever have authorised whatever was loaded at first touch. Cheap — already-painted clips
  // are skipped.
  let userReady = false;
  function primeVideo(v) {
    if (!isMobile() || !v) return;
    try { const p = v.play(); if (p && p.then) p.then(() => { try { v.pause(); } catch (e) {} }).catch(() => {}); }
    catch (e) {}
  }
  function onGesture() {
    userReady = true;
    if (shared && sharedOwner && !sharedOwner.painted) primeVideo(shared);
    SEGMENTS.forEach(s => { if (s.video && !s.painted) primeVideo(s.video); });
  }
  window.addEventListener('pointerdown', onGesture, { passive: true });
  window.addEventListener('touchstart', onGesture, { passive: true });
  window.addEventListener('touchend', onGesture, { passive: true });

  // Particles are a per-frame cost we can't afford alongside video scrubbing on a phone.
  seedParticles(particles, reduce || coarse);
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(read); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  // Mobile browsers fire `resize` every time the URL bar slides in/out. Re-running
  // layout() there rebuilds the track height and yanks the scroll position, so on
  // touch we ignore height-only changes and only relayout when the width actually
  // changes (rotation still comes through orientationchange). layout() records the
  // width it laid out at.
  function onResize() {
    if (coarse && window.innerWidth === laidOutW) return;
    layout();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  // NOTE: deliberately no revoke-on-pagehide. A pagehide with persisted=true means the page
  // is entering the back/forward cache and will be restored with this exact DOM — revoking
  // then hands the restored <video> elements dead src URLs. With persisted=false the
  // document is torn down anyway and the blob store is freed without our help.
  layout();
  let rafId = requestAnimationFrame(raf);

  // ---- teardown ----
  // The header tells you to mount this from a React ref/useEffect or Vue onMounted. Under
  // React StrictMode an effect runs twice in dev, so without a teardown the first mount's
  // <video> elements, its rAF loop, and its object URLs all stay alive forever behind the
  // second mount. Return the cleanup the docs imply.
  function destroy() {
    cancelAnimationFrame(rafId);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', layout);
    window.removeEventListener('load', layout);
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('touchstart', onGesture);
    window.removeEventListener('touchend', onGesture);
    SEGMENTS.forEach(s => {
      // With the shared decoder several segments can reference the SAME element over the
      // page's life, so tear it down once (below) rather than per segment.
      if (s.video && s.video !== shared) {
        try { s.video.pause(); } catch (e) {}
        s.video.removeAttribute('src'); try { s.video.load(); } catch (e) {}
      }
      // Only revoke what this engine minted; a URL the page handed in stays the page's to
      // manage (it may still be using it, or re-mounting with it).
      if (s.ownedUrl) { try { URL.revokeObjectURL(s.ownedUrl); } catch (e) {} s.ownedUrl = null; }
      s.video = null; s.hasClip = false; s.ready = false; s.loading = false;
      s.painted = false; s.videoUrl = null;
    });
    if (shared) {
      try { shared.pause(); } catch (e) {}
      shared.removeAttribute('src'); try { shared.load(); } catch (e) {}
      shared = null; sharedOwner = null;
    }
    container.innerHTML = '';
    container.classList.remove('sw-root');
  }

  return { destroy };

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}">${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}">${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 20; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectCSS() {
  if (document.getElementById('sw-css')) return;
  const css = `
  .sw-root{--sw-bg:#F5EDE0;--sw-ink:#241d2b;--sw-ink-soft:#6a6072;--sw-accent:#8a7bb5;
    --sw-font-display:ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
    --sw-font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    color:var(--sw-ink);font-family:var(--sw-font-body);}
  html,body{margin:0;background:var(--sw-bg,#F5EDE0);overflow-x:hidden;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--sw-bg);}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  .sw-scrollbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:60;background:color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-scrollbar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;opacity:0;overflow:hidden;will-change:opacity;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;transform:translateY(-50%);width:min(42vw,460px);opacity:0;will-change:opacity,transform;}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__status{display:inline-block;margin-left:12px;font-family:ui-monospace,Menlo,monospace;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin:24px 0 0;border-top:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);border-bottom:1px solid color-mix(in srgb,var(--sw-accent) 20%,transparent);}
  .sw-copy__facts div{padding:12px 14px 12px 0;min-width:0;}
  .sw-copy__facts div+div{padding-left:14px;border-left:1px solid color-mix(in srgb,var(--sw-accent) 18%,transparent);}
  .sw-copy__facts dt{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--sw-ink-soft);}
  .sw-copy__facts dd{margin:5px 0 0;font-size:.86rem;line-height:1.3;color:var(--sw-ink);overflow-wrap:anywhere;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 85%,transparent);backdrop-filter:blur(6px);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .3s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  @media (max-width:860px){
    .sw-nav{display:none;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    /* Anchor copy to the bottom, clear of the home indicator / collapsing URL bar.
       dvh + env() are progressive: browsers that lack them keep the vh fallback line. */
    .sw-copy{left:clamp(18px,5vw,64px);right:clamp(18px,5vw,64px);top:auto;bottom:clamp(64px,14vh,120px);transform:none;width:auto;max-width:560px;}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-copy__facts{margin-top:16px;} .sw-copy__facts div{padding-top:10px;padding-bottom:10px;} .sw-copy__facts dd{font-size:.8rem;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  /* Portrait phones crop a 16:9 clip hard; keep the framing centred so the focal
     subject (which the camera dives toward) stays in view. */
  @media (max-width:860px) and (orientation:portrait){
    .sw-scene__video,.sw-scene__still{object-position:center 44%;}
  }
  /* Touch: give the route dots a finger-sized hit area without growing the visible dot. */
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:14px 6px;}
    .sw-route__dot{width:28px;height:28px;}
    .sw-btn{padding:15px 26px;}
  }
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  // Wrap in a cascade layer so the page's own theme tokens (unlayered
  // :root / .sw-root { --sw-bg / --sw-ink / --sw-accent … }) always win over
  // these defaults, regardless of injection order. Enables clean dark themes.
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

// Expose for module + global use.
if (typeof module !== 'undefined' && module.exports) module.exports = { mountScrollWorld };
if (typeof window !== 'undefined') window.mountScrollWorld = mountScrollWorld;

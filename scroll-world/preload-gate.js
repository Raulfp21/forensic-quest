/* ============================================================================
   scroll-world-video — preload gate
   ----------------------------------------------------------------------------
   Holds the page behind a progress overlay until the assets are resident in memory
   as Blobs, then hands the engine blob URLs so scrolling never waits on the network.

   WHEN TO USE THIS — REQUIRED when the flight is the page's main content.

     The test: does scrolling the page advance the camera? If yes, the flight owns
     document scroll, the visitor's scroll IS the content, and this gate is required —
     a stall mid-flight stalls the only thing on offer, with nothing else to read while
     it recovers. Chrome around the flight (topbar, route rail, CTA, a footer after the
     track) does NOT demote it to secondary.

     Only when the flight is a bounded module inside a page whose scroll belongs to
     ordinary content (copy, pricing, forms) is the gate a product decision. Note that
     mount is not what the engine ships for — it listens on `window` scroll and injects
     a full-viewport fixed stage — so scoping it into a component is deliberate work the
     skill does not document.

   WHAT IT LOADS — EVERYTHING, before it reveals. No tiering, no `gateCount`.

     Every still and every clip must be resident before the page is shown. A partial
     gate only guarantees the FIRST scene: on a slow connection a later scene sits on
     its poster while its clip streams, which is the stall this gate exists to prevent.

     Honest cost: the visitor waits for the whole asset set before seeing anything
     (~25MB at the recommended 3 scenes, ~+9MB per extra scene), shown as a progress bar.
     This is why SKILL Step 1.4 proposes 3 scenes to the user with the reason attached,
     and why the Step 6 byte budget is a first-load WAIT number.

     Under `prefers-reduced-motion` the engine never loads clips at all, so the gate
     preloads only the stills. That's correctness, not tiering.

   USAGE
     <div id="sw-load" role="progressbar" aria-label="Loading"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"> … </div>

     mountWorldWithPreload({
       container: document.getElementById('world'),
       config: SW_CONFIG,                       // same object you'd pass to the engine
       overlay: document.getElementById('sw-load'),
       fill:    overlay.querySelector('.sw-load__fill'),   // width % element
       pct:     overlay.querySelector('.sw-load__pct'),    // "42%" text
       note:    overlay.querySelector('.sw-load__note'),   // retry/degraded messages
       font:    '1em KJV1611',                  // optional: display face to settle first
     });

   Requires mountScrollWorld() (scrub-engine.js) to be loaded first. It mutates the config
   it is given: still/clip URLs are swapped for resident blobs BEFORE the engine mounts, so
   the engine attaches them directly and never re-fetches.
   ========================================================================== */

function mountWorldWithPreload(opts) {
  const { container, config, overlay, fill, pct, note, font } = opts;

  // Mirror the ENGINE's own device test (scrub-engine.js `isMobile`) exactly. If these
  // two disagree we preload one encode and the engine then asks the network for the
  // other, which silently voids the gate's whole guarantee.
  const isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    || window.matchMedia('(max-width: 860px)').matches;
  // The engine skips clip loading entirely under reduced motion — stills just
  // cross-dissolve. Downloading ~50MB of video nobody will decode is pure waste.
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const sections = config.sections || [];
  const connectors = config.connectors || [];
  const connectorsMobile = config.connectorsMobile || [];
  // Only ever the variant this device will actually play — never both encodes.
  const pickClip = s => (isMobile && s.clipMobile) ? s.clipMobile : s.clip;
  const pickConn = i => (isMobile && connectorsMobile[i]) ? connectorsMobile[i] : connectors[i];

  // Interleave in travel order (scene0, conn0, scene1, conn1, …) so the progress bar
  // fills along the journey. Everything here is gated, so order only affects optics.
  const videoUrls = [];
  if (!reduce) {
    sections.forEach((s, i) => {
      const c = pickClip(s); if (c) videoUrls.push(c);
      const n = pickConn(i); if (n) videoUrls.push(n);
    });
  }
  const imgUrls = sections.map(s => s.still).filter(Boolean);

  // ONE tier. Every still + every clip must be resident before reveal.
  const ASSETS = imgUrls.concat(videoUrls);

  const totals = {}, loaded = {}, blobMap = {};
  ASSETS.forEach(u => { totals[u] = 0; loaded[u] = 0; });

  function render() {
    let tot = 0, got = 0;
    ASSETS.forEach(u => {
      // Before headers arrive, assume a nominal 8MB so the bar doesn't lurch.
      tot += totals[u] || 8 * 1024 * 1024;
      got += loaded[u];
    });
    const p = Math.max(0, Math.min(100, Math.round((got / tot) * 100)));
    if (fill) fill.style.width = p + '%';
    if (pct) pct.textContent = p + '%';
    if (overlay) overlay.setAttribute('aria-valuenow', String(p));
  }

  function say(msg) {
    if (!note) return;
    note.textContent = msg || '';
    note.classList.toggle('is-shown', !!msg);
  }

  // Stream a URL into a Blob, reporting bytes as they arrive.
  async function fetchBlob(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ' -> ' + res.status);
    const len = +res.headers.get('content-length');
    if (len) { totals[url] = len; render(); }
    if (!res.body) { const b = await res.blob(); loaded[url] = b.size; render(); return b; }
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); loaded[url] += value.length; render();
    }
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || '' });
    // A 200 with a short body is a TRUNCATED TRANSFER, not a success. Without this check
    // it becomes a permanently black clip that the gate happily waves through.
    if (len && blob.size !== len) throw new Error(url + ' -> truncated ' + blob.size + '/' + len);
    return blob;
  }

  // A transient failure (flaky network, CDN hiccup, memory pressure while the Blob is
  // assembled) must not be swallowed as "fine, use the network URL" — that dismisses the
  // gate with the clip not actually resident. Retry with backoff, fall back only after
  // genuinely giving up, and say so.
  async function fetchWithRetry(url, tries = 3) {
    for (let attempt = 1; ; attempt++) {
      try { return await fetchBlob(url); }
      catch (err) {
        if (attempt >= tries) throw err;
        // Partial bytes from the failed attempt are still counted; clear them so the
        // next attempt can't push the bar past 100%.
        loaded[url] = 0; render();
        say('Retrying a missing asset… (' + attempt + '/' + (tries - 1) + ')');
        await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt - 1)));
      }
    }
  }

  function swapIn() {
    sections.forEach(s => {
      if (s.still && blobMap[s.still]) s.still = blobMap[s.still];
      const c = pickClip(s);
      if (c && blobMap[c]) {
        // Point BOTH variants at the resident blob. Only one encode was downloaded, so
        // this is also what stops a mid-session viewport change from going to the network.
        s.clip = blobMap[c];
        if (s.clipMobile) s.clipMobile = blobMap[c];
      }
    });
    if (config.connectors) {
      config.connectors = config.connectors.map((u, i) => {
        const picked = pickConn(i);
        return (picked && blobMap[picked]) || u;
      });
      if (config.connectorsMobile) config.connectorsMobile = config.connectors.slice();
    }
  }

  function reveal(degraded) {
    swapIn();
    // Nothing is deferred, so there is no `resolveClip` handshake to install: the engine
    // sees a blob: URL for every clip and attaches it directly. (The engine still supports
    // resolveClip for a custom partial preloader — this gate just has no use for it.)
    const world = mountScrollWorld(container, config);
    if (fill) fill.style.width = '100%';
    if (pct) pct.textContent = '100%';
    say(degraded ? 'Some scenes will stream as you go.' : '');
    if (overlay) {
      overlay.classList.add('is-done');
      setTimeout(() => overlay.remove(), 700);
    }
    return world;
  }

  function start() {
    render();
    let degraded = false;
    const jobs = ASSETS.map(u =>
      fetchWithRetry(u)
        .then(b => { blobMap[u] = URL.createObjectURL(b); say(''); })
        .catch(() => {
          // Out of retries. Fall back to the network URL so the page still completes
          // (the engine will fetch that one itself), but report it rather than
          // pretending everything is resident.
          blobMap[u] = u;
          loaded[u] = totals[u] || 8 * 1024 * 1024;
          degraded = true;
          render();
        })
    );
    return Promise.all(jobs).then(() => reveal(degraded));
  }

  // Load the display face FIRST so the gate's own title paints in the right font the
  // instant it fades in (no FOUT), then reveal the gate, then start the heavy preload.
  // Never wait more than 2.5s on a font.
  const fontReady = (font && document.fonts && document.fonts.load)
    ? document.fonts.load(font).catch(() => {})
    : Promise.resolve();
  return Promise.race([fontReady, new Promise(r => setTimeout(r, 2500))]).then(() => {
    if (overlay) overlay.classList.add('is-ready');
    return start();
  });
}

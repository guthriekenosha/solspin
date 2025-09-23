(async function () {
    // Dynamic draw period and server-sourced timing (overridden by keeper /api/health if available)
    let DRAW_PERIOD_MS = 60 * 60 * 1000; // default 1h; replaced by keeper
    let SERVER_ACTIVE = false;
    let SERVER_LAST_TS = 0;
    let SERVER_NEXT_AT = 0;
    let SERVER_TIME_SKEW = 0; // clientNow - serverNow (ms)
    let SERVER_START_CAP = 100_000;
    let SERVER_STOP_CAP = 0;
    let SERVER_TOKEN_MINT = null;
    let SERVER_TOKEN_TICKER = null;
    let CURRENT_FDV_USD = 0;

    let ZERO_ARMED = false;            // prevents spamming refresh at zero
    let LAST_RECURRING_TS = 0;         // updated when we detect a new draw

    const SPIN_FULL_TURNS = 5;
    const SPIN_DURATION_MS = 8000;

    // Robust JSON fetch: try multiple candidate paths depending on where the server root is
    async function fetchFirstJSON(candidates) {
        for (const url of candidates) {
            try {
                const res = await fetch(url, { cache: "no-store" });
                if (res.ok) {
                    return await res.json();
                }
            } catch (_) {}
        }
        return null;
    }

    // Pull history to build current UI state (try multiple roots)
    const draws = await fetchFirstJSON([
        // when serving from app/web/
        "../state/draws.json",
        // when serving from app/
        "state/draws.json",
        // legacy path (in case someone serves from project root)
        "app/state/draws.json",
        "../app/state/draws.json"
    ]) || [];

    let registry = await fetchFirstJSON([
        "../state/registry.json",
        "state/registry.json",
        "app/state/registry.json",
        "../app/state/registry.json"
    ]) || [];

    // Try to auto-read draw interval and timing data from the keeper API
    async function loadIntervalFromKeeper() {
      const urls = [
        "http://127.0.0.1:3000/api/health",
        "http://localhost:3000/api/health",
        "/api/health"
      ];
      for (const u of urls) {
        try {
          const r = await fetch(u, { cache: "no-store" });
          if (!r.ok) continue;
          const j = await r.json();
          if (!j || !j.ok) continue;
          if (Number.isFinite(j.intervalMs) && j.intervalMs > 0) DRAW_PERIOD_MS = j.intervalMs;
          if (Number.isFinite(j.startCap) && j.startCap > 0) SERVER_START_CAP = j.startCap;
          if (Number.isFinite(j.stopCap) && j.stopCap >= 0) SERVER_STOP_CAP = j.stopCap;
          if (typeof j.tokenMint === "string" && j.tokenMint.trim().length) {
            SERVER_TOKEN_MINT = j.tokenMint.trim();
            const mintEl = document.getElementById("tokenMint");
            if (mintEl) mintEl.textContent = SERVER_TOKEN_MINT;
          }
          if (typeof j.tokenTicker === "string" && j.tokenTicker.trim().length) {
            SERVER_TOKEN_TICKER = j.tokenTicker.trim();
            const tickerEl = document.getElementById("tokenTicker");
            if (tickerEl) tickerEl.textContent = SERVER_TOKEN_TICKER;
          }
          SERVER_ACTIVE  = !!j.active;
          if (SERVER_ACTIVE) recurringActiveState = true;
          SERVER_LAST_TS = Number(j.lastRecurringTs || 0);
          SERVER_NEXT_AT = Number(j.nextAt || 0);
          const srvNow   = Number(j.serverTime || 0);
          if (srvNow > 0) SERVER_TIME_SKEW = Date.now() - srvNow;
          return; // stop on first success
        } catch (_) { /* try next */ }
      }
    }

    const lastTxRow  = document.getElementById("lastTxRow");
    const lastTxLink = document.getElementById("lastTxLink");
    const solPriceEl   = document.getElementById('solPrice');
    const tokenPriceEl = document.getElementById('tokenPrice');
    const milestonesBadgeEl = document.getElementById('milestonesBadge')
        || document.getElementById('milestoneBadges')
        || document.getElementById('badgeHost');
    const tiersTextEl = document.getElementById("tiersText");
    const activationNotice = document.getElementById("activationNotice");
    const marketCapEl = document.getElementById("marketCapValue");

    const lastActivation = [...draws].reverse().find(d => d.kind === "recurring_activation");
    const recurringActive = lastActivation ? !!lastActivation.active : false;
    const lastRecurring = [...draws].reverse().find(d => d.kind === "recurring_two_wheel");
    const lastTs = lastRecurring ? lastRecurring.ts : 0;
    LAST_RECURRING_TS = lastTs;
    CURRENT_FDV_USD = Number(lastRecurring?.prize?.fdvUsd || 0) || 0;
    let recurringActiveState = recurringActive;

    function renderMarketCap() {
        if (!marketCapEl) return;
        if (Number.isFinite(CURRENT_FDV_USD) && CURRENT_FDV_USD > 0) {
            marketCapEl.textContent = `$${CURRENT_FDV_USD.toLocaleString()}`;
        } else {
            marketCapEl.textContent = "—";
        }
    }
    renderMarketCap();

    // Tiers to display:
    // Prefer tiers saved alongside the last recurring draw; else infer from latest tier_added event; else fallback to base.
    const tierAdded = draws.some(d => d.kind === "tier_added");
    const inferredBase = [500, 200, 100, 50, 10];
    const inferredWithBonus = [...inferredBase, 1000];

    let currentTiers =
        (lastRecurring?.prize?.tiers?.amounts) ? lastRecurring.prize.tiers.amounts
            : (tierAdded ? inferredWithBonus : inferredBase);

    // Weight mode (if stored); else default to 'balance'
    const weightMode =
        lastRecurring?.weightMode || "balance";

    // Fill basic UI
    const tickerElInit = document.getElementById("tokenTicker");
    const mintElInit = document.getElementById("tokenMint");
    if (tickerElInit) tickerElInit.textContent = SERVER_TOKEN_TICKER || "YOUR";
    if (mintElInit) mintElInit.textContent = SERVER_TOKEN_MINT || "set-in-.env";
    document.getElementById("recurringState").textContent = recurringActive ? "active" : "not active";
    document.getElementById("weightMode").textContent = weightMode;
    if (tiersTextEl) tiersTextEl.textContent = currentTiers.map(a => `$${a}`).join(" • ");

    // Countdown (auto-reads interval from keeper when available)
    function updateCountdown() {
      const cdEl = document.getElementById("countdown");
      const active = SERVER_ACTIVE || recurringActiveState;
      if (!active) { if (cdEl) cdEl.textContent = "—"; return; }

      let nextAt = 0;
      if (SERVER_NEXT_AT > 0) {
        nextAt = SERVER_NEXT_AT - SERVER_TIME_SKEW;
      } else {
        const base = (SERVER_LAST_TS || LAST_RECURRING_TS || Date.now());
        nextAt = base + DRAW_PERIOD_MS;
      }

      const rawDelta = nextAt - Date.now();
      // If we are way past zero (e.g., tab slept), force a keeper refresh and roll forward once.
      if (rawDelta < -15000) {
        // Try to refresh timing from keeper but don’t await here (keep UI responsive)
        loadIntervalFromKeeper().catch(()=>{});
        const base = (SERVER_LAST_TS || LAST_RECURRING_TS || Date.now());
        SERVER_NEXT_AT = base + DRAW_PERIOD_MS + SERVER_TIME_SKEW;
      }

      if (!Number.isFinite(rawDelta)) { if (cdEl) cdEl.textContent = "—"; return; }
      const delta = Math.max(0, rawDelta);
      const m = Math.floor(delta / 60000);
      const s = Math.floor((delta % 60000) / 1000);
      if (cdEl) cdEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

      // Arm a one-shot poll when we are at (or just passed) zero.
      // Use ~1.2s tolerance to absorb render/network skew; also handle missed intervals.
      if (!ZERO_ARMED && rawDelta <= 1200) {
        ZERO_ARMED = true;
        pollForNewDraw();
      } else if (!ZERO_ARMED && rawDelta < -3000) {
        ZERO_ARMED = true;
        pollForNewDraw();
      }
    }
    // Load interval/timing from keeper immediately and every 30s
    await loadIntervalFromKeeper();
    setInterval(async () => {
      try {
        await loadIntervalFromKeeper();
        updateActivationBanner();
      } catch (_) {}
    }, 30000);
    // Extra periodic keeper sync to keep nextAt fresh
    if (!window.__intervalSyncSet) {
      window.__intervalSyncSet = true;
      setInterval(async () => {
        try {
          await loadIntervalFromKeeper();
          updateActivationBanner();
        } catch(_){}
      }, 10000);
    }
    updateCountdown();
    setInterval(updateCountdown, 1000);

    // --- Milestones badges (100k, 500k, 1M, 5M) using latest known fdv if present ---
    const badgeHost = document.getElementById("milestoneBadges");
    const milestoneLevels = [
        { cap: 100_000, label: "$100k" },
        { cap: 500_000, label: "$500k" },
        { cap: 1_000_000, label: "$1M" },
        { cap: 5_000_000, label: "$5M" }
    ];
    if (badgeHost) {
        // Infer initial fdv from last draw (may be 0 on devnet)
        let fdv = 0;
        const lastWithFdv = [...draws].reverse().find(d => d?.prize && typeof d.prize.fdvUsd === "number");
        if (lastWithFdv) fdv = Number(lastWithFdv.prize.fdvUsd) || 0;
        badgeHost.innerHTML = "";
        for (const L of milestoneLevels) {
            const b = document.createElement("div");
            b.className = "badge " + (fdv >= L.cap ? "on" : "off");
            b.textContent = L.label;
            b.setAttribute('data-cap', String(L.cap));
            badgeHost.appendChild(b);
        }
    }

    // Populate the "View last tx" link from the most recent draw with a signature
    async function updateLastTxLink() {
        try {
            const latestDraws = await fetchFirstJSON([
                // when serving from app/web/
                "../state/draws.json",
                // when serving from app/
                "state/draws.json",
                // legacy path (project root)
                "app/state/draws.json",
                "../app/state/draws.json"
            ]) || [];
            if (!Array.isArray(latestDraws) || latestDraws.length === 0) {
                if (lastTxRow) lastTxRow.style.display = "none";
                return;
            }
            for (let i = latestDraws.length - 1; i >= 0; i--) {
                const d = latestDraws[i];
                if (d && d.sig) {
                    const sig = String(d.sig);
                    const url = `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`;
                    if (lastTxLink) {
                        const short = sig.length > 20 ? `${sig.slice(0, 10)}…${sig.slice(-10)}` : sig;
                        lastTxLink.href = url;
                        lastTxLink.textContent = `View ${short} on Explorer →`;
                    }
                    if (lastTxRow) lastTxRow.style.display = "";
                    return;
                }
            }
            if (lastTxRow) lastTxRow.style.display = "none";
        } catch (_) {
            if (lastTxRow) lastTxRow.style.display = "none";
        }
    }

    // Poll for new draw, tolerant and scoped inside IIFE
    async function pollForNewDraw(maxTries = 10, delayMs = 3000) {
        for (let i = 0; i < maxTries; i++) {
            // refresh server timing first
            await loadIntervalFromKeeper();
            // then reload draws.json from any served path
            const latest = await fetchFirstJSON([
                "../state/draws.json",
                "state/draws.json",
                "app/state/draws.json",
                "../app/state/draws.json"
            ]) || [];
            const newRecurrings = latest
                .filter(d => d && d.kind === "recurring_two_wheel" && Number(d.ts || 0) > LAST_RECURRING_TS)
                .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
            if (newRecurrings.length) {
                const latestTs = Number(newRecurrings[newRecurrings.length - 1].ts || 0);
                if (latestTs) LAST_RECURRING_TS = latestTs;
                const lastActivation = [...latest].reverse().find(d => d && d.kind === "recurring_activation");
                recurringActiveState = lastActivation ? !!lastActivation.active : false;
                const latestRegistry = await fetchFirstJSON([
                    "../state/registry.json",
                    "state/registry.json",
                    "app/state/registry.json",
                    "../app/state/registry.json"
                ]);
                if (Array.isArray(latestRegistry)) {
                    setRegistryList(latestRegistry);
                }
                renderRecent(latest);
                updateLastTxLink();
                ZERO_ARMED = false; // resume normal behavior
                updateCountdown();
                updateActivationBanner();
                for (const draw of newRecurrings) enqueueDrawAnimation(draw);
                return true;
            }
            await new Promise(r => setTimeout(r, delayMs));
        }
        ZERO_ARMED = false; // allow countdown to roll over if nothing found
        // Fallback: if we didn’t observe a new draw, roll the client timer forward once
        // so the UI doesn’t sit at 00:00. We keep listening for keeper updates via health.
        const base = (SERVER_LAST_TS || LAST_RECURRING_TS || Date.now());
        SERVER_LAST_TS = base; // keep last-known
        SERVER_NEXT_AT = base + DRAW_PERIOD_MS + SERVER_TIME_SKEW; // optimistic nextAt
        updateCountdown();
        return false;
    }

    // Fetch SOL & token prices from keeper API and update UI; dim milestones if FDV is zero
    async function updatePrices() {
        const urls = [
            'http://127.0.0.1:3000/api/price',
            'http://localhost:3000/api/price',
            '/api/price'
        ];
        for (const u of urls) {
            try {
                const r = await fetch(u, { cache: 'no-store' });
                if (!r.ok) continue;
                const j = await r.json();
                if (!j || !j.ok) continue;
                if (solPriceEl && Number.isFinite(j.solPriceUsd)) {
                    solPriceEl.textContent = Number(j.solPriceUsd).toFixed(2);
                }
                if (tokenPriceEl && j.token && Number.isFinite(j.token.priceUsd)) {
                    tokenPriceEl.textContent = Number(j.token.priceUsd).toFixed(6);
                }
                const fdv = (j.token && Number(j.token.fdvUsd)) || 0;
                if (Number.isFinite(fdv) && fdv > 0) {
                    CURRENT_FDV_USD = fdv;
                }
                if (milestonesBadgeEl) {
                    milestonesBadgeEl.classList.toggle('dimmed', !(fdv > 0));
                }
                // Update individual milestone badges (100k/500k/1M/5M) reactively
                if (milestonesBadgeEl && Number.isFinite(fdv)) {
                    const badges = milestonesBadgeEl.querySelectorAll('.badge[data-cap]');
                    badges.forEach(el => {
                        const cap = Number(el.getAttribute('data-cap') || '0');
                        const on = fdv >= cap;
                        el.classList.toggle('on', on);
                        el.classList.toggle('off', !on);
                    });
                }
                updateActivationBanner();
                renderMarketCap();
                return; // success
            } catch (_) { /* try next */ }
        }
        // If none succeeded, lightly dim the milestones to signal unknown state (optional)
        if (milestonesBadgeEl) milestonesBadgeEl.classList.add('dimmed');
    }

    function renderRecent(drawsArr) {
        const recent = document.getElementById("recent");
        if (!recent) return;
        recent.innerHTML = "";
        for (const d of (drawsArr || []).slice(-50).reverse()) {
            if (d.kind === "recurring_two_wheel") {
                const li = document.createElement("li");
                const when = new Date(d.ts).toLocaleString();
                const amt  = d?.prize?.amountUsd ?? "?";
                const addrMasked = (typeof d.winner === "string" && d.winner.length > 10)
                    ? `${d.winner.slice(0, 4)}…${d.winner.slice(-4)}`
                    : (d.winner || "—");
                const shortSig = (typeof d.sig === "string" && d.sig.length > 16)
                    ? `${d.sig.slice(0, 8)}…${d.sig.slice(-6)}`
                    : (d.sig || "tx");
                li.innerHTML = `
                  <span class="mono">${when}</span>
                  — <b>$${amt}</b>
                  → <code>${addrMasked}</code>
                  · <a target="_blank" href="https://solscan.io/tx/${d.sig}?cluster=devnet">${shortSig}</a>
                `;
                recent.appendChild(li);
            }
        }
    }
    // Winners lists
    renderRecent(draws);
    const ms = document.getElementById("milestones");
    for (const d of draws) {
        if (d.kind === "milestone_win") {
            const li = document.createElement("li");
            li.innerHTML = `$${(d.cap || 0).toLocaleString()} — <b>$${d.amountUsd}</b> → <code>${d.winner}</code> · <a target="_blank" href="https://solscan.io/tx/${d.sig}?cluster=devnet">tx</a>`;
            ms.appendChild(li);
        }
    }

    // Wheel visuals (preview only)
    function renderWheel(el, labels, palette) {
        try {
            // Clear any old elements we might have created previously
            el.querySelectorAll(".slice, .slice-label, svg.wheel-svg").forEach(n => n.remove());

            // Ensure el is a positioned container
            if (getComputedStyle(el).position === "static") {
                el.style.position = "relative";
            }

            const rect = el.getBoundingClientRect();
            const size = Math.min(rect.width, rect.height);
            const n = Math.max((labels && labels.length) ? labels.length : 0, 3);
            el.__sliceCount = n;
            const cx = size / 2;
            const cy = size / 2;
            const r  = size / 2;             // outer radius to the border
            const rText = r * 0.62;          // label radius

            // Create SVG container
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
            svg.setAttribute("class", "wheel-svg");

            // remove any old rotor and register this svg as the rotor we rotate
            if (el.__rotor && el.__rotor.parentNode === el) { el.removeChild(el.__rotor); }
            el.__rotor = svg;

            // Helper to create a wedge path from angle a0->a1 (degrees)
            const toRad = (deg) => (deg * Math.PI) / 180;
            function arcPath(a0, a1) {
                const large = (a1 - a0) % 360 > 180 ? 1 : 0;
                const x0 = cx + r * Math.cos(toRad(a0));
                const y0 = cy + r * Math.sin(toRad(a0));
                const x1 = cx + r * Math.cos(toRad(a1));
                const y1 = cy + r * Math.sin(toRad(a1));
                // Move to center -> line to arc start -> arc -> back to center -> close
                return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
            }

            const seg = 360 / n;
            const defaultColors = ["#94a3b8","#a78bfa","#60a5fa","#34d399","#f59e0b","#f472b6","#22d3ee","#f43f5e"];
            const colors = Array.isArray(palette) && palette.length ? palette : defaultColors;

            for (let i = 0; i < n; i++) {
                const a0 = -90 + i * seg;          // start at top (12 o'clock)
                const a1 = a0 + seg;

                // Wedge
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                path.setAttribute("d", arcPath(a0, a1));
                path.setAttribute("fill", colors[i % colors.length]);
                svg.appendChild(path);

                // Label (only for provided labels)
                if (labels && labels[i] != null) {
                    const mid = a0 + seg / 2;
                    const tx = cx + rText * Math.cos(toRad(mid));
                    const ty = cy + rText * Math.sin(toRad(mid));
                    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
                    text.setAttribute("x", tx);
                    text.setAttribute("y", ty);
                    text.setAttribute("text-anchor", "middle");
                    text.setAttribute("dominant-baseline", "middle");
                    text.setAttribute("font-size", "12");
                    text.setAttribute("font-weight", "600");
                    text.setAttribute("fill", "#0b0b11");
                    text.textContent = String(labels[i]);
                    // Keep text upright by rotating back
                    const rotate = mid + 90; // tangent orientation
                    text.setAttribute("transform", `rotate(${rotate} ${tx} ${ty}) rotate(${-rotate} ${tx} ${ty})`);
                    svg.appendChild(text);
                }
            }

            el.appendChild(svg);
        } catch (err) {
            console.error("renderWheel error:", err);
        }
    }

    function spinToSlice(rotorEl, sliceCount, targetIndex, onDone, fullTurns = SPIN_FULL_TURNS, duration = SPIN_DURATION_MS) {
        const seg = 360 / sliceCount;
        const finalDeg = fullTurns * 360 - (targetIndex + 0.5) * seg; // center of slice under the pointer at 12 o'clock
        rotorEl.style.transition = `transform ${duration}ms cubic-bezier(.25,.1,.25,1)`;
        requestAnimationFrame(() => {
            rotorEl.style.transform = `rotate(${finalDeg}deg)`;
        });
        function done() {
            rotorEl.removeEventListener('transitionend', done);
            // normalize transform to avoid precision drift
            const normalized = ((finalDeg % 360) + 360) % 360;
            rotorEl.style.transition = 'none';
            rotorEl.style.transform = `rotate(${normalized}deg)`;
            requestAnimationFrame(() => { rotorEl.style.transition = ''; });
            if (onDone) onDone(targetIndex);
        }
        rotorEl.addEventListener('transitionend', done);
    }

    // Amount Wheel
    const amountWheel = document.getElementById("amountWheel");
    const amountPalette = ["#0ea5e9","#22c55e","#f59e0b","#ef4444","#8b5cf6","#06b6d4"];
    let amountLabels = [];

    function setTiers(newTiers) {
        if (Array.isArray(newTiers) && newTiers.length) {
            currentTiers = newTiers.slice();
        }
        amountLabels = (Array.isArray(currentTiers) && currentTiers.length)
            ? currentTiers.map(v => `$${v}`)
            : ["—"];
        renderWheel(amountWheel, amountLabels, amountPalette);
        if (tiersTextEl) {
            tiersTextEl.textContent = (Array.isArray(currentTiers) && currentTiers.length)
                ? currentTiers.map(a => `$${a}`).join(" • ")
                : "—";
        }
    }
    setTiers(currentTiers);

    const amountResult = document.getElementById("amountResult");
    const amountBanner = document.getElementById("amountBanner");
    const spinAmountBtn = document.getElementById("spinAmount");
    if (spinAmountBtn) spinAmountBtn.remove();

    // Wallet Wheel
    const mask = (w) => (typeof w === "string" && w.length > 8) ? (w.slice(0, 4) + "…" + w.slice(-4)) : String(w);
    const walletWheel = document.getElementById("walletWheel");
    const walletPalette = ["#06b6d4","#22c55e","#f59e0b","#ef4444","#8b5cf6","#a3e635","#f472b6","#10b981","#3b82f6","#eab308"];
    let walletLabels = [];

    function setRegistryList(newList) {
        if (Array.isArray(newList)) {
            registry = newList.slice();
        } else if (!Array.isArray(registry)) {
            registry = [];
        }
        walletLabels = registry.length ? registry.map(mask) : ["No wallets yet", "—"];
        renderWheel(walletWheel, walletLabels, walletPalette);
    }
    setRegistryList(registry);

    const walletResult = document.getElementById("walletResult");
    const walletBanner = document.getElementById("walletBanner");
    const spinWalletBtn = document.getElementById("spinWallet");
    if (spinWalletBtn) spinWalletBtn.remove();

    function setBanner(el, text) {
        if (!el) return;
        if (text) {
            el.textContent = text;
            el.classList.add("show");
        } else {
            el.textContent = "";
            el.classList.remove("show");
        }
    }

    function updateActivationBanner() {
        const cap = (Number.isFinite(SERVER_START_CAP) && SERVER_START_CAP > 0)
            ? SERVER_START_CAP
            : 100_000;
        const active = SERVER_ACTIVE || recurringActiveState || (LAST_RECURRING_TS > 0);
        if (active) {
            setBanner(amountBanner, "");
            setBanner(walletBanner, "");
            setBanner(activationNotice, "");
            renderMarketCap();
            return;
        }
        const capText = `$${cap.toLocaleString()}`;
        const fdvText = (Number.isFinite(CURRENT_FDV_USD) && CURRENT_FDV_USD > 0)
            ? `$${CURRENT_FDV_USD.toLocaleString()}`
            : null;
        let message = `Wheels unlock at ${capText} market cap.`;
        if (fdvText) message += ` Current FDV: ${fdvText}.`;
        setBanner(amountBanner, "");
        setBanner(walletBanner, "");
        setBanner(activationNotice, message);
        renderMarketCap();
    }

    updateActivationBanner();

    function playDrawAnimation(draw, onDone) {
        const finish = typeof onDone === "function" ? onDone : () => {};
        if (!draw || typeof draw !== "object") { finish(); return; }

        const drawTiers = draw?.prize?.tiers?.amounts;
        if (Array.isArray(drawTiers) && drawTiers.length) {
            setTiers(drawTiers);
        } else {
            setTiers(currentTiers);
        }

        const fdvFromDraw = Number(draw?.prize?.fdvUsd);
        if (Number.isFinite(fdvFromDraw) && fdvFromDraw > 0) {
            CURRENT_FDV_USD = fdvFromDraw;
        }
        recurringActiveState = true;
        updateActivationBanner();
        renderMarketCap();

        const amountUsd = Number(draw?.prize?.amountUsd);
        const amountSliceCount = amountWheel.__sliceCount || amountLabels.length;
        const amountIndex = Array.isArray(currentTiers)
            ? currentTiers.findIndex(v => Number(v) === amountUsd)
            : -1;

        const winner = typeof draw?.winner === "string" ? draw.winner : null;
        const walletSliceCount = walletWheel.__sliceCount || walletLabels.length;
        const winnerIdx = winner && Array.isArray(registry) ? registry.indexOf(winner) : -1;

        const startWalletSpin = () => {
            if (winnerIdx >= 0 && walletSliceCount) {
                const target = Math.min(Math.max(winnerIdx, 0), walletSliceCount - 1);
                const rotor = walletWheel.__rotor || walletWheel;
                spinToSlice(rotor, walletSliceCount, target, (idx) => {
                    const picked = walletLabels[idx] || mask(winner);
                    if (walletResult) walletResult.textContent = `Selected: ${picked}`;
                    finish();
                });
            } else if (walletResult) {
                walletResult.textContent = winner ? `Selected: ${mask(winner)}` : "Selected: —";
                finish();
            } else {
                finish();
            }
        };

        if (amountIndex >= 0 && amountSliceCount) {
            const target = Math.min(Math.max(amountIndex, 0), amountSliceCount - 1);
            const rotor = amountWheel.__rotor || amountWheel;
            spinToSlice(rotor, amountSliceCount, target, () => {
                const picked = amountLabels[target] || `$${amountUsd}`;
                if (amountResult) amountResult.textContent = `Selected: ${picked}`;
                startWalletSpin();
            });
        } else {
            if (amountResult) {
                amountResult.textContent = amountUsd ? `Selected: $${amountUsd}` : "Selected: —";
            }
            startWalletSpin();
        }
    }

    const animationQueue = [];
    let animationActive = false;

    function runNextAnimation() {
        if (!animationQueue.length) {
            animationActive = false;
            return;
        }
        animationActive = true;
        const nextDraw = animationQueue.shift();
        playDrawAnimation(nextDraw, runNextAnimation);
    }

    function enqueueDrawAnimation(draw) {
        if (!draw) return;
        animationQueue.push(draw);
        if (!animationActive) runNextAnimation();
    }

    // --- "Check my wallet" form logic ---
    (function setupCheckForm(){
        const btn = document.getElementById("checkBtn");
        const input = document.getElementById("checkAddr");
        const out = document.getElementById("checkResult");
        if (!btn || !input || !out) return;

        async function verify(addr) {
            out.textContent = "Checking…";
            try {
                const apiUrl = `http://127.0.0.1:3000/api/verify?addr=${encodeURIComponent(addr)}`;
                const res = await fetch(apiUrl, { cache: "no-store" });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.ok) {
                        const p = data.proof || {};
                        out.textContent = p.included
                            ? `✅ Included. Winner: ${p.winner === addr ? "YES" : "No"}${p.winner ? " ("+p.winner+")" : ""}. Seed: ${p.rng?.seed || "n/a"}.`
                            : `❌ Not included in last draw set. Seed: ${p.rng?.seed || "n/a"}.`;
                        return;
                    }
                }
                // fall through to offline check if API didn't return ok
            } catch (e) {
                // ignore and fallback offline
            }
            // Offline fallback using the already-loaded registry.json
            const isIn = Array.isArray(registry) && registry.includes(addr);
            out.textContent = isIn
                ? "✅ Address is in current registry (offline check)."
                : "❌ Address not found in registry (offline check).";
        }

        btn.addEventListener("click", () => {
            const addr = (input.value || "").trim();
            if (!addr) { out.textContent = "Please enter a wallet address."; return; }
            verify(addr);
        });
    })();

    // Initialize and refresh the last tx link every 20s
    updateLastTxLink();
    setInterval(updateLastTxLink, 20000);

    // Initialize and refresh prices every 30s
    updatePrices();
    setInterval(updatePrices, 30000);
})();

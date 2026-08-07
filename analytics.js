/* onlycars-app.com analytics and App Store attribution.
 *
 * One file, loaded by every page, so there is a single source of truth and
 * still no build step.
 *
 * This is a copy of the same file in the koalaloop-site repo. The two sites are
 * separate deployments but report into ONE Umami property, so WEBSITE_ID must
 * match there. Umami records the hostname per event, so the funnel stays
 * unified and can still be split by domain. Keep the two copies in sync.
 *
 * Three jobs:
 *   1. Load Umami (cookieless, aggregate, no consent banner required).
 *   2. Remember how a visitor arrived, across pages, for this tab only.
 *   3. Stamp that source onto every App Store link as Apple's `ct` campaign
 *      token, so installs can be traced back to the channel.
 *
 * Why (3) matters: referrers are unreliable for exactly the sources we care
 * about. TikTok, Instagram and other in-app browsers routinely strip or mangle
 * the referrer, so channel traffic lands in a "direct" bucket and disappears.
 * The only dependable signal is a UTM tag on a link we control. Tag the link
 * you post, and this carries the value through to App Store Connect.
 *
 * All three are gated on the visitor not having opted out via Do Not Track or
 * Global Privacy Control. Opting out disables the storage and the `ct` stamping
 * too, not just the Umami load, so an opted-out visitor cannot reach Apple's
 * campaign reporting either.
 *
 * Everything here degrades to a no-op. If Umami is unconfigured or blocked,
 * links still work and nothing throws.
 */
(function () {
  "use strict";

  // --- config -------------------------------------------------------------
  // Set WEBSITE_ID to the id from Umami Cloud (Settings -> Websites -> Edit).
  // Use the SAME id as koalaloop.games so both sites report into one property.
  // Until it is a real id, no analytics script loads and the rest still runs.
  var WEBSITE_ID = "080c87ab-8a6b-497a-a69e-601952d380f2";
  var SCRIPT_SRC = "https://cloud.umami.is/script.js";

  var STORE_HOST = "apps.apple.com";
  var STORE_KEY = "kl_src";  // sessionStorage: the channel a visitor arrived from
  var CAMP_KEY = "kl_camp";  // sessionStorage: the campaign, if the link carried one

  /* Apple's provider token. A campaign link needs BOTH pt and ct to show up in
   * App Store Connect Analytics; ct on its own is silently dropped:
   * https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links/
   *
   * Leave "" if the App Store URL you paste into each page is a real
   * ASC-generated campaign link, since those already carry pt. Set it only when
   * you are building store URLs by hand. Until a pt is available from one of
   * those two places, this file deliberately does NOT write a ct, so no link
   * ever looks attributed when Apple would ignore it. Clicks are still counted
   * in Umami and tagged attribution="missing-pt". */
  var PROVIDER_TOKEN = "";

  // --- helpers ------------------------------------------------------------
  function session(key, value) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key);
      window.sessionStorage.setItem(key, value);
    } catch (e) {
      // Safari private mode and similar. Attribution degrades to per-page.
    }
    return null;
  }

  function track(name, data) {
    try {
      if (window.umami && typeof window.umami.track === "function") {
        window.umami.track(name, data || {});
      }
    } catch (e) {
      /* never let instrumentation break a click */
    }
  }

  /* Apple campaign tokens travel in a URL and show up as-is in App Store
   * Connect, so keep them short and boring: lowercase alphanumerics, dash and
   * underscore only. Anything else is stripped rather than escaped, because a
   * mangled token is harder to read in a report than a truncated one. */
  function cleanToken(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  /* Derive a channel from the referrer. Deliberately coarse: this is a
   * fallback for when no UTM tag is present, and it is wrong often enough
   * that a precise-looking value would be misleading. */
  function channelFromReferrer(ref) {
    if (!ref) return "";
    var h;
    try {
      h = new URL(ref).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
    if (h === location.hostname) return ""; // internal navigation
    if (/tiktok/.test(h)) return "tiktok";
    if (/instagram/.test(h)) return "instagram";
    if (/(facebook|fb\.)/.test(h)) return "facebook";
    if (/(twitter|x\.com|t\.co)/.test(h)) return "twitter";
    if (/reddit/.test(h)) return "reddit";
    if (/youtube|youtu\.be/.test(h)) return "youtube";
    if (/pinterest/.test(h)) return "pinterest";
    if (/google/.test(h)) return "google";
    if (/bing|duckduckgo|ecosia/.test(h)) return "search";
    if (/apple\.com/.test(h)) return "appstore";
    return cleanToken(h);
  }

  /* Has the visitor asked not to be tracked?
   *
   * Global Privacy Control is the modern successor to Do Not Track and is
   * legally recognised under several US state privacy laws, so honour both.
   *
   * This gates the WHOLE file, not just the Umami load. Passing DNT through to
   * Umami alone would still leave the first-party half running: sessionStorage
   * would be written and the `ct` campaign token would still be stamped onto
   * App Store links, so an opted-out visitor would keep showing up in Apple's
   * campaign reporting. The privacy page promises nothing is recorded, and
   * that promise has to be true of the outbound link too. */
  function hasOptedOut() {
    try {
      if (navigator.globalPrivacyControl === true) return true;
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      return dnt === "1" || dnt === "yes";
    } catch (e) {
      return false;
    }
  }

  // --- 1. honour the opt-out before doing anything at all -----------------
  if (hasOptedOut()) {
    window.klSource = "opted-out";
    return; // no script, no storage, no ct. Links still work untouched.
  }

  // --- 2. resolve the arrival source, once per tab ------------------------
  var params = new URLSearchParams(location.search);
  var utm = cleanToken(params.get("utm_source"));
  var campaign = cleanToken(params.get("utm_campaign"));

  /* A UTM on the current URL always wins and starts fresh attribution for the
   * tab: it is the only signal we control. Otherwise reuse whatever this tab
   * already resolved, so attribution survives the hop from / to privacy.html.
   * Referrer is the last resort.
   *
   * Source and campaign are stored as a pair. Persisting only the source drops
   * the campaign on the second page, which silently shortens the `ct` token and
   * makes two different campaigns look identical in App Store Connect. */
  var source, campaignFinal;
  if (utm) {
    source = utm;
    campaignFinal = campaign;
    session(STORE_KEY, source);
    session(CAMP_KEY, campaignFinal); // may be "", which clears a stale campaign
  } else {
    source = session(STORE_KEY) || channelFromReferrer(document.referrer) || "direct";
    campaignFinal = session(CAMP_KEY) || "";
    session(STORE_KEY, source);
  }

  var token = campaignFinal ? source + "-" + campaignFinal : source;

  // --- 3. load Umami ------------------------------------------------------
  if (WEBSITE_ID) {
    var s = document.createElement("script");
    s.defer = true;
    s.src = SCRIPT_SRC;
    s.setAttribute("data-website-id", WEBSITE_ID);
    // Belt and braces: we already bail out above, but if our detection ever
    // misses a signal, Umami's own handling still catches it.
    s.setAttribute("data-do-not-track", "true");
    document.head.appendChild(s);
  }

  // --- 4. stamp App Store links and record the click ----------------------
  function isStoreLink(a) {
    if (!a || !a.getAttribute) return false;
    var href = a.getAttribute("href") || "";
    if (href.indexOf("apps.apple.com") === -1) return false;
    try {
      return new URL(a.href, location.href).hostname === STORE_HOST;
    } catch (e) {
      return false;
    }
  }

  /* Rewrite `ct` at click time rather than on load. The store links on these
   * pages are armed later by each page's own APP_STORE_URL script, so anything
   * stamped during page load would be overwritten. */
  function stampAndTrack(a) {
    var url;
    try {
      url = new URL(a.href, location.href);
    } catch (e) {
      return;
    }

    /* Read the hand-written ct from the anchor's dataset, never from the live
     * href. This function rewrites a.href, so on any second click the href
     * already carries the stamped token. Treating that as the base appends
     * again and the campaign bucket drifts with every click:
     *   web -> web-tiktok-aug -> web-tiktok-aug-tiktok-aug -> ...
     * A Cmd/Ctrl-click or middle-click leaves the page open, so this is
     * reachable in normal use, and each click lands in a different ASC bucket.
     * Capture the original once, then always recompute from it. */
    var base = a.getAttribute("data-base-ct");
    if (base === null) {
      base = url.searchParams.get("ct") || "";
      a.setAttribute("data-base-ct", base);
    }

    /* Preserve that hand-written ct (for example ?ct=web-preview) by appending
     * rather than replacing, so a deliberate per-placement token is not lost
     * to whatever channel the visitor happened to arrive from. */
    var existing = cleanToken(base);
    var finalToken = existing && existing !== token
      ? cleanToken(existing + "-" + token)
      : token;

    /* Apple needs BOTH a provider token and a campaign token for a campaign to
     * appear in App Store Connect Analytics:
     * https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links/
     * Writing ct without pt produces a link that looks instrumented while ASC
     * silently omits the campaign, which is worse than no stamping at all
     * because it reads as working. So only stamp when a pt is actually
     * available, either already on the ASC-generated URL or configured above. */
    var provider = url.searchParams.get("pt") || PROVIDER_TOKEN;
    var armed = !!provider;

    if (armed) {
      url.searchParams.set("pt", provider);
      url.searchParams.set("ct", finalToken);
      a.href = url.toString();
    }

    /* Record the click either way: the Umami side is independent of Apple's
     * reporting, and `attribution` makes a missing pt visible in the dashboard
     * rather than something you discover from an empty ASC report weeks later. */
    track("appstore-click", {
      app: /id(\d+)/.test(url.pathname) ? RegExp.$1 : "unknown",
      source: source,
      ct: armed ? finalToken : "",
      attribution: armed ? "armed" : "missing-pt",
      page: location.pathname
    });
  }

  document.addEventListener(
    "click",
    function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest("a") : null;
      if (isStoreLink(a)) stampAndTrack(a);
    },
    true // capture, so the href is rewritten before navigation begins
  );

  // Expose the resolved source for debugging: `window.klSource` in the console.
  window.klSource = source;
})();

'use strict';

// Routing policy for release-bearing emails (categories 2, 3, 4): which Discord
// channel a post goes to, and whether it pings @everyone.
//
// All channel/ping decisions live here so new routing rules — additional
// channels, time-based muting, per-category overrides — have a single home.
// notify.js is a dumb transport: it posts whatever this returns. Operational
// alerts (categories 5, 6) are not routed here; they always go to the fixed
// alerts webhook and never ping.
function routeFor(analysis, config) {
  const webhook = analysis.is_regional
    ? config.discord_regional_webhook_url
    : config.discord_releases_webhook_url;

  // @everyone is reserved for imminent rare/allocated drops from a roster brand
  // (see roster.js / the classifier), and only on the national channel —
  // regional drops never ping the whole server.
  const pingEveryone = !!analysis.is_ping_worthy_imminent && !analysis.is_regional;

  return { webhook, pingEveryone };
}

module.exports = { routeFor };

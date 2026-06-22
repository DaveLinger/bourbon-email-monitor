'use strict';

// @everyone ping roster — the single source of truth for who gets pinged.
// Edit freely; it's injected into the classifier's system prompt at startup,
// so the LLM matches each email against it (and resolves nicknames/variants).
//
//   ping: false      → never @everyone for this brand, whatever the bottle
//   ping: true       → @everyone for rare/allocated drops
//     triggers: []   → bottles that SHOULD ping (allocated/rare)
//     excludes: []   → standard-lineup bottles that should NOT ping
//
// For a `ping: true` brand, a bottle named in neither list is left to the LLM's
// judgment (ping only if it's clearly a rare/allocated/limited release).
//
// Brands NOT listed here never ping — you must opt a brand in.
// The ping also only fires for IMMEDIATE releases (available now) and only on
// the national channel; future announcements and regional-only drops never ping
// (enforced in routing.js / the classifier, not here).

module.exports = {
  "Wild Turkey / Russell's Reserve": {
    ping: true,
    triggers: ["Master's Keep", "Russell's Reserve 13", "Russell's Reserve 15", 'Austin Nichols Archive (Gold Foil)', 'Diamond Anniversary'],
    excludes: ['Wild Turkey 101', 'Wild Turkey 81', 'Longbranch', 'standard Rare Breed', 'American Honey', "standard Russell's Reserve 10yr / 6yr Rye"],
  },

  'Old Forester': {
    ping: true,
    triggers: ["President's Choice", 'Birthday Bourbon'],
    excludes: ['single barrel', '1924', '117 Series'],
  },

  'Buffalo Trace': {
    ping: true,
    triggers: [
      'Buffalo Trace Antique Collection (BTAC)',
      'Van Winkle / Pappy',
      'George T. Stagg / Stagg',
      'Weller (rare/allocated)',
      'E.H. Taylor (rare/allocated releases)',
      'Eagle Rare (rare/allocated releases)',
    ],
    excludes: [
      'Weller Special Reserve', 'Weller Antique 107',
      'E.H. Taylor Small Batch', 'Eagle Rare 10', "Blanton's single barrel",
    ],
  },

  'Old Elk': { ping: false },
  'Smooth Ambler': { ping: false },
};

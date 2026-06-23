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
    triggers: ["Master's Keep", "Russell's Reserve 13", "Russell's Reserve 15", 'Austin Nichols Archive (Gold Foil)', 'Diamond Anniversary', 'Single Rickhouse'],
    excludes: ['Wild Turkey 101', 'Wild Turkey 81', 'Longbranch', 'standard Rare Breed', 'American Honey', "standard Russell's Reserve 10yr / 6yr Rye"],
  },

  'Old Forester': {
    ping: true,
    triggers: ["President's Choice", 'Birthday Bourbon'],
    excludes: ['single barrel', '1924', '117 Series'],
  },

  'Heaven Hill / Elijah Craig / Old Fitzgerald': {
    ping: true,
    triggers: ['Elijah Craig 21', 'Old Fitzgerald Decanter', 'Heaven Hill 22', 'Heaven Hill 90th', 'Heaven Hill Distillers Unity', 'Parkers Heritage Collection'],
    excludes: ['Elijah Craig 12', 'Elijah Craig 15', 'Old Fitzgerald 7', 'Larceny', 'Bernheim'],
  },

  'Kentucky Peerless': {
    ping: true,
    triggers: ["Peerless 10 Henry Kraver's Old Reserve", 'Peerless 12', 'Peerless 15'],
    excludes: ['Peerless Single Barrel', 'Peerless Small Batch', 'Peerless Toasted Barrel'],
  },

  'Star Hill Farm / Makers Mark': {
    ping: true,
    triggers: ['Makers Mark Cellar Aged', 'Star Hill Farm Wheat Whisky'],
    excludes: ['Makers Mark Wood Finishing Series', 'Makers Mark Cask Strength', 'Makers Mark 46'],
  },

  'Jack Daniels': {
    ping: true,
    triggers: ['Jack Daniels 14 year', 'Jack Daniels Special Release', 'Coy Hill'],
    excludes: ['Jack Daniels Old Number 7', 'Gentleman Jack', 'Jack Daniels Single Barrel', 'Heritage Barrel'],
  },

  'Buffalo Trace': {
    ping: true,
    triggers: [
      'Buffalo Trace Antique Collection (BTAC)',
      'Van Winkle / Pappy',
      'George T. Stagg / Stagg',
      'Weller (rare/allocated - Single Barrel, CYPB, Weller 12))',
      'E.H. Taylor (rare/allocated - Barrel Proof Rye, Cured Oak, Four Grain)',
      'Eagle Rare (rare/allocated - 12 year, 20 year, etc)',
    ],
    excludes: [
      'Weller Special Reserve', 'Weller Antique 107',
      'E.H. Taylor Small Batch', 'Eagle Rare 10', "Blanton's single barrel",
    ],
  }

};

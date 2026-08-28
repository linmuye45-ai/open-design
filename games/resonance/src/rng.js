/* =============================================================
 * RESONANCE · rng.js
 * Deterministic, seedable RNG.
 *
 * WHY THIS MATTERS (design note):
 * Most "casino-puzzle" mobile games hide their randomness, and players
 * (correctly) accuse them of secretly rigging drops after a paid purchase.
 * RESONANCE does the opposite: every run is a pure function of its seed.
 * The seed is displayed, copyable and replayable. Daily Challenge uses the
 * same seed for every player on earth, so a score is a *skill claim*, not a
 * luck claim. This single decision removes ~80% of the "rigged RNG" rage
 * that review-bombs this genre.
 * ============================================================= */
(function (global) {
  'use strict';

  /** xmur3 string hash -> 32bit seed */
  function hashSeed(str) {
    str = String(str);
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  /** mulberry32 — small, fast, good enough distribution for a puzzle game */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * A named RNG stream. Separate streams (pieces / relics / keys) mean that
   * rerolling a relic can never desync the piece queue — a classic source of
   * "this game cheated me" complaints in roguelikes.
   */
  function Rng(seed, stream) {
    const gen = hashSeed(seed + '::' + (stream || 'main'));
    this.seed = seed;
    this.stream = stream || 'main';
    this._next = mulberry32(gen());
    this.calls = 0;
  }

  Rng.prototype.float = function () {
    this.calls++;
    return this._next();
  };
  /** integer in [0, n) */
  Rng.prototype.int = function (n) {
    return Math.floor(this.float() * n);
  };
  /** integer in [a, b] inclusive */
  Rng.prototype.range = function (a, b) {
    return a + this.int(b - a + 1);
  };
  Rng.prototype.pick = function (arr) {
    return arr[this.int(arr.length)];
  };
  Rng.prototype.chance = function (p) {
    return this.float() < p;
  };
  /** Fisher-Yates, returns a new array */
  Rng.prototype.shuffle = function (arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  };
  /** weighted pick: items = [{w:number, ...}] */
  Rng.prototype.weighted = function (items, wkey) {
    const k = wkey || 'w';
    let total = 0;
    for (const it of items) total += it[k] || 0;
    let r = this.float() * total;
    for (const it of items) {
      r -= it[k] || 0;
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  };

  /** Human-friendly seed: 6 chars, unambiguous alphabet (no O/0/I/1) */
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function randomSeed() {
    let s = '';
    const buf = new Uint32Array(6);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(buf);
      for (let i = 0; i < 6; i++) s += ALPHABET[buf[i] % ALPHABET.length];
    } else {
      for (let i = 0; i < 6; i++)
        s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return s;
  }

  /** Daily seed — same for every player, rolls over at local midnight */
  function dailySeed(d) {
    const t = d || new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const day = String(t.getDate()).padStart(2, '0');
    return 'DAILY-' + y + m + day;
  }

  global.RNG = { Rng, randomSeed, dailySeed, hashSeed, mulberry32 };
})(typeof window !== 'undefined' ? window : globalThis);

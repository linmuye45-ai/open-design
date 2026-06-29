/* =====================================================================
 * 锦鲤棋牌 · 斗地主规则引擎 (rules.js)
 * 纯函数、无副作用，便于测试与 AI 复用。
 * 牌值约定：3..10 -> 3..10, J=11, Q=12, K=13, A=14, 2=15, 小王=16, 大王=17
 * 牌对象：{ id, rank, suit }  suit: 'S' 黑桃 'H' 红桃 'C' 梅花 'D' 方块 'J' 王
 * ===================================================================== */
(function (global) {
  'use strict';

  const RANK_NAME = {
    3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '🃏', 17: '🃏'
  };
  const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦', J: '' };

  /* 生成一副完整斗地主牌（54 张） */
  function createDeck() {
    const deck = [];
    let id = 0;
    const suits = ['S', 'H', 'C', 'D'];
    for (let rank = 3; rank <= 15; rank++) {
      for (const suit of suits) {
        deck.push({ id: id++, rank, suit });
      }
    }
    deck.push({ id: id++, rank: 16, suit: 'J' }); // 小王
    deck.push({ id: id++, rank: 17, suit: 'J' }); // 大王
    return deck;
  }

  /* 洗牌（Fisher-Yates）。可传入随机种子函数以保证可复现。 */
  function shuffle(deck, rng) {
    rng = rng || Math.random;
    const a = deck.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* 发牌：3 名玩家各 17 张，3 张地主牌 */
  function deal(rng) {
    const deck = shuffle(createDeck(), rng);
    const hands = [[], [], []];
    for (let i = 0; i < 51; i++) {
      hands[i % 3].push(deck[i]);
    }
    const bottom = deck.slice(51, 54);
    hands.forEach(sortHand);
    return { hands, bottom };
  }

  /* 手牌排序：从大到小（便于展示与出牌） */
  function sortHand(hand) {
    hand.sort((a, b) => b.rank - a.rank || suitOrder(b.suit) - suitOrder(a.suit));
    return hand;
  }
  function suitOrder(s) { return { J: 4, S: 3, H: 2, C: 1, D: 0 }[s] || 0; }

  function rankName(r) { return RANK_NAME[r] || String(r); }
  function suitSymbol(s) { return SUIT_SYMBOL[s] || ''; }

  /* ---------- 牌型识别 ----------
   * 返回 { type, key, len, bombLevel }
   * type: single/pair/trio/trio_one/trio_pair/straight/straight_pair/
   *       plane/plane_one/plane_pair/four_two_single/four_two_pair/bomb/rocket/invalid
   * key:  用于同型比较的主牌值（越大越强）
   * len:  序列长度（用于顺子/连对/飞机匹配）
   * bombLevel: 0 普通牌；1 炸弹；2 王炸
   */
  function identify(cards) {
    if (!cards || cards.length === 0) return { type: 'invalid' };
    const cnt = countByRank(cards);
    const ranks = Object.keys(cnt).map(Number).sort((a, b) => a - b);
    const n = cards.length;

    // 王炸
    if (n === 2 && cnt[16] === 1 && cnt[17] === 1) {
      return { type: 'rocket', key: 100, len: 1, bombLevel: 2 };
    }
    // 单张
    if (n === 1) return { type: 'single', key: ranks[0], len: 1, bombLevel: 0 };
    // 对子
    if (n === 2 && ranks.length === 1 && cnt[ranks[0]] === 2)
      return { type: 'pair', key: ranks[0], len: 1, bombLevel: 0 };
    // 三张
    if (n === 3 && ranks.length === 1 && cnt[ranks[0]] === 3)
      return { type: 'trio', key: ranks[0], len: 1, bombLevel: 0 };
    // 炸弹
    if (n === 4 && ranks.length === 1 && cnt[ranks[0]] === 4)
      return { type: 'bomb', key: ranks[0], len: 1, bombLevel: 1 };
    // 三带一
    if (n === 4) {
      const trio = ranks.find(r => cnt[r] === 3);
      if (trio !== undefined && ranks.length === 2)
        return { type: 'trio_one', key: trio, len: 1, bombLevel: 0 };
    }
    // 三带一对
    if (n === 5) {
      const trio = ranks.find(r => cnt[r] === 3);
      const pair = ranks.find(r => cnt[r] === 2);
      if (trio !== undefined && pair !== undefined && ranks.length === 2)
        return { type: 'trio_pair', key: trio, len: 1, bombLevel: 0 };
    }
    // 顺子（>=5 单张连续，不含 2 和王）
    if (n >= 5 && ranks.length === n && isConsecutive(ranks) && ranks[ranks.length - 1] <= 14)
      return { type: 'straight', key: ranks[ranks.length - 1], len: n, bombLevel: 0 };
    // 连对（>=3 对连续，不含 2 和王）
    if (n >= 6 && n % 2 === 0 && ranks.every(r => cnt[r] === 2) &&
        isConsecutive(ranks) && ranks[ranks.length - 1] <= 14)
      return { type: 'straight_pair', key: ranks[ranks.length - 1], len: ranks.length, bombLevel: 0 };

    // 飞机系列：找连续的三张
    const trios = ranks.filter(r => cnt[r] >= 3).sort((a, b) => a - b);
    const planeGroups = longestConsecutive(trios.filter(r => r <= 14));
    if (planeGroups.length >= 2) {
      const m = planeGroups.length;
      // 纯飞机（无翅膀）
      if (n === m * 3 && ranks.every(r => cnt[r] === 3))
        return { type: 'plane', key: planeGroups[m - 1], len: m, bombLevel: 0 };
      // 飞机带单
      if (n === m * 4) {
        const tripleSum = planeGroups.reduce((s, r) => s + 3, 0);
        if (sumCounts(cnt) - tripleSum === m && allWingsValid(cnt, planeGroups, 1))
          return { type: 'plane_one', key: planeGroups[m - 1], len: m, bombLevel: 0 };
      }
      // 飞机带对
      if (n === m * 5) {
        if (allWingsValid(cnt, planeGroups, 2))
          return { type: 'plane_pair', key: planeGroups[m - 1], len: m, bombLevel: 0 };
      }
    }
    // 四带二单
    if (n === 6) {
      const four = ranks.find(r => cnt[r] === 4);
      if (four !== undefined) {
        const rest = sumCounts(cnt) - 4;
        if (rest === 2) return { type: 'four_two_single', key: four, len: 1, bombLevel: 0 };
      }
    }
    // 四带二对
    if (n === 8) {
      const four = ranks.find(r => cnt[r] === 4);
      const pairs = ranks.filter(r => cnt[r] === 2);
      if (four !== undefined && pairs.length === 2)
        return { type: 'four_two_pair', key: four, len: 1, bombLevel: 0 };
    }
    return { type: 'invalid' };
  }

  function allWingsValid(cnt, planeGroups, wingSize) {
    // 检查除三张主体外，剩余牌恰好构成 m 组 wingSize（1=单 2=对）
    const used = {};
    planeGroups.forEach(r => { used[r] = 3; });
    let wings = 0;
    for (const r in cnt) {
      const remain = cnt[r] - (used[r] || 0);
      if (remain === 0) continue;
      if (wingSize === 1) { wings += remain; }
      else { if (remain !== 2 && remain !== 0) return false; wings += remain / 2; }
    }
    return wings === planeGroups.length;
  }

  function countByRank(cards) {
    const c = {};
    for (const card of cards) c[card.rank] = (c[card.rank] || 0) + 1;
    return c;
  }
  function sumCounts(cnt) { return Object.values(cnt).reduce((a, b) => a + b, 0); }
  function isConsecutive(ranks) {
    for (let i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
    return true;
  }
  function longestConsecutive(arr) {
    if (arr.length === 0) return [];
    let best = [arr[0]], cur = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === arr[i - 1] + 1) cur.push(arr[i]);
      else cur = [arr[i]];
      if (cur.length > best.length) best = cur.slice();
    }
    return best;
  }

  /* ---------- 出牌合法性比较 ----------
   * 能否用 play 压过 last。last 为 null 表示自由出牌。
   */
  function canBeat(play, last) {
    if (play.type === 'invalid') return false;
    if (!last) return true; // 自由出牌，任意合法牌型
    // 王炸压一切
    if (play.type === 'rocket') return true;
    if (last.type === 'rocket') return false;
    // 炸弹规则
    if (play.type === 'bomb' && last.type !== 'bomb') return true;
    if (play.type === 'bomb' && last.type === 'bomb') return play.key > last.key;
    if (last.type === 'bomb') return false;
    // 普通牌：必须同型同长
    if (play.type !== last.type) return false;
    if (play.len !== last.len) return false;
    return play.key > last.key;
  }

  /* 牌型中文名（用于展示） */
  function typeName(t) {
    return {
      single: '单张', pair: '对子', trio: '三张', trio_one: '三带一', trio_pair: '三带二',
      straight: '顺子', straight_pair: '连对', plane: '飞机', plane_one: '飞机带单',
      plane_pair: '飞机带对', four_two_single: '四带二', four_two_pair: '四带两对',
      bomb: '炸弹', rocket: '王炸'
    }[t] || '';
  }

  global.Rules = {
    createDeck, shuffle, deal, sortHand, identify, canBeat,
    rankName, suitSymbol, typeName, countByRank
  };
})(typeof window !== 'undefined' ? window : globalThis);

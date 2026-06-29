/* =====================================================================
 * 锦鲤棋牌 · 斗地主游戏主控 (game.js)
 * 负责：状态机、回合调度、玩家交互、UI 渲染、特效、AI 调度、结算。
 * ===================================================================== */
(function (global) {
  'use strict';
  const R = global.Rules, AI = global.AI, S = global.Sound;

  // ---------- 全局配置（可在设置中修改） ----------
  const Config = {
    difficulty: 3,        // 1新手 2普通 3高手 4大师
    aiSpeed: 'normal',    // slow / normal / fast / instant
    soundOn: true,
    musicOn: true,
  };
  const SPEED_MS = { slow: 1600, normal: 900, fast: 450, instant: 120 };

  const AVATARS = ['assets/avatar_male.png', 'assets/avatar_female.png'];
  const AI_NAMES = ['老王', '春花', '老李', '秀英', '德彪', '凤霞'];

  // ---------- 段位数据（localStorage 持久化） ----------
  const RANKS = ['新手', '青铜', '白银', '黄金', '铂金', '钻石', '星耀', '王者'];
  function loadProfile() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem('jinli_profile')); } catch (e) {}
    if (!p) p = { coins: 8000, rankIdx: 1, star: 0, wins: 0, total: 0 };
    return p;
  }
  function saveProfile(p) { try { localStorage.setItem('jinli_profile', JSON.stringify(p)); } catch (e) {} }
  let profile = loadProfile();

  // ---------- 游戏状态 ----------
  let G = null;
  function newGameState() {
    return {
      hands: [[], [], []],   // 0=玩家本人  1=右上  2=左上
      bottom: [],
      landlord: -1,
      turn: 0,
      last: null,            // {info, cards, player}
      lastPlayer: -1,
      passCount: 0,
      phase: 'calling',      // calling -> playing -> over
      selected: new Set(),
      callValue: 0,          // 当前最高叫分
      callTurn: 0,
      callRecord: [],
      multiplier: 1,
      bombCount: 0,
      finished: false,
    };
  }

  // ---------- DOM 快捷 ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  function show(id) { $$('.screen').forEach(s => s.classList.remove('active')); $(id).classList.add('active'); }

  // ===================================================================
  // 启动 / 菜单
  // ===================================================================
  function initApp() {
    bindHome();
    bindSettings();
    refreshRankCard();
    S.setEnabled(Config.soundOn);
    S.setMusicOn(Config.musicOn);
  }

  function bindHome() {
    $('#btn-start').addEventListener('click', () => { S.init(); S.resume(); startMatch('rank'); });
    $('#btn-casual').addEventListener('click', () => { S.init(); S.resume(); startMatch('casual'); });
    $('#btn-settings').addEventListener('click', () => $('#settings-modal').classList.add('show'));
    $('#btn-howto').addEventListener('click', showHowTo);
  }

  function refreshRankCard() {
    $('#rank-name').textContent = RANKS[profile.rankIdx];
    $('#rank-star').textContent = '★'.repeat(profile.star) + '☆'.repeat(Math.max(0, 5 - profile.star));
    $('#rank-bar-fill').style.width = (profile.star / 5 * 100) + '%';
    $('#home-coins').textContent = profile.coins.toLocaleString();
    const wr = profile.total ? Math.round(profile.wins / profile.total * 100) : 0;
    $('#home-winrate').textContent = wr + '%';
  }

  // ===================================================================
  // 匹配动画
  // ===================================================================
  let matchMode = 'rank';
  function startMatch(mode) {
    matchMode = mode;
    show('#screen-match');
    $('#match-title').textContent = mode === 'rank' ? '排位匹配中' : '快速匹配中';
    const seats = $$('.match-seat');
    seats.forEach(s => s.classList.remove('found'));
    // 玩家自己立即出现
    seats[1].querySelector('img').src = AVATARS[0];
    seats[1].querySelector('.nm').textContent = '我';
    seats[1].classList.add('found');
    // 随机两名对手陆续加入
    const names = shuffleArr(AI_NAMES).slice(0, 2);
    const delays = [700 + Math.random() * 700, 1500 + Math.random() * 900];
    [0, 2].forEach((si, i) => {
      setTimeout(() => {
        seats[si].querySelector('img').src = AVATARS[(i + 1) % 2];
        seats[si].querySelector('.nm').textContent = names[i];
        seats[si].classList.add('found');
        S.select();
      }, delays[i]);
    });
    G = newGameState();
    G.aiNames = ['我', names[0], names[1]];
    setTimeout(() => startGame(), 2800);
  }

  // ===================================================================
  // 开局：发牌 + 叫地主
  // ===================================================================
  let canvas, cctx;
  function startGame() {
    show('#screen-game');
    setupCanvas();
    const deal = R.deal();
    G.hands = deal.hands;
    G.bottom = deal.bottom;
    G.phase = 'calling';
    G.callTurn = 0;
    G.callValue = 0;
    G.landlord = -1;
    G.multiplier = 1;
    G.bombCount = 0;
    S.setTension(0.15);
    if (Config.musicOn) S.startMusic();
    renderAll();
    // 发牌动画后进入叫分
    flash('开始发牌', 700);
    setTimeout(() => askCall(), 900);
  }

  function askCall() {
    if (G.callTurn >= 3 && G.callValue === 0) {
      // 无人叫分，重新发牌
      flash('无人叫地主，重新发牌', 1200);
      setTimeout(startGame, 1300);
      return;
    }
    const seat = G.callTurn % 3;
    if (seat === 0) {
      // 玩家叫分
      showCallPanel(true);
    } else {
      showCallPanel(false);
      const score = AI.evaluateCall(G.hands[seat]);
      // 难度影响叫分意愿
      let bid = 0;
      if (score >= 9) bid = 3; else if (score >= 6) bid = 2; else if (score >= 4) bid = 1;
      if (Config.difficulty <= 1) bid = Math.max(0, bid - 1);
      setTimeout(() => doCall(seat, bid > G.callValue ? bid : 0), aiDelay() * 0.7);
    }
  }

  function showCallPanel(visible) {
    const p = $('#call-panel');
    if (!visible) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    // 只允许叫比当前高的分
    $$('#call-panel .call-btn').forEach(b => {
      const v = Number(b.dataset.v);
      b.disabled = (v !== 0 && v <= G.callValue);
    });
  }

  function doCall(seat, value) {
    if (value > 0) { G.callValue = value; S.callLandlord(); showBubble(seat, value === 3 ? '叫地主!' : value + '分'); }
    else { showBubble(seat, '不叫'); }
    G.callRecord.push({ seat, value });
    G.callTurn++;
    showCallPanel(false);
    // 结束条件：有人叫3分，或一轮结束
    if (value === 3 || G.callTurn >= 3) {
      setTimeout(decideLandlord, 700);
    } else {
      setTimeout(askCall, 600);
    }
  }

  function decideLandlord() {
    // 找最高叫分者
    let best = -1, bestVal = 0;
    G.callRecord.forEach(r => { if (r.value > bestVal) { bestVal = r.value; best = r.seat; } });
    if (best === -1) { // 无人叫，重发
      flash('流局，重新发牌', 1200);
      setTimeout(startGame, 1300); return;
    }
    G.landlord = best;
    G.multiplier = bestVal;
    // 地主拿底牌
    G.hands[best] = R.sortHand(G.hands[best].concat(G.bottom));
    G.phase = 'playing';
    G.turn = best;
    G.last = null; G.lastPlayer = -1; G.passCount = 0;
    S.setTension(0.3);
    flash(best === 0 ? '你是地主！' : G.aiNames[best] + ' 是地主', 1300);
    renderAll();
    setTimeout(nextTurn, 1400);
  }

  // ===================================================================
  // 回合调度
  // ===================================================================
  function nextTurn() {
    if (G.phase !== 'playing') return;
    renderAll();
    updateTension();
    if (G.turn === 0) {
      // 玩家回合
      showActionBar(true);
      startTimer();
      refreshActionButtons();
    } else {
      showActionBar(false);
      stopTimer();
      setTimeout(() => aiMove(G.turn), aiDelay());
    }
  }

  function aiMove(seat) {
    if (G.phase !== 'playing' || G.turn !== seat) return;
    const isMyLead = (G.lastPlayer === seat || G.lastPlayer === -1);
    const ctx = {
      hand: G.hands[seat],
      last: isMyLead ? null : G.last.info,
      lastPlayerIsTeammate: isTeammate(seat, G.lastPlayer),
      myCardsLeft: G.hands[seat].length,
      oppMinLeft: Math.min(...[0, 1, 2].filter(i => i !== seat).map(i => G.hands[i].length)),
      oppIsEnemy: hasEnemyLow(seat),
    };
    const move = AI.decide(ctx, Config.difficulty);
    if (move) {
      applyPlay(seat, move.cards, move.info);
    } else {
      applyPass(seat);
    }
  }

  function isTeammate(a, b) {
    if (b < 0) return false;
    if (a === G.landlord || b === G.landlord) return false; // 一方是地主则非队友
    return a !== b; // 两个农民互为队友
  }
  function hasEnemyLow(seat) {
    // 是否有敌方玩家牌很少
    return [0, 1, 2].some(i => {
      if (i === seat) return false;
      const enemy = (seat === G.landlord) ? (i !== G.landlord) : (i === G.landlord);
      return enemy && G.hands[i].length <= 3;
    });
  }

  // ---------- 出牌 / 过牌 ----------
  function applyPlay(seat, cards, info) {
    // 移除手牌
    const ids = new Set(cards.map(c => c.id));
    G.hands[seat] = G.hands[seat].filter(c => !ids.has(c.id));
    G.last = { info, cards, player: seat };
    G.lastPlayer = seat;
    G.passCount = 0;

    // 音效 & 特效
    if (info.bombLevel === 2) { S.rocket(); G.multiplier *= 2; G.bombCount++; fxBig('王炸!'); }
    else if (info.bombLevel === 1) { S.bomb(); G.multiplier *= 2; G.bombCount++; fxBig('炸弹!'); }
    else { S.playCard(); }

    showPlayedCards(seat, cards, info);
    if (G.hands[seat].length === 1) { S.alertTone(); showBubble(seat, '只剩 1 张!'); }
    renderAll();

    if (G.hands[seat].length === 0) { return endGame(seat); }
    advance();
  }

  function applyPass(seat) {
    S.pass();
    showBubble(seat, '不要', true);
    G.passCount++;
    // 两家都过 -> 上一个出牌者重新领出
    if (G.passCount >= 2) {
      G.last = null;
      G.turn = G.lastPlayer;
      G.passCount = 0;
      clearPlayedCards();
      nextTurn();
      return;
    }
    advance();
  }

  function advance() {
    G.turn = (G.turn + 1) % 3;
    setTimeout(nextTurn, 350);
  }

  // ===================================================================
  // 玩家交互
  // ===================================================================
  function onCardClick(card) {
    if (G.phase !== 'playing' || G.turn !== 0) return;
    if (G.selected.has(card.id)) G.selected.delete(card.id);
    else G.selected.add(card.id);
    S.select();
    renderHand();
    refreshActionButtons();
  }

  function getSelectedCards() {
    return G.hands[0].filter(c => G.selected.has(c.id));
  }

  function refreshActionButtons() {
    const sel = getSelectedCards();
    const info = R.identify(sel);
    const isLead = (G.lastPlayer === 0 || G.lastPlayer === -1);
    const canPlay = sel.length > 0 && info.type !== 'invalid' &&
      (isLead ? true : R.canBeat(info, G.last.info));
    $('#btn-play').disabled = !canPlay;
    $('#btn-pass').disabled = isLead; // 自己领出不能过
    $('#btn-hint').disabled = false;
    // 牌型提示
    $('#play-typename').textContent = sel.length ? (info.type !== 'invalid' ? R.typeName(info.type) : '牌型错误') : '';
  }

  function playerPlay() {
    const sel = getSelectedCards();
    const info = R.identify(sel);
    const isLead = (G.lastPlayer === 0 || G.lastPlayer === -1);
    if (info.type === 'invalid') { toast('牌型不对哦'); return; }
    if (!isLead && !R.canBeat(info, G.last.info)) { toast('管不上，换一手吧'); return; }
    stopTimer();
    showActionBar(false);
    G.selected.clear();
    applyPlay(0, sel, info);
  }

  function playerPass() {
    if (G.lastPlayer === 0 || G.lastPlayer === -1) return;
    stopTimer();
    showActionBar(false);
    G.selected.clear();
    applyPass(0);
  }

  // 提示：高亮一手可出的牌
  let hintIdx = 0;
  function playerHint() {
    const isLead = (G.lastPlayer === 0 || G.lastPlayer === -1);
    const moves = AI.enumerateMoves(G.hands[0], isLead ? null : G.last.info);
    if (moves.length === 0) { toast('没有能出的牌，请过牌'); return; }
    const m = moves[hintIdx % moves.length]; hintIdx++;
    G.selected = new Set(m.cards.map(c => c.id));
    S.select();
    renderHand();
    refreshActionButtons();
  }

  // ===================================================================
  // 结算
  // ===================================================================
  function endGame(winner) {
    G.phase = 'over';
    G.finished = true;
    stopTimer();
    S.stopMusic();
    const playerWon = (winner === 0) || (winner !== G.landlord && G.landlord !== 0);
    const base = 100;
    const delta = base * G.multiplier;
    profile.total++;
    if (playerWon) { S.win(); profile.coins += delta; profile.wins++; }
    else { S.lose(); profile.coins = Math.max(0, profile.coins - delta); }
    // 排位星级
    if (matchMode === 'rank') {
      if (playerWon) { profile.star++; if (profile.star >= 5) { profile.star = 0; profile.rankIdx = Math.min(RANKS.length - 1, profile.rankIdx + 1); } }
      else { profile.star = Math.max(0, profile.star - 1); }
    }
    saveProfile(profile);
    setTimeout(() => showResult(playerWon, delta), 1100);
  }

  function showResult(won, delta) {
    show('#screen-result');
    const t = $('#result-title');
    t.textContent = won ? '胜 利' : '失 败';
    t.className = 'result-title ' + (won ? 'win' : 'lose');
    $('#result-detail').innerHTML =
      `身份：${G.landlord === 0 ? '地主' : '农民'}　倍数：×${G.multiplier}<br>` +
      `${won ? '获得' : '失去'} <span class="coin">${delta.toLocaleString()}</span> 金币<br>` +
      `当前段位：${RANKS[profile.rankIdx]}　${'★'.repeat(profile.star)}`;
    if (won) confetti();
  }

  // ===================================================================
  // 渲染
  // ===================================================================
  function setupCanvas() {
    canvas = $('#tableCanvas');
    cctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }
  function resizeCanvas() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTable();
  }
  const tableImg = new Image(); tableImg.src = 'assets/table_bg.png';
  tableImg.onload = () => drawTable();
  function drawTable() {
    if (!cctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    cctx.clearRect(0, 0, w, h);
    if (tableImg.complete && tableImg.naturalWidth) {
      // cover 绘制
      const ir = tableImg.naturalWidth / tableImg.naturalHeight, cr = w / h;
      let dw, dh, dx, dy;
      if (cr > ir) { dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2; }
      else { dh = h; dw = h * ir; dy = 0; dx = (w - dw) / 2; }
      cctx.drawImage(tableImg, dx, dy, dw, dh);
    } else {
      cctx.fillStyle = '#0d5a3f'; cctx.fillRect(0, 0, w, h);
    }
  }

  function renderAll() { drawTable(); renderSeats(); renderHand(); updateHud(); }

  function renderSeats() {
    // 对手信息
    [1, 2].forEach(seat => {
      const el = $(seat === 1 ? '#seat-right' : '#seat-left');
      el.querySelector('img').src = AVATARS[seat % 2];
      el.querySelector('.nm').textContent = G.aiNames[seat];
      el.querySelector('.cnt').textContent = G.hands[seat].length + ' 张';
      el.classList.toggle('landlord', G.landlord === seat);
      el.querySelector('.ll-badge').style.display = G.landlord === seat ? 'block' : 'none';
    });
    // 自己信息
    const me = $('#seat-self');
    me.querySelector('img').src = AVATARS[0];
    me.querySelector('.nm').textContent = '我';
    me.querySelector('.cnt').textContent = G.hands[0].length + ' 张';
    me.classList.toggle('landlord', G.landlord === 0);
    me.querySelector('.ll-badge').style.display = G.landlord === 0 ? 'block' : 'none';
  }

  function renderHand() {
    const handEl = $('#player-hand');
    handEl.innerHTML = '';
    G.hands[0].forEach(card => {
      handEl.appendChild(buildCardEl(card, true));
    });
  }

  // 构建一张牌的 DOM（始终完整显示牌面，扇形展开）
  function buildCardEl(card, interactive) {
    const el = document.createElement('div');
    el.className = 'card';
    const isRed = (card.suit === 'H' || card.suit === 'D');
    const isJoker = card.suit === 'J';
    if (isJoker) {
      el.classList.add(card.rank === 17 ? 'joker-red' : 'joker-black');
      el.innerHTML = `<div class="joker-label">
        <span style="font-size:1.5rem">🃏</span>
        <span style="font-size:.8rem;font-weight:900">${card.rank === 17 ? '大王' : '小王'}</span></div>`;
    } else {
      el.classList.add(isRed ? 'red-suit' : 'black-suit');
      const rn = R.rankName(card.rank), ss = R.suitSymbol(card.suit);
      el.innerHTML = `<div class="corner"><div class="r">${rn}</div><div class="s">${ss}</div></div>
        <div class="center-suit">${ss}</div>`;
    }
    if (G.selected.has(card.id)) el.classList.add('sel');
    if (interactive) el.addEventListener('click', () => onCardClick(card));
    return el;
  }

  function updateHud() {
    $('#hud-multiplier').textContent = '×' + G.multiplier;
    $('#hud-coins').textContent = profile.coins.toLocaleString();
    $('#hud-bomb').textContent = G.bombCount;
  }

  function updateTension() {
    const minLeft = Math.min(...G.hands.map(h => h.length || 99));
    let t = 0.3;
    if (minLeft <= 6) t = 0.55;
    if (minLeft <= 3) t = 0.8;
    if (minLeft <= 1) t = 1.0;
    t = Math.min(1, t + G.bombCount * 0.1);
    S.setTension(t);
  }

  // ===================================================================
  // 出牌展示 / 气泡 / 特效
  // ===================================================================
  const playedZones = { 0: { x: '50%', y: '64%' }, 1: { x: '78%', y: '40%' }, 2: { x: '22%', y: '40%' } };
  function showPlayedCards(seat, cards, info) {
    clearSeatPlayed(seat);
    const layer = $('#played-layer');
    const wrap = document.createElement('div');
    wrap.className = 'played-cards';
    wrap.dataset.seat = seat;
    const pos = playedZones[seat];
    wrap.style.cssText = `position:absolute;left:${pos.x};top:${pos.y};transform:translate(-50%,-50%);display:flex;z-index:6;`;
    cards.forEach((c, i) => {
      const mini = buildCardEl(c, false);
      mini.style.width = '40px'; mini.style.height = '58px'; mini.style.marginLeft = i ? '-16px' : '0';
      mini.style.animation = `dealIn .25s ${i * 0.03}s both`;
      wrap.appendChild(mini);
    });
    layer.appendChild(wrap);
  }
  function clearSeatPlayed(seat) {
    $$('#played-layer .played-cards').forEach(e => { if (Number(e.dataset.seat) === seat) e.remove(); });
  }
  function clearPlayedCards() { $('#played-layer').innerHTML = ''; }

  function showBubble(seat, text, gray) {
    const layer = $('#fx-layer');
    const b = document.createElement('div');
    b.className = 'bubble' + (gray ? ' gray' : '');
    b.textContent = text;
    const pos = { 0: { x: '50%', y: '72%' }, 1: { x: '74%', y: '32%' }, 2: { x: '26%', y: '32%' } }[seat];
    b.style.left = pos.x; b.style.top = pos.y; b.style.transform = 'translate(-50%,-50%)';
    layer.appendChild(b);
    setTimeout(() => b.remove(), 1400);
  }

  function fxBig(text) {
    const layer = $('#fx-layer');
    const el = document.createElement('div');
    el.className = 'fx-text'; el.textContent = text;
    layer.appendChild(el);
    // 火花
    for (let i = 0; i < 18; i++) spark(layer);
    setTimeout(() => el.remove(), 1200);
  }
  function spark(layer) {
    const s = document.createElement('div');
    s.className = 'spark';
    const cx = layer.clientWidth / 2, cy = layer.clientHeight * 0.38;
    s.style.left = cx + 'px'; s.style.top = cy + 'px';
    layer.appendChild(s);
    const ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 120;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
    s.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) scale(0)`, opacity: 0 }],
      { duration: 700 + Math.random() * 400, easing: 'cubic-bezier(.1,.7,.3,1)' });
    setTimeout(() => s.remove(), 1100);
  }
  function confetti() {
    const layer = $('#fx-layer');
    const colors = ['#f5cd72', '#ff6b6b', '#4caf50', '#5b9bd5', '#fff'];
    for (let i = 0; i < 80; i++) {
      const c = document.createElement('div');
      c.style.cssText = `position:absolute;width:10px;height:14px;left:${Math.random() * 100}%;top:-20px;
        background:${colors[i % colors.length]};border-radius:2px;z-index:50;`;
      layer.appendChild(c);
      c.animate([{ transform: `translateY(0) rotate(0)`, opacity: 1 },
        { transform: `translateY(${layer.clientHeight + 40}px) rotate(${720 * (Math.random() - .5)}deg)`, opacity: .8 }],
        { duration: 1800 + Math.random() * 1200, easing: 'ease-in' });
      setTimeout(() => c.remove(), 3200);
    }
  }

  // ===================================================================
  // 计时器 / 操作栏
  // ===================================================================
  let timerId = null, timeLeft = 0;
  function startTimer() {
    timeLeft = 20;
    $('#timer-ring').textContent = timeLeft;
    clearInterval(timerId);
    timerId = setInterval(() => {
      timeLeft--;
      $('#timer-ring').textContent = timeLeft;
      if (timeLeft <= 5) S.alertTone();
      if (timeLeft <= 0) {
        clearInterval(timerId);
        // 超时：能过则过，否则自动出最小
        if (G.lastPlayer === 0 || G.lastPlayer === -1) {
          const moves = AI.enumerateMoves(G.hands[0], null);
          if (moves.length) { G.selected = new Set(moves[0].cards.map(c => c.id)); playerPlay(); }
        } else { playerPass(); }
      }
    }, 1000);
  }
  function stopTimer() { clearInterval(timerId); $('#timer-ring').textContent = ''; }
  function showActionBar(v) { $('#action-bar').classList.toggle('hidden', !v); if (!v) $('#play-typename').textContent = ''; }

  // ===================================================================
  // 设置
  // ===================================================================
  function bindSettings() {
    // 难度
    $$('#seg-difficulty button').forEach(b => b.addEventListener('click', () => {
      Config.difficulty = Number(b.dataset.v);
      $$('#seg-difficulty button').forEach(x => x.classList.toggle('on', x === b));
    }));
    // 速度
    $$('#seg-speed button').forEach(b => b.addEventListener('click', () => {
      Config.aiSpeed = b.dataset.v;
      $$('#seg-speed button').forEach(x => x.classList.toggle('on', x === b));
    }));
    // 音效开关
    $('#switch-sound').addEventListener('click', () => {
      Config.soundOn = !Config.soundOn;
      $('#switch-sound').classList.toggle('on', Config.soundOn);
      S.setEnabled(Config.soundOn);
    });
    $('#switch-music').addEventListener('click', () => {
      Config.musicOn = !Config.musicOn;
      $('#switch-music').classList.toggle('on', Config.musicOn);
      S.setMusicOn(Config.musicOn);
    });
    $('#settings-close').addEventListener('click', () => $('#settings-modal').classList.remove('show'));
    // 游戏内菜单
    $('#btn-ingame-menu').addEventListener('click', () => $('#settings-modal').classList.add('show'));
    $('#btn-quit').addEventListener('click', () => {
      S.stopMusic(); $('#settings-modal').classList.remove('show');
      refreshRankCard(); show('#screen-home');
    });
    // 结算返回
    $('#btn-result-again').addEventListener('click', () => startMatch(matchMode));
    $('#btn-result-home').addEventListener('click', () => { refreshRankCard(); show('#screen-home'); });
    // 初始化 UI 状态
    $$('#seg-difficulty button').forEach(x => x.classList.toggle('on', Number(x.dataset.v) === Config.difficulty));
    $$('#seg-speed button').forEach(x => x.classList.toggle('on', x.dataset.v === Config.aiSpeed));
    $('#switch-sound').classList.toggle('on', Config.soundOn);
    $('#switch-music').classList.toggle('on', Config.musicOn);
  }

  // ===================================================================
  // 工具
  // ===================================================================
  function aiDelay() {
    const base = SPEED_MS[Config.aiSpeed] || 900;
    return base + Math.random() * base * 0.4;
  }
  function shuffleArr(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
  function flash(text, dur) {
    const t = $('#flash-toast'); t.textContent = text; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), dur || 1000);
  }
  let toastTimer = null;
  function toast(text) {
    const t = $('#flash-toast'); t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
  }
  function showHowTo() {
    flash('斗地主：叫分抢地主，先出完牌者所在阵营获胜。炸弹翻倍！', 2600);
  }

  // 绑定按钮
  function bindGameButtons() {
    $('#btn-play').addEventListener('click', playerPlay);
    $('#btn-pass').addEventListener('click', playerPass);
    $('#btn-hint').addEventListener('click', playerHint);
    $$('#call-panel .call-btn').forEach(b => b.addEventListener('click', () => doCall(0, Number(b.dataset.v))));
  }

  // 启动
  document.addEventListener('DOMContentLoaded', () => { initApp(); bindGameButtons(); });

  global.Game = { Config };
})(typeof window !== 'undefined' ? window : globalThis);

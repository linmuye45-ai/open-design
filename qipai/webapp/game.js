/* =========================================================================
   锦鲤棋牌 · 斗地主 AAA 原型 —— 主控制器 (game.js)
   ========================================================================= */
import { buildDeck, shuffle, identify, canBeat, enumerateMoves, RANK_LABEL, RED, sortDesc } from './rules.js';

// ---------------- 爵位荣衔制（与 RankSystem.ts 同思想的精简版） ----------------
const TIER_TABLE=[
  {name:'布衣',floor:0,perStar:100,stars:3,color:'#8d8d8d'},
  {name:'员外',floor:300,perStar:120,stars:4,color:'#4caf50'},
  {name:'乡绅',floor:780,perStar:150,stars:4,color:'#2196f3'},
  {name:'大富豪',floor:1380,perStar:180,stars:5,color:'#9c27b0'},
  {name:'一品大员',floor:2280,perStar:220,stars:5,color:'#ff9800'},
  {name:'棋圣',floor:3380,perStar:300,stars:Infinity,color:'#ffd700'},
];
const CN=['零','一','二','三','四','五','六','七','八','九','十'];
function tierOf(score){for(let i=TIER_TABLE.length-1;i>=0;i--)if(score>=TIER_TABLE[i].floor)return TIER_TABLE[i];return TIER_TABLE[0];}
function describeRank(score){
  const m=tierOf(score);const within=score-m.floor;const raw=Math.floor(within/m.perStar);
  let star,next;
  if(m.stars===Infinity){star=raw+1;next=m.perStar-(within%m.perStar);}
  else{const cap=Math.min(raw,m.stars-1);star=cap+1;const idx=TIER_TABLE.indexOf(m);
    if(raw>=m.stars-1&&idx<TIER_TABLE.length-1)next=Math.max(0,TIER_TABLE[idx+1].floor-score);
    else next=m.perStar-(within%m.perStar);}
  const starTxt=star<=10?CN[star]+'星':star+'星';
  return {name:m.name,star,starTxt,color:m.color,next,full:`${m.name} · ${starTxt}`,floor:m.floor};
}

// ---------------- 全局状态 ----------------
const S={
  hands:[[],[],[]],      // 0=我 1=下家(left) 2=上家(right)
  bottom:[], landlord:-1,
  turn:0, lastCombo:null, lastSeat:-1, passes:0,
  selected:new Set(), phase:'idle', // idle|bidding|playing|over
  played:[[],[],[]],
  rankScore: Number(localStorage.getItem('jinli_rank')||0),
  iq:70, speed:800, multiplier:1,
};

// ---------------- DOM ----------------
const $=id=>document.getElementById(id);
const handEl=$('hand'), statusEl=$('statusText');
const btnStart=$('btnStart'),btnBid=$('btnBid'),btnPass=$('btnPass'),btnPlay=$('btnPlay'),btnHint=$('btnHint');

// ---------------- 荣衔渲染 ----------------
function renderRank(){
  const d=describeRank(S.rankScore);
  $('rankTitle').textContent=d.full;$('rankTitle').style.color=d.color;
  $('rankScore').textContent=`积分 ${S.rankScore}`;
  const m=tierOf(S.rankScore);const within=S.rankScore-m.floor;
  const pct=m.stars===Infinity?((within%m.perStar)/m.perStar*100):Math.min(100,(within/(m.perStar*m.stars))*100);
  $('rankBarFill').style.width=pct+'%';
}

// ---------------- 手牌矩阵布局（100% 全可见核心算法） ----------------
function layoutHand(){
  handEl.innerHTML='';
  const cards=sortDesc(S.hands[0]);
  const n=cards.length;
  const zoneW=handEl.clientWidth||Math.min(window.innerWidth-30,1000);
  const cw=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-w'))||64;
  // 最小可见比例 0.42 -> 至少露出 42% 的牌，永不完全遮挡
  const minVisible=0.42;
  // 理想不重叠所需宽度
  let step;
  if(n<=1){step=cw;}
  else{
    const idealStep=cw; // 完全不重叠
    const maxStep=(zoneW-cw)/(n-1);
    step=Math.min(idealStep, maxStep);
    step=Math.max(step, cw*minVisible); // 保证最小可见
  }
  cards.forEach((c,i)=>{
    const el=makeCardEl(c,false);
    el.style.marginLeft = i===0?'0':`${-(cw-step)}px`;
    if(S.selected.has(c.id))el.classList.add('selected');
    el.addEventListener('click',()=>{ if(S.phase!=='playing'||S.turn!==0)return;
      if(S.selected.has(c.id))S.selected.delete(c.id);else S.selected.add(c.id);
      layoutHand(); });
    handEl.appendChild(el);
  });
  $('myCount').textContent=n;
}
function makeCardEl(c,mini){
  const el=document.createElement('div');
  el.className='card'+(mini?' mini':'')+(RED.has(c.suit)?' red':'');
  const label=RANK_LABEL[c.r];
  if(c.r>=16){ el.innerHTML=`<div class="corner">${label}</div><div class="center">${c.r===17?'🃏':'🂿'}</div>`; el.classList.remove('red'); if(c.r===17)el.style.color='#c0392b'; }
  else el.innerHTML=`<div class="corner">${label}<small>${c.suit}</small></div><div class="center">${c.suit}</div>`;
  return el;
}
function renderMini(cards,container){
  container.innerHTML='';
  if(!cards||!cards.length){container.innerHTML='<span style="opacity:.5;font-size:13px">不出</span>';return;}
  sortDesc(cards).forEach(c=>container.appendChild(makeCardEl(c,true)));
}

// ---------------- 发牌 / 开局 ----------------
function deal(){
  const deck=shuffle(buildDeck());
  S.hands=[deck.slice(0,17),deck.slice(17,34),deck.slice(34,51)];
  S.bottom=deck.slice(51,54);
  S.landlord=-1;S.lastCombo=null;S.lastSeat=-1;S.passes=0;S.selected.clear();
  S.played=[[],[],[]];S.multiplier=1;
  ['leftPlayed','rightPlayed','myPlayed'].forEach(id=>$(id).innerHTML='');
  $('bottomCards').innerHTML='';['leftRole','rightRole','myRole'].forEach(id=>$(id).textContent='');
  $('leftCount').textContent=17;$('rightCount').textContent=17;
  layoutHand();
  S.phase='bidding';S.turn=0;
  statusEl.textContent='你要叫地主吗？（叫了拿 3 张底牌，倍数×2）';
  btnBid.disabled=false;btnBid.textContent='叫地主';btnPass.disabled=false;btnPass.textContent='不叫';
  btnPlay.disabled=true;btnHint.disabled=true;
}

// 简易叫分：我先决定，若不叫则 AI 概率叫
function setLandlord(seat){
  S.landlord=seat;S.multiplier=2;
  S.hands[seat]=S.hands[seat].concat(S.bottom);
  $('bottomCards').innerHTML='';S.bottom.forEach(c=>$('bottomCards').appendChild(makeCardEl(c,false)));
  const roles=['myRole','leftRole','rightRole'];
  const names=['我','下家农民','上家农民'];
  [0,1,2].forEach(s=>{
    const isLand=s===seat;const txt=isLand?'地主':'农民';
    if(s===0)$('myRole').textContent=`我 · ${txt}`;
    if(s===1)$('leftRole').textContent=txt;
    if(s===2)$('rightRole').textContent=txt;
  });
  if(seat===0)layoutHand();
  updateCounts();
  S.phase='playing';S.turn=seat;S.lastCombo=null;S.lastSeat=-1;S.passes=0;
  statusEl.textContent=`${names[seat]} 是地主，倍数 ×${S.multiplier}。`;
  btnBid.disabled=true;
  nextTurn();
}
function updateCounts(){
  $('myCount').textContent=S.hands[0].length;
  $('leftCount').textContent=S.hands[1].length;
  $('rightCount').textContent=S.hands[2].length;
}

// ---------------- 回合驱动 ----------------
function nextTurn(){
  if(S.phase!=='playing')return;
  updateCounts();
  // 胜负判定
  for(let s=0;s<3;s++) if(S.hands[s].length===0){ return endGame(s); }
  if(S.turn===0){
    // 玩家回合
    const free=(S.lastSeat===-1||S.lastSeat===0);
    btnPlay.disabled=false;btnHint.disabled=false;btnPass.disabled=free;btnPass.textContent='不出';
    const names=['你','下家','上家'];
    statusEl.textContent = free?'轮到你出牌（自由出）':`轮到你，需压过 ${names[S.lastSeat]} 的牌`;
  }else{
    btnPlay.disabled=true;btnPass.disabled=true;btnHint.disabled=true;
    setTimeout(aiTurn, Math.max(120,S.speed));
  }
}

// ---------------- 可调 AI ----------------
function aiTurn(){
  const seat=S.turn;
  const hand=S.hands[seat];
  const free=(S.lastSeat===-1||S.lastSeat===seat);
  const last=free?null:S.lastCombo;
  const moves=enumerateMoves(hand,last);
  let choice=aiChoose(seat,hand,moves,last,free);
  if(!choice){ // pass
    S.played[seat]=[];
    renderMini([], seat===1?$('leftPlayed'):$('rightPlayed'));
    S.passes++;
    if(S.passes>=2){S.lastCombo=null;S.lastSeat=-1;S.passes=0;}
    S.turn=(S.turn+1)%3;return nextTurn();
  }
  // 出牌
  const ids=new Set(choice.cards.map(c=>c.id));
  S.hands[seat]=hand.filter(c=>!ids.has(c.id));
  S.lastCombo=choice;S.lastSeat=seat;S.passes=0;
  renderMini(choice.cards, seat===1?$('leftPlayed'):$('rightPlayed'));
  // 炸弹加倍
  if(choice.type==='bomb'||choice.type==='rocket'){S.multiplier*=2;flashStatus(`💥 ${seat===1?'下家':'上家'}出炸弹！倍数×${S.multiplier}`);}
  S.turn=(S.turn+1)%3;nextTurn();
}

// AI 决策：IQ 控制策略质量
function aiChoose(seat,hand,moves,last,free){
  if(moves.length===0)return null;
  const iq=S.iq;
  // 低智商：更倾向乱出/不必要地出牌；高智商：留大牌、拆牌少、关键时刻出炸
  const isLandlord=(seat===S.landlord);
  const oppMin=Math.min(...[0,1,2].filter(s=>s!==seat).map(s=>S.hands[s].length));
  // 若非自由出，低 IQ 有概率放弃压制
  if(!free){
    const passProb = iq<30?0.5 : iq<60?0.25 : 0.08;
    // 但对手快没牌了(<=2)，高 IQ 尽量压
    const urgent = oppMin<=2;
    if(!urgent && Math.random()<passProb && !isForcedFollow(hand,last)) return null;
  }
  // 候选排序
  const scored=moves.map(m=>({m,v:scoreMove(m,hand,iq,isLandlord,oppMin,free)}));
  scored.sort((a,b)=>b.v-a.v);
  // IQ 引入随机：低智商从前若干里随机
  const topK = iq>=80?1 : iq>=50?2 : iq>=25?4 : Math.min(6,scored.length);
  const pick = scored[Math.floor(Math.random()*Math.min(topK,scored.length))];
  return pick.m;
}
function isForcedFollow(hand,last){ return false; }
function scoreMove(m,hand,iq,isLandlord,oppMin,free){
  let v=0;
  const cardCount=m.cards.length;
  // 高 IQ：优先出小牌、少拆牌、留炸弹
  v += cardCount*2;                 // 一次出更多牌略优（清手快）
  v -= m.key*0.6;                    // 出的牌越小越好（留大牌）
  if(m.type==='bomb'||m.type==='rocket'){
    // 智商越高，越不轻易用炸（除非对手快赢或能一波带走）
    const keepBomb = iq/100;
    v -= 30*keepBomb;
    if(oppMin<=3) v += 40;           // 对手快赢，值得炸
    if(m.cards.length>=hand.length-0) v+=50; // 能直接走完
  }
  // 自由出时，高 IQ 倾向出连牌/顺子清理手牌
  if(free && (m.type==='straight'||m.type==='pairstraight'||m.type.startsWith('plane'))) v+=cardCount* (iq/60);
  // 高 IQ 若这手能直接打光则强烈优先
  if(m.cards.length===hand.length) v+=100;
  // 加入与 IQ 相关的噪声
  v += (Math.random()-0.5)*(100-iq)*0.4;
  return v;
}
function flashStatus(txt){const old=statusEl.textContent;statusEl.textContent=txt;setTimeout(()=>{if(S.phase==='playing'&&statusEl.textContent===txt)statusEl.textContent=old;},1200);}

// ---------------- 玩家操作 ----------------
btnPlay.addEventListener('click',()=>{
  if(S.phase!=='playing'||S.turn!==0)return;
  const cards=S.hands[0].filter(c=>S.selected.has(c.id));
  if(!cards.length){flashStatus('请先选择要出的牌');return;}
  const combo=identify(cards);combo.cards=cards;
  const free=(S.lastSeat===-1||S.lastSeat===0);
  if(combo.type==='invalid'){flashStatus('牌型不合法');return;}
  if(!free && !canBeat(combo,S.lastCombo)){flashStatus('压不过上家的牌');return;}
  const ids=new Set(cards.map(c=>c.id));
  S.hands[0]=S.hands[0].filter(c=>!ids.has(c.id));
  S.selected.clear();
  S.lastCombo=combo;S.lastSeat=0;S.passes=0;
  renderMini(cards,$('myPlayed'));layoutHand();
  if(combo.type==='bomb'||combo.type==='rocket'){S.multiplier*=2;flashStatus(`💥 你出炸弹！倍数×${S.multiplier}`);}
  S.turn=1;nextTurn();
});
btnPass.addEventListener('click',()=>{
  if(S.phase==='bidding'){ // 不叫 -> AI 抢
    return playerBid(false);
  }
  if(S.phase!=='playing'||S.turn!==0)return;
  const free=(S.lastSeat===-1||S.lastSeat===0);
  if(free){flashStatus('自由出牌不能不出');return;}
  renderMini([],$('myPlayed'));S.passes++;
  if(S.passes>=2){S.lastCombo=null;S.lastSeat=-1;S.passes=0;}
  S.turn=1;nextTurn();
});
btnBid.addEventListener('click',()=>{ if(S.phase==='bidding')playerBid(true); });
btnHint.addEventListener('click',()=>{
  if(S.phase!=='playing'||S.turn!==0)return;
  const free=(S.lastSeat===-1||S.lastSeat===0);
  const moves=enumerateMoves(S.hands[0],free?null:S.lastCombo);
  if(!moves.length){flashStatus('没有可出的牌，请「不出」');return;}
  // 提示出最小的合理牌
  moves.sort((a,b)=>a.cards.length-b.cards.length || a.key-b.key);
  S.selected.clear();moves[0].cards.forEach(c=>S.selected.add(c.id));layoutHand();
});

function playerBid(iBid){
  btnBid.disabled=true;btnPass.disabled=true;
  if(iBid){ return setLandlord(0); }
  // 我不叫，AI 依 IQ 概率抢地主
  statusEl.textContent='你不叫，看 AI 是否抢地主…';
  setTimeout(()=>{
    const bidder = Math.random()<0.7 ? (Math.random()<0.5?1:2) : -1;
    if(bidder===-1){ statusEl.textContent='都不叫，重新发牌…'; setTimeout(deal,900); }
    else setLandlord(bidder);
  }, Math.max(400,S.speed));
}

// ---------------- 结算 + 荣衔 ----------------
function endGame(winner){
  S.phase='over';
  const iWin = (winner===S.landlord) ? (S.landlord===0) : (S.landlord!==0);
  const base=60, delta = iWin? Math.round(base*S.multiplier) : -Math.round(45*S.multiplier);
  const before=S.rankScore;
  S.rankScore=Math.max(0,S.rankScore+delta);
  localStorage.setItem('jinli_rank',S.rankScore);
  renderRank();
  const d=describeRank(S.rankScore);
  $('resultTitle').textContent=iWin?'🎉 胜利！':'惜败';
  $('resultTitle').style.color=iWin?'#ffd700':'#ff9a8b';
  $('resultDetail').innerHTML=`本局倍数 ×${S.multiplier}<br>荣衔积分 ${delta>=0?'+':''}${delta}（${before} → ${S.rankScore}）`;
  $('resultRank').innerHTML=`当前荣衔：<span style="color:${d.color}">${d.full}</span>`;
  $('resultModal').classList.remove('hidden');
  [btnPlay,btnPass,btnHint,btnBid].forEach(b=>b.disabled=true);
}

// ---------------- 滑杆 & 按钮 ----------------
$('iqSlider').addEventListener('input',e=>{S.iq=+e.target.value;$('iqVal').textContent=S.iq;});
$('spdSlider').addEventListener('input',e=>{S.speed=+e.target.value;$('spdVal').textContent=S.speed;});
btnStart.addEventListener('click',deal);
$('btnAgain').addEventListener('click',()=>{$('resultModal').classList.add('hidden');deal();});
window.addEventListener('resize',()=>{if(S.phase!=='idle')layoutHand();});

// 初始化
renderRank();
statusEl.textContent='欢迎来到锦鲤棋牌！点击「开始新局」体验：100% 全可见大字牌 · 可调 AI · 爵位荣衔制。';

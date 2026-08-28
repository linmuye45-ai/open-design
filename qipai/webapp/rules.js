/* =========================================================================
   锦鲤棋牌 · 斗地主 AAA 原型 —— 游戏逻辑 (game.js)
   纯前端可玩演示，规则/AI/荣衔与 TS 生产代码同源思想的精简实现。
   核心展示三大卖点：
     1. 100% 全可见手牌（数学矩阵布局，永不完全遮挡）
     2. 可调 AI（智商 0-100 + 出牌速度 50-3000ms）
     3. 爵位荣衔制（布衣→棋圣）
   ========================================================================= */

// ---------------- 牌与规则 ----------------
const RANKS = [3,4,5,6,7,8,9,10,11,12,13,14,15]; // 3..2
const RANK_LABEL = {3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小',17:'大'};
const SUITS = ['♠','♥','♣','♦'];
const RED = new Set(['♥','♦']);

function buildDeck(){
  const d=[];
  for(const r of RANKS) for(let s=0;s<4;s++) d.push({r, s, suit:SUITS[s], id:`${r}-${s}`});
  d.push({r:16,s:4,suit:'',id:'16-4'}); // 小王
  d.push({r:17,s:4,suit:'',id:'17-4'}); // 大王
  return d;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function countByRank(cards){const c={};for(const x of cards)c[x.r]=(c[x.r]||0)+1;return c;}
function groupByRank(cards){const g={};for(const x of cards)(g[x.r]=g[x.r]||[]).push(x);return g;}
function sortDesc(cards){return cards.slice().sort((a,b)=>b.r-a.r || b.s-a.s);}

// 牌型识别 -> {type,key,len,bomb}
function identify(cards){
  const inv={type:'invalid',key:0,len:0,bomb:0};
  if(!cards||!cards.length) return inv;
  const cnt=countByRank(cards);
  const ranks=Object.keys(cnt).map(Number).sort((a,b)=>a-b);
  const n=cards.length;
  if(n===2&&cnt[16]===1&&cnt[17]===1) return {type:'rocket',key:100,len:1,bomb:2};
  if(n===1) return {type:'single',key:ranks[0],len:1,bomb:0};
  if(n===2&&ranks.length===1&&cnt[ranks[0]]===2) return {type:'pair',key:ranks[0],len:1,bomb:0};
  if(n===3&&ranks.length===1) return {type:'trio',key:ranks[0],len:1,bomb:0};
  if(n===4&&ranks.length===1) return {type:'bomb',key:ranks[0],len:1,bomb:1};
  if(n===4){const t=ranks.find(r=>cnt[r]===3);if(t!==undefined&&ranks.length===2)return{type:'trio1',key:t,len:1,bomb:0};}
  if(n===5){const t=ranks.find(r=>cnt[r]===3),p=ranks.find(r=>cnt[r]===2);if(t!==undefined&&p!==undefined&&ranks.length===2)return{type:'trio2',key:t,len:1,bomb:0};}
  const consec=(rs)=>{for(let i=1;i<rs.length;i++)if(rs[i]!==rs[i-1]+1)return false;return true;};
  if(n>=5&&ranks.length===n&&consec(ranks)&&ranks[ranks.length-1]<=14) return {type:'straight',key:ranks[ranks.length-1],len:n,bomb:0};
  if(n>=6&&n%2===0&&ranks.every(r=>cnt[r]===2)&&consec(ranks)&&ranks[ranks.length-1]<=14) return {type:'pairstraight',key:ranks[ranks.length-1],len:ranks.length,bomb:0};
  // 飞机（纯/带单/带对）
  const trios=ranks.filter(r=>cnt[r]>=3&&r<=14).sort((a,b)=>a-b);
  const longest=(arr)=>{if(!arr.length)return[];let b=[arr[0]],c=[arr[0]];for(let i=1;i<arr.length;i++){if(arr[i]===arr[i-1]+1)c.push(arr[i]);else c=[arr[i]];if(c.length>b.length)b=c.slice();}return b;};
  const plane=longest(trios);
  if(plane.length>=2){
    const m=plane.length;
    if(n===m*3&&ranks.every(r=>cnt[r]===3)) return {type:'plane',key:plane[m-1],len:m,bomb:0};
    if(n===m*4){let w=0,ok=true;const used={};plane.forEach(r=>used[r]=3);for(const k in cnt){const rem=cnt[k]-(used[k]||0);if(rem)w+=rem;}if(w===m)return{type:'plane1',key:plane[m-1],len:m,bomb:0};}
    if(n===m*5){let ok=true;const used={};plane.forEach(r=>used[r]=3);let w=0;for(const k in cnt){const rem=cnt[k]-(used[k]||0);if(rem===0)continue;if(rem!==2){ok=false;break;}w++;}if(ok&&w===m)return{type:'plane2',key:plane[m-1],len:m,bomb:0};}
  }
  return inv;
}
function canBeat(play,last){
  if(play.type==='invalid')return false;
  if(!last)return true;
  if(play.type==='rocket')return true;
  if(last.type==='rocket')return false;
  if(play.type==='bomb'&&last.type!=='bomb')return true;
  if(play.type==='bomb'&&last.type==='bomb')return play.key>last.key;
  if(last.type==='bomb')return false;
  if(play.type!==last.type)return false;
  if(play.len!==last.len)return false;
  return play.key>last.key;
}

// 枚举合法出牌（供 AI / 提示）
function enumerateMoves(hand,last){
  const moves=[];const byRank=groupByRank(hand);
  const ranks=Object.keys(byRank).map(Number).sort((a,b)=>a-b);
  const tryAdd=(cs)=>{if(!cs.length)return;const c=identify(cs);if(c.type!=='invalid'&&canBeat(c,last)){c.cards=cs;moves.push(c);}};
  const pickKick=(excl,size,count)=>{const out=[];const rs=Object.keys(byRank).map(Number).filter(r=>!excl.includes(r)).sort((a,b)=>a-b);for(const r of rs){if(out.length>=size*count)break;if(byRank[r].length>=size&&r<16)out.push(...byRank[r].slice(0,size));}return out.length===size*count?out:null;};
  for(const r of ranks){const g=byRank[r];tryAdd([g[0]]);if(g.length>=2)tryAdd(g.slice(0,2));if(g.length>=3){tryAdd(g.slice(0,3));const s1=pickKick([r],1,1);if(s1)tryAdd(g.slice(0,3).concat(s1));const p1=pickKick([r],2,1);if(p1)tryAdd(g.slice(0,3).concat(p1));}if(g.length===4){tryAdd(g.slice(0,4));}}
  if(byRank[16]&&byRank[17])tryAdd([byRank[16][0],byRank[17][0]]);
  // 顺子
  const singleRanks=ranks.filter(r=>r<=14&&byRank[r].length>=1);
  for(let len=5;len<=singleRanks.length;len++)for(let i=0;i+len<=singleRanks.length;i++){const seg=singleRanks.slice(i,i+len);if(seg[seg.length-1]-seg[0]===len-1)tryAdd(seg.map(r=>byRank[r][0]));}
  // 连对
  const pairRanks=ranks.filter(r=>r<=14&&byRank[r].length>=2);
  for(let len=3;len<=pairRanks.length;len++)for(let i=0;i+len<=pairRanks.length;i++){const seg=pairRanks.slice(i,i+len);if(seg[seg.length-1]-seg[0]===len-1)tryAdd(seg.flatMap(r=>byRank[r].slice(0,2)));}
  // 去重
  const seen=new Set();
  return moves.filter(m=>{const k=m.cards.map(c=>c.id).sort().join(',');if(seen.has(k))return false;seen.add(k);return true;});
}

export { buildDeck, shuffle, identify, canBeat, enumerateMoves, RANK_LABEL, RED, sortDesc, countByRank, groupByRank };

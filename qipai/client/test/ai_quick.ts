import { createCard, Rank, Suit, ICard, ComboType } from "../assets/scripts/core/CardTypes";
import { DoudizhuRules } from "../assets/scripts/core/DoudizhuRules";
import { CardAIController, IAIObservation } from "../assets/scripts/ai/CardAIController";
function fullDeck(){const d:ICard[]=[];for(let r=3;r<=15;r++)for(let s=0;s<4;s++)d.push(createCard(r as Rank,s as Suit));d.push(createCard(16 as Rank,Suit.Joker));d.push(createCard(17 as Rank,Suit.Joker));return d;}
function shuffle<T>(a:T[]){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function rm(h:ICard[],c:ICard[]){const ids=new Set(c.map(x=>x.cardId*2+x.deckIndex));return h.filter(x=>!ids.has(x.cardId*2+x.deckIndex));}
function playGame(iqs:[number,number,number],speed:number){
  const deck=shuffle(fullDeck());const hands:ICard[][]=[[],[],[]];for(let i=0;i<51;i++)hands[i%3].push(deck[i]);
  hands[0]=hands[0].concat(deck.slice(51,54));const L=0;
  const ais=iqs.map(iq=>{const a=new CardAIController();a.setIQ(iq);a.setSpeed(speed);return a;});
  let turn=L,last:any=null,ls=-1,pass=0,played:ICard[]=[],g=0;
  const t0=Date.now();
  while(g++<500){const lc=(ls===turn||ls<0)?null:last;
    const obs:IAIObservation={seat:turn,landlordSeat:L,myHand:hands[turn],lastCombo:lc,lastSeat:ls,handCounts:[hands[0].length,hands[1].length,hands[2].length] as any,playedCards:played,bottomCards:[]};
    const d=ais[turn].decide(obs);
    if(d.cards.length>0){const hid=new Set(hands[turn].map(c=>c.cardId*2+c.deckIndex));
      if(!d.cards.every(c=>hid.has(c.cardId*2+c.deckIndex)))throw new Error("ILLEGAL subset");
      const combo=DoudizhuRules.identify(d.cards);if(combo.type===ComboType.Invalid)throw new Error("ILLEGAL combo");
      if(lc&&!DoudizhuRules.canBeat(combo,lc))throw new Error("ILLEGAL beat");
      hands[turn]=rm(hands[turn],d.cards);played=played.concat(d.cards);last=combo;ls=turn;pass=0;
      if(hands[turn].length===0)return {w:turn,ms:Date.now()-t0};
    }else{pass++;if(pass>=2){last=null;turn=ls;pass=0;continue;}}
    turn=(turn+1)%3;}
  return {w:-1,ms:Date.now()-t0};
}
let ill=0,lw=0,maxMs=0,sumMs=0;const N=20;
for(let i=0;i<N;i++){const r=playGame([70,70,70],150);if(r.w===0)lw++;if(r.w<0)ill++;maxMs=Math.max(maxMs,r.ms);sumMs+=r.ms;}
console.log(`IQ70x3: ${N}局 非法=${ill} 地主胜=${lw} 单局最长=${maxMs}ms 平均=${Math.round(sumMs/N)}ms`);
process.exit(ill>0?1:0);

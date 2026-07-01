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
  while(g++<400){const lc=(ls===turn||ls<0)?null:last;
    const obs:IAIObservation={seat:turn,landlordSeat:L,myHand:hands[turn],lastCombo:lc,lastSeat:ls,handCounts:[hands[0].length,hands[1].length,hands[2].length] as any,playedCards:played,bottomCards:[]};
    const d=ais[turn].decide(obs);
    if(d.cards.length>0){hands[turn]=rm(hands[turn],d.cards);played=played.concat(d.cards);last=DoudizhuRules.identify(d.cards);ls=turn;pass=0;if(hands[turn].length===0)return turn;}
    else{pass++;if(pass>=2){last=null;turn=ls;pass=0;continue;}}
    turn=(turn+1)%3;}
  return -1;
}
// 用极速档(50ms)跑多局，比较难度强弱
const N=40;
let a=0; for(let i=0;i<N;i++) if(playGame([90,15,15],50)===0) a++;
console.log(`国手地主(IQ90) vs 小白菜农民(IQ15): 地主胜率 ${Math.round(a/N*100)}%`);
let b=0; for(let i=0;i<N;i++) if(playGame([15,90,90],50)===0) b++;
console.log(`小白菜地主(IQ15) vs 国手农民(IQ90): 地主胜率 ${Math.round(b/N*100)}%`);
console.log(`强弱差异明显=${(a/N - b/N) > 0.2 ? "是(难度分档有效)":"否"}`);
process.exit(0);

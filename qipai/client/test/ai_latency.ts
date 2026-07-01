import { createCard, Rank, Suit, ICard } from "../assets/scripts/core/CardTypes";
import { CardAIController, IAIObservation } from "../assets/scripts/ai/CardAIController";
function fullDeck(){const d:ICard[]=[];for(let r=3;r<=15;r++)for(let s=0;s<4;s++)d.push(createCard(r as Rank,s as Suit));d.push(createCard(16 as Rank,Suit.Joker));d.push(createCard(17 as Rank,Suit.Joker));return d;}
function shuffle<T>(a:T[]){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
// 测试不同 setSpeed 下的实际单步耗时
for(const speed of [50,150,500,1500,3000]){
  const ai=new CardAIController(); ai.setIQ(80); ai.setSpeed(speed);
  const deck=shuffle(fullDeck()); const myHand=deck.slice(0,17);
  const obs:IAIObservation={seat:0,landlordSeat:0,myHand,lastCombo:null,lastSeat:-1,handCounts:[17,17,17] as any,playedCards:[],bottomCards:[]};
  // 预热
  ai.decide(obs);
  let sum=0,mx=0; const N=8;
  for(let i=0;i<N;i++){const t=Date.now();const d=ai.decide(obs);const e=Date.now()-t;sum+=e;mx=Math.max(mx,e);}
  console.log(`setSpeed=${speed}ms -> 实际平均=${Math.round(sum/N)}ms 最大=${mx}ms`);
}
process.exit(0);

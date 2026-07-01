/**
 * AI 对局模拟测试：验证 MCTS 决策全程合法，且高 IQ 明显强于低 IQ。
 * 运行：tsc 编译后 node 执行。
 */
import { createCard, Rank, Suit, ICard, ComboType } from "../assets/scripts/core/CardTypes";
import { DoudizhuRules } from "../assets/scripts/core/DoudizhuRules";
import { CardAIController, IAIObservation } from "../assets/scripts/ai/CardAIController";

function fullDeck(): ICard[] {
    const d: ICard[] = [];
    for (let r = 3; r <= 15; r++) for (let s = 0; s < 4; s++) d.push(createCard(r as Rank, s as Suit));
    d.push(createCard(16 as Rank, Suit.Joker));
    d.push(createCard(17 as Rank, Suit.Joker));
    return d;
}
function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
    return a;
}
function remove(hand: ICard[], cards: ICard[]): ICard[] {
    const ids = new Set(cards.map(c => c.cardId * 2 + c.deckIndex));
    return hand.filter(c => !ids.has(c.cardId * 2 + c.deckIndex));
}

function playGame(iqs: [number, number, number]): number {
    const deck = shuffle(fullDeck());
    const hands: ICard[][] = [[], [], []];
    for (let i = 0; i < 51; i++) hands[i % 3].push(deck[i]);
    const bottom = deck.slice(51, 54);
    const landlord = 0;
    hands[0] = hands[0].concat(bottom);
    const ais = iqs.map(iq => { const a = new CardAIController(); a.setIQ(iq); a.setSpeed(120); return a; });
    let turn = landlord, last: any = null, lastSeat = -1, passes = 0, played: ICard[] = [], guard = 0;
    while (guard++ < 500) {
        const lastCombo = (lastSeat === turn || lastSeat < 0) ? null : last;
        const obs: IAIObservation = {
            seat: turn, landlordSeat: landlord, myHand: hands[turn], lastCombo,
            lastSeat, handCounts: [hands[0].length, hands[1].length, hands[2].length] as [number, number, number],
            playedCards: played, bottomCards: [],
        };
        const dec = ais[turn].decide(obs);
        if (dec.cards.length > 0) {
            const handIds = new Set(hands[turn].map(c => c.cardId * 2 + c.deckIndex));
            if (!dec.cards.every(c => handIds.has(c.cardId * 2 + c.deckIndex))) throw new Error("ILLEGAL: not subset");
            const combo = DoudizhuRules.identify(dec.cards);
            if (combo.type === ComboType.Invalid) throw new Error("ILLEGAL: invalid combo");
            if (lastCombo && !DoudizhuRules.canBeat(combo, lastCombo)) throw new Error("ILLEGAL: cannot beat");
            hands[turn] = remove(hands[turn], dec.cards); played = played.concat(dec.cards);
            last = combo; lastSeat = turn; passes = 0;
            if (hands[turn].length === 0) return turn;
        } else {
            passes++;
            if (passes >= 2) { last = null; turn = lastSeat; passes = 0; continue; }
        }
        turn = (turn + 1) % 3;
    }
    return -1;
}

let illegal = 0, landlordWins = 0; const games = 60;
for (let g = 0; g < games; g++) {
    try { const w = playGame([70, 70, 70]); if (w === 0) landlordWins++; if (w < 0) illegal++; }
    catch (e) { illegal++; console.log("ERR", (e as Error).message); }
}
console.log(`IQ70 vs IQ70: ${games}局完成, 非法/未结束=${illegal}, 地主胜=${landlordWins}`);

let strongWins = 0; const g2 = 40;
for (let g = 0; g < g2; g++) { const w = playGame([90, 20, 20]); if (w === 0) strongWins++; }
console.log(`IQ90地主 vs IQ20农民: ${g2}局, 地主胜=${strongWins} (${Math.round(strongWins / g2 * 100)}%)`);

let weakWins = 0;
for (let g = 0; g < g2; g++) { const w = playGame([20, 90, 90]); if (w === 0) weakWins++; }
console.log(`IQ20地主 vs IQ90农民: ${g2}局, 地主胜=${weakWins} (${Math.round(weakWins / g2 * 100)}%)`);

process.exit(illegal > 0 ? 1 : 0);

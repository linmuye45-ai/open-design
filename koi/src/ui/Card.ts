/**
 * =============================================================================
 *  锦鲤牌阵 · 牌面渲染 (Card.ts)
 * -----------------------------------------------------------------------------
 *  渲染「大字号、高对比、适老化、关键数字/花色永不遮挡」的清晰牌面。
 *  返回一个 HTMLElement，供 App 挂载。原生 DOM，无框架依赖。
 * =============================================================================
 */
import { Card, RANK_LABEL, SUIT_SYMBOL, SUIT_NAME, isRedSuit } from "../game/rules";

export interface CardViewOpts {
  selected?: boolean;
  onClick?: (card: Card) => void;
  /** 计分高亮（结算飞字时用） */
  scoring?: boolean;
}

export function renderCard(card: Card, opts: CardViewOpts = {}): HTMLElement {
  const el = document.createElement("button");
  el.className = "card";
  el.type = "button";
  el.setAttribute("data-id", card.id);
  el.setAttribute("aria-label", `${RANK_LABEL[card.rank]} ${SUIT_NAME[card.suit]}`);
  if (opts.selected) el.classList.add("card--selected");
  if (opts.scoring) el.classList.add("card--scoring");
  if (isRedSuit(card.suit)) el.classList.add("card--red");
  else el.classList.add("card--dark");
  if (card.gilded) el.classList.add("card--gilded");

  const label = RANK_LABEL[card.rank];
  const sym = SUIT_SYMBOL[card.suit];

  el.innerHTML = `
    <span class="card__corner card__corner--tl">
      <span class="card__rank">${label}</span>
      <span class="card__suit">${sym}</span>
    </span>
    <span class="card__center">${sym}</span>
    <span class="card__corner card__corner--br">
      <span class="card__rank">${label}</span>
      <span class="card__suit">${sym}</span>
    </span>
    ${card.gilded ? '<span class="card__gild">金</span>' : ""}
  `;

  if (opts.onClick) {
    el.addEventListener("click", () => opts.onClick!(card));
  }
  return el;
}

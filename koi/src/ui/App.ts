/**
 * =============================================================================
 *  锦鲤牌阵 · 主界面控制器 (App.ts)
 * -----------------------------------------------------------------------------
 *  纯原生 DOM 的单文件视图控制器：根据 RunState.phase 渲染不同界面，
 *  处理选牌/出牌/弃牌/领奖/商店/成就/静音等交互，并触发爆分动画与音效。
 *
 *  合规：全程无真钱、无金币输赢、无提现、无抽卡；铜钱仅为局内构筑资源，
 *  不可充值、不可提现、不可兑换。
 * =============================================================================
 */
import {
  RunState, newRun, chooseSchool, toggleSelect, playHand, discardSelected,
  previewHand, enterShop, buyItem, nextLevel, SCHOOLS, School,
} from "../game/run";
import { RUN_RULES, HAND_SCORES } from "../game/balance";
import { HAND_ORDER, HandType, Card, SUIT_NAME } from "../game/rules";
import { getRelic } from "../game/relics";
import { renderCard } from "./Card";
import { audio } from "../audio/audio";
import {
  Profile, loadProfile, saveProfile, refreshAchievements, recordHandScore,
  recordRelicsSeen, ACHIEVEMENTS,
} from "../game/save";

export class App {
  private root: HTMLElement;
  private state: RunState;
  private profile: Profile;
  private toastLayer: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.profile = loadProfile();
    this.state = newRun();
    this.toastLayer = document.createElement("div");
    this.toastLayer.className = "toast-layer";
    document.body.appendChild(this.toastLayer);
    audio.setMuted(this.profile.muted);
    this.render();
  }

  // ---------------- 状态更新 ----------------
  private set(next: RunState): void {
    this.state = next;
    this.render();
  }

  private persist(): void {
    saveProfile(this.profile);
  }

  // ---------------- 顶栏（含合规/静音/成就） ----------------
  private topBar(): string {
    const muteIcon = audio.isMuted() ? "🔇" : "🔊";
    return `
      <header class="topbar">
        <div class="topbar__brand">
          <span class="topbar__logo">🐟</span>
          <span class="topbar__title">锦鲤牌阵</span>
          <span class="topbar__sub">国风策略构筑 · 牌型解谜肉鸽</span>
        </div>
        <div class="topbar__actions">
          <button class="btn btn--ghost" data-act="achv">🏅 成就</button>
          <button class="btn btn--ghost" data-act="mute">${muteIcon} 音效</button>
          <button class="btn btn--ghost" data-act="help">❓ 玩法</button>
          <button class="btn btn--ghost" data-act="compliance">🛡 说明</button>
        </div>
      </header>`;
  }

  private complianceFooter(): string {
    return `
      <footer class="compliance">
        <span>🛡 本作为策略构筑游戏，全程无真钱、无金币输赢、无提现、无抽卡、无广告。</span>
        <span>「铜钱」仅为局内构筑资源，不可充值/提现/兑换。</span>
        <span>⏱ 温馨提示：适度游戏益脑，久坐请起身活动。家人友好。</span>
      </footer>`;
  }

  // ---------------- 主渲染分发 ----------------
  private render(): void {
    let body = "";
    switch (this.state.phase) {
      case "school": body = this.viewSchool(); break;
      case "playing": body = this.viewPlaying(); break;
      case "reward": body = this.viewReward(); break;
      case "shop": body = this.viewShop(); break;
      case "won": body = this.viewEnd(true); break;
      case "lost": body = this.viewEnd(false); break;
    }
    this.root.innerHTML = `${this.topBar()}<main class="stage">${body}</main>${this.complianceFooter()}`;
    this.bindGlobal();
    this.bindPhase();
  }

  // ================= 各阶段视图 =================
  private viewSchool(): string {
    const cards = SCHOOLS.map((s: School) => {
      const relics = s.startRelicIds.map((id) => {
        const r = getRelic(id);
        return r ? `<span class="chip">${r.emoji} ${r.name}</span>` : "";
      }).join("");
      return `
        <button class="school-card" data-school="${s.id}">
          <div class="school-card__emoji">${s.emoji}</div>
          <div class="school-card__name">${s.name}</div>
          <div class="school-card__desc">${s.desc}</div>
          <div class="school-card__relics">${relics}</div>
        </button>`;
    }).join("");
    const best = this.profile.wins > 0
      ? `<p class="hint">历史通关 ${this.profile.wins} 次 · 单次最高爆分 ${this.profile.bestScoreSingleHand}</p>` : "";
    return `
      <section class="panel panel--intro">
        <h1 class="intro__title">选择门派，开启牌阵</h1>
        <p class="intro__lead">从手牌中组出「牌阵」，用<strong>符箓</strong>叠加<strong>底分 × 倍率</strong>，冲破每关目标分。<br/>
        12 关、4 场局势(Boss)、33 种符箓，条条构筑皆可爆分。</p>
        ${best}
        <div class="school-grid">${cards}</div>
      </section>`;
  }

  private handTable(): string {
    const rows = HAND_ORDER.map((t) => {
      const preview = previewHand(this.state);
      const active = preview && preview.type === t ? " scoretable__row--active" : "";
      const sc = this.scoreForType(t);
      return `<div class="scoretable__row${active}"><span>${t}</span><span>${sc.chips}底 ×${sc.mult}</span></div>`;
    }).join("");
    return `<div class="scoretable"><div class="scoretable__head">牌型 · 底分×倍率</div>${rows}</div>`;
  }

  private scoreForType(t: HandType): { chips: number; mult: number } {
    return HAND_SCORES[t];
  }

  private viewPlaying(): string {
    const s = this.state;
    const preview = previewHand(s);
    const boss = s.boss
      ? `<div class="boss-banner">${s.boss.emoji} 局势【${s.boss.name}】：${s.boss.desc}</div>` : "";
    const progressPct = Math.min(100, Math.round((s.score / s.target) * 100));

    const relics = s.relics.map((id) => {
      const r = getRelic(id);
      return r ? `<span class="relic-chip" title="${r.desc}">${r.emoji} ${r.name}</span>` : "";
    }).join("");

    const previewLine = preview
      ? `<div class="preview">当前牌阵：<strong>${preview.type}</strong> · 基础 ${preview.baseChips} 底 ×${preview.baseMult} 倍</div>`
      : `<div class="preview preview--empty">请选择 1–5 张牌组成牌阵</div>`;

    return `
      <section class="play">
        ${boss}
        <div class="hud">
          <div class="hud__goal">
            <div class="hud__label">第 ${s.level + 1} / 12 关 · 目标分</div>
            <div class="hud__target">${s.target}</div>
            <div class="progress"><div class="progress__bar" style="width:${progressPct}%"></div></div>
            <div class="hud__score">当前：<span id="scoreNum">${s.score}</span></div>
          </div>
          <div class="hud__stats">
            <div class="stat"><span class="stat__k">出牌</span><span class="stat__v">${s.playsLeft}</span></div>
            <div class="stat"><span class="stat__k">弃牌</span><span class="stat__v">${s.discardsLeft}</span></div>
            <div class="stat"><span class="stat__k">铜钱</span><span class="stat__v">🪙${s.gold}</span></div>
          </div>
        </div>

        <div class="relic-bar">${relics || '<span class="relic-empty">暂无符箓</span>'}</div>

        <div class="playfield">
          <div class="playfield__left">
            ${previewLine}
            <div class="hand" id="hand"></div>
            <div class="actions">
              <button class="btn btn--primary btn--lg" data-act="play" ${s.selected.length === 0 || s.playsLeft <= 0 ? "disabled" : ""}>
                出牌 · 计分 (${s.playsLeft})
              </button>
              <button class="btn btn--warn btn--lg" data-act="discard" ${s.selected.length === 0 || s.discardsLeft <= 0 ? "disabled" : ""}>
                弃牌重抽 (${s.discardsLeft})
              </button>
              <button class="btn btn--ghost" data-act="clear">取消选择</button>
            </div>
          </div>
          <aside class="playfield__right">
            ${this.handTable()}
          </aside>
        </div>
      </section>`;
  }

  private viewReward(): string {
    const s = this.state;
    const gained = (s as any).lastRewardGold ?? 0;
    return `
      <section class="panel panel--center">
        <div class="big-emoji">🎉</div>
        <h2>过关！第 ${s.level + 1} 关达标</h2>
        <p class="reward__gold">获得 🪙 <strong>${gained}</strong> 铜钱（当前 ${s.gold}）</p>
        <p class="hint">铜钱用于在下一间「符箓铺」采买构筑，不可充值/提现。</p>
        <button class="btn btn--primary btn--lg" data-act="toshop">前往符箓铺 →</button>
      </section>`;
  }

  private viewShop(): string {
    const s = this.state;
    const items = s.shop.map((it, i) => {
      const afford = s.gold >= it.price;
      const full = it.kind === "relic" && s.relics.length >= RUN_RULES.relicSlots;
      return `
        <div class="shop-item ${afford && !full ? "" : "shop-item--dim"}">
          <div class="shop-item__emoji">${it.emoji}</div>
          <div class="shop-item__body">
            <div class="shop-item__name">${it.label}</div>
            <div class="shop-item__desc">${it.desc}</div>
          </div>
          <button class="btn btn--buy" data-buy="${i}" ${afford && !full ? "" : "disabled"}>
            🪙 ${it.price}${full ? " · 符箓已满" : ""}
          </button>
        </div>`;
    }).join("");
    const relics = s.relics.map((id) => {
      const r = getRelic(id);
      return r ? `<span class="relic-chip" title="${r.desc}">${r.emoji} ${r.name}</span>` : "";
    }).join("");
    return `
      <section class="panel panel--shop">
        <h2>符箓铺 · 铜钱 🪙 ${s.gold}</h2>
        <div class="relic-bar relic-bar--owned">携带：${relics || '<span class="relic-empty">无</span>'} <span class="slots">(${s.relics.length}/${RUN_RULES.relicSlots})</span></div>
        <div class="shop-grid">${items}</div>
        <button class="btn btn--primary btn--lg" data-act="next">进入第 ${s.level + 2} 关 →</button>
        <p class="hint">采买为一次性局内消耗，游戏结束即清空。</p>
      </section>`;
  }

  private viewEnd(won: boolean): string {
    const s = this.state;
    return `
      <section class="panel panel--center">
        <div class="big-emoji">${won ? "🏆" : "🥀"}</div>
        <h2>${won ? "牌阵大成 · 通关！" : "牌局终了"}</h2>
        <p>${won ? "你以巧妙构筑冲破全部 12 关局势。" : `止步第 ${s.level + 1} 关，差 ${Math.max(0, s.target - s.score)} 分达标。`}</p>
        <div class="end-stats">
          <div class="stat"><span class="stat__k">单次最高爆分</span><span class="stat__v">${s.stats.bestHand}</span></div>
          <div class="stat"><span class="stat__k">本局累计</span><span class="stat__v">${s.stats.totalScore}</span></div>
          <div class="stat"><span class="stat__k">携带符箓</span><span class="stat__v">${s.relics.length}</span></div>
        </div>
        <button class="btn btn--primary btn--lg" data-act="restart">再来一局</button>
      </section>`;
  }

  // ================= 事件绑定 =================
  private bindGlobal(): void {
    this.root.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => {
      const act = el.dataset.act!;
      el.addEventListener("click", () => this.handleAct(act));
    });
  }

  private bindPhase(): void {
    if (this.state.phase === "school") {
      this.root.querySelectorAll<HTMLElement>("[data-school]").forEach((el) => {
        el.addEventListener("click", () => {
          audio.init();
          const id = el.dataset.school as any;
          this.profile.runs += 1;
          this.checkAchievements();
          const ns = chooseSchool(this.state, id);
          recordRelicsSeen(this.profile, ns.relics);
          this.persist();
          if (ns.boss) audio.bossAppear();
          this.set(ns);
        });
      });
    }
    if (this.state.phase === "playing") {
      const handEl = this.root.querySelector<HTMLElement>("#hand");
      if (handEl) {
        for (const card of this.state.hand) {
          const sel = this.state.selected.includes(card.id);
          handEl.appendChild(renderCard(card, {
            selected: sel,
            onClick: (c) => this.onCardClick(c),
          }));
        }
      }
    }
    if (this.state.phase === "shop") {
      this.root.querySelectorAll<HTMLElement>("[data-buy]").forEach((el) => {
        el.addEventListener("click", () => {
          const idx = parseInt(el.dataset.buy!, 10);
          const before = this.state.gold;
          const ns = buyItem(this.state, idx);
          if (ns.gold !== before || ns.shop.length !== this.state.shop.length) {
            audio.buy();
            recordRelicsSeen(this.profile, ns.relics);
            this.persist();
          }
          this.set(ns);
        });
      });
    }
  }

  private onCardClick(card: Card): void {
    audio.init();
    const wasSel = this.state.selected.includes(card.id);
    wasSel ? audio.deselect() : audio.select();
    this.set(toggleSelect(this.state, card.id));
  }

  private handleAct(act: string): void {
    switch (act) {
      case "mute": {
        this.profile.muted = !audio.isMuted();
        audio.setMuted(this.profile.muted);
        this.persist();
        this.render();
        break;
      }
      case "help": this.showHelp(); break;
      case "compliance": this.showCompliance(); break;
      case "achv": this.showAchievements(); break;
      case "clear": this.set({ ...this.state, selected: [] }); break;
      case "play": this.doPlay(); break;
      case "discard": {
        audio.init(); audio.discard();
        this.set(discardSelected(this.state));
        break;
      }
      case "toshop": this.set(enterShop(this.state)); break;
      case "next": {
        const ns = nextLevel(this.state);
        if (ns.phase === "won") {
          this.profile.wins += 1;
          audio.win();
        } else if (ns.boss) {
          audio.bossAppear();
        }
        this.profile.bestRunLevel = Math.max(this.profile.bestRunLevel, ns.level);
        this.checkAchievements();
        this.persist();
        this.set(ns);
        break;
      }
      case "restart": this.set(newRun()); break;
    }
  }

  private doPlay(): void {
    audio.init();
    const before = this.state;
    const ns = playHand(before);
    if (ns === before) return; // 无效
    const last = ns.lastScore;
    if (last) {
      recordHandScore(this.profile, last.total);
      const tier = last.total >= 4000 ? 5 : last.total >= 2000 ? 4 : last.total >= 800 ? 3 : last.total >= 300 ? 2 : 1;
      audio.play(tier);
      this.burstAnimation(last.total, last.chips, last.mult, tier);
    }
    if (ns.phase === "lost") audio.lose();
    if (ns.phase === "reward") audio.clearLevel();
    this.profile.bestRunLevel = Math.max(this.profile.bestRunLevel, ns.level);
    this.checkAchievements();
    this.persist();
    // 让爆分动画先展示，再切换视图
    setTimeout(() => this.set(ns), 250);
  }

  // ================= 反馈动画 & 弹窗 =================
  private burstAnimation(total: number, chips: number, mult: number, tier: number): void {
    const layer = document.createElement("div");
    layer.className = `burst burst--tier${tier}`;
    layer.innerHTML = `
      <div class="burst__formula">${chips} <span class="burst__x">×</span> ${mult.toFixed(mult % 1 ? 1 : 0)}</div>
      <div class="burst__total">+${total}</div>
      ${tier >= 4 ? '<div class="burst__seal">財</div>' : ""}
      ${tier >= 3 ? '<div class="burst__koi">🐟</div>' : ""}
    `;
    document.body.appendChild(layer);
    setTimeout(() => layer.classList.add("burst--out"), 700);
    setTimeout(() => layer.remove(), 1300);
  }

  private toast(text: string, emoji = "✨"): void {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<span class="toast__emoji">${emoji}</span> ${text}`;
    this.toastLayer.appendChild(t);
    setTimeout(() => t.classList.add("toast--out"), 2200);
    setTimeout(() => t.remove(), 2800);
  }

  private checkAchievements(): void {
    const newly = refreshAchievements(this.profile);
    for (const a of newly) this.toast(`成就解锁：${a.name}`, a.emoji);
  }

  private modal(title: string, inner: string): void {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal">
        <div class="modal__head"><h3>${title}</h3><button class="btn btn--ghost modal__x">✕</button></div>
        <div class="modal__body">${inner}</div>
      </div>`;
    const close = () => back.remove();
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector(".modal__x")!.addEventListener("click", close);
    document.body.appendChild(back);
  }

  private showHelp(): void {
    this.modal("玩法说明", `
      <ol class="help-list">
        <li><strong>目标：</strong>用手牌组出「牌阵」，累计得分冲破每关目标分。共 12 关。</li>
        <li><strong>组牌：</strong>选 1–5 张牌，系统识别牌型（孤星/成双/长龙/满堂/游龙…）。</li>
        <li><strong>爆分公式：</strong>得分 = <em>底分(chips) × 倍率(mult)</em>，符箓会不断堆叠两者。</li>
        <li><strong>符箓：</strong>过关得铜钱，在符箓铺采买符箓/镀金/精简牌库，构筑你的爆分流派。</li>
        <li><strong>局势(Boss)：</strong>第 3/6/9/12 关有局势限制，考验构筑韧性。</li>
        <li><strong>次数：</strong>每关有限出牌与弃牌次数，用尽仍不达标即失败。</li>
      </ol>`);
  }

  private showCompliance(): void {
    this.modal("合规与健康提示", `
      <ul class="help-list">
        <li>🛡 本作是<strong>策略构筑 / 牌型解谜 / 国风肉鸽</strong>游戏，<strong>不是赌博，也不是传统棋牌</strong>。</li>
        <li>🚫 全程<strong>无真钱、无金币输赢、无提现、无红包、无房卡、无抽卡、无广告</strong>。</li>
        <li>🪙「铜钱」仅是局内一次性构筑资源，<strong>不可充值、不可提现、不可兑换任何财物</strong>。</li>
        <li>💳 未来若上线付费，仅为<strong>确定性买断内容/DLC/皮肤</strong>，绝不做概率宝箱与诱导付费。</li>
        <li>⏱ 请适度游戏、注意休息；本作适合家人共享，无不良诱导。</li>
      </ul>`);
  }

  private showAchievements(): void {
    const list = ACHIEVEMENTS.map((a) => {
      const got = this.profile.unlocked.includes(a.id);
      return `<div class="achv ${got ? "achv--got" : "achv--lock"}">
        <span class="achv__emoji">${got ? a.emoji : "🔒"}</span>
        <span class="achv__body"><b>${a.name}</b><small>${a.desc}</small></span>
      </div>`;
    }).join("");
    this.modal("成就", `
      <p class="hint">历史：开局 ${this.profile.runs} · 通关 ${this.profile.wins} · 最高爆分 ${this.profile.bestScoreSingleHand} · 见过符箓 ${this.profile.relicsSeen.length} 种</p>
      <div class="achv-grid">${list}</div>`);
  }
}

/**
 * =============================================================================
 *  锦鲤棋牌 AAA · 100% 完全显示防误触手牌管理器 (CardLayoutManager.ts)
 * -----------------------------------------------------------------------------
 *  设计目标（针对 30-65 岁中老年痛点）：
 *    1. 无论 17 张(斗地主) 还是 27/隐藏更多张(掼蛋)，牌面【100% 完整可见】，
 *       绝不缩水到看不清点数；当屏宽不足时自动【分行换排】而非无限压缩。
 *    2. 选牌使用【物理射线 / AABB 命中】+【可见区裁剪】，避免重叠区误触。
 *    3. 选中牌【丝滑上滑升起】，使用缓动 (tween) + 物理弹性，手感高级。
 *
 *  关键算法：
 *    - 给定 容器宽 W、牌宽 cw、牌数 n、最小可读重叠系数 minVisible(露出比例)，
 *      求每行最大可容纳张数 perRow，使「每张牌露出宽度 >= cw*minVisible」恒成立，
 *      从而保证点数角标永不被完全遮挡（点数角标位于左上，露出即可读）。
 *    - 命中检测：手牌从左到右叠放，后牌压前牌，故【点击命中取最上层(最右)】，
 *      用「从右向左第一个包含点的牌」实现 O(n) 精准选牌，等价于射线最近交点。
 *
 *  依赖：Cocos Creator 3.x（cc 模块）。本文件不依赖任何业务单例，纯组件。
 * =============================================================================
 */

import {
    _decorator, Component, Node, UITransform, Vec3, Vec2, Prefab, instantiate,
    EventTouch, tween, Tween, Color, Sprite, Label, view, math,
} from "cc";
import { ICard, RANK_LABEL, SUIT_SYMBOL, isRedSuit, suitOf, rankOf } from "../core/CardTypes";

const { ccclass, property } = _decorator;

/** 单张牌视图所需的运行时数据（挂在牌节点上的轻量结构） */
interface CardSlot {
    node: Node;
    card: ICard;
    /** 在排序后手牌中的索引 */
    index: number;
    /** 所在行（0 起） */
    row: number;
    /** 行内列 */
    col: number;
    /** 基础（未选中）局部坐标 */
    baseX: number;
    baseY: number;
    /** 命中包围盒（局部坐标，相对手牌容器） */
    hitMinX: number;
    hitMaxX: number;
    hitMinY: number;
    hitMaxY: number;
    selected: boolean;
    /** 正在播放的 tween，便于打断 */
    activeTween: Tween<Node> | null;
}

/** 布局计算结果 */
interface LayoutResult {
    perRow: number;          // 每行张数
    rows: number;            // 总行数
    step: number;            // 同行相邻牌的水平步进（<= cardWidth）
    rowHeight: number;       // 行高（含行间距）
    startYTop: number;       // 顶部行的 y
}

@ccclass("CardLayoutManager")
export class CardLayoutManager extends Component {

    // ----------------------- 可配置属性 -----------------------
    @property({ tooltip: "单张牌预制体（需含 Sprite/Label 用于渲染）" })
    public cardPrefab: Prefab | null = null;

    @property({ tooltip: "单张牌宽度(px)，需与预制体一致" })
    public cardWidth = 120;

    @property({ tooltip: "单张牌高度(px)" })
    public cardHeight = 168;

    @property({ tooltip: "每张牌最少露出比例(0~1)，保证角标可读，老花眼友好" })
    public minVisibleRatio = 0.34;

    @property({ tooltip: "选中时上滑高度(px)" })
    public liftHeight = 44;

    @property({ tooltip: "行与行的垂直间距(px)" })
    public rowGap = 26;

    @property({ tooltip: "容器左右安全边距(px)" })
    public sidePadding = 24;

    @property({ tooltip: "动效时长(s)" })
    public tweenDuration = 0.14;

    @property({ tooltip: "是否允许多选（出牌组合）" })
    public multiSelect = true;

    // ----------------------- 运行时状态 -----------------------
    private _slots: CardSlot[] = [];
    private _layout: LayoutResult | null = null;
    private _onSelectionChanged: ((selected: ICard[]) => void) | null = null;
    /** 缓存容器 UITransform，避免每帧 getComponent */
    private _uiTransform: UITransform | null = null;

    // =========================================================================
    //  生命周期
    // =========================================================================
    protected onLoad(): void {
        this._uiTransform = this.getComponent(UITransform);
        if (!this._uiTransform) {
            this._uiTransform = this.addComponent(UITransform)!;
        }
        // 触摸命中绑定在容器上，统一做射线/AABB 命中分发，避免每张牌独立监听导致重叠误触
        this.node.on(Node.EventType.TOUCH_END, this._onContainerTouch, this);
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_END, this._onContainerTouch, this);
        this._killAllTweens();
    }

    // =========================================================================
    //  公共 API
    // =========================================================================

    /** 注册选牌变化回调（供出牌按钮判定牌型用） */
    public setOnSelectionChanged(cb: (selected: ICard[]) => void): void {
        this._onSelectionChanged = cb;
    }

    /**
     * 设置/刷新整手牌。会按 rank 降序排序，重建节点并布局。
     * @param cards 玩家当前所有手牌
     */
    public setCards(cards: ICard[]): void {
        this._killAllTweens();
        // 1. 排序：点数降序，同点按花色，保证视觉规整、便于找牌
        const sorted = cards.slice().sort((a, b) =>
            b.rank - a.rank || b.suit - a.suit || a.deckIndex - b.deckIndex);

        // 2. 复用 / 创建节点
        this._ensureSlotCount(sorted.length);

        // 3. 计算布局
        this._layout = this._computeLayout(sorted.length);

        // 4. 应用到每个 slot
        for (let i = 0; i < sorted.length; i++) {
            const slot = this._slots[i];
            slot.card = sorted[i];
            slot.index = i;
            slot.selected = false;
            this._renderCard(slot);
            this._placeSlot(slot, this._layout, sorted.length, /*animated*/ true);
        }
        // 5. 隐藏多余 slot
        for (let i = sorted.length; i < this._slots.length; i++) {
            this._slots[i].node.active = false;
        }
        this._emitSelection();
    }

    /** 取出当前已选中的牌（按手牌顺序） */
    public getSelectedCards(): ICard[] {
        return this._slots.filter(s => s.node.active && s.selected).map(s => s.card);
    }

    /** 清空选择 */
    public clearSelection(): void {
        for (const s of this._slots) {
            if (s.selected) { s.selected = false; this._animateSlotY(s, s.baseY); }
        }
        this._emitSelection();
    }

    /** 程序化选中一组牌（用于 AI 提示功能高亮） */
    public selectCards(target: ICard[]): void {
        const ids = new Set(target.map(c => c.cardId * 2 + c.deckIndex));
        for (const s of this._slots) {
            if (!s.node.active) continue;
            const want = ids.has(s.card.cardId * 2 + s.card.deckIndex);
            if (want !== s.selected) {
                s.selected = want;
                this._animateSlotY(s, want ? s.baseY + this.liftHeight : s.baseY);
            }
        }
        this._emitSelection();
    }

    /** 移除指定牌（出牌后回收） */
    public removeCards(played: ICard[]): void {
        const ids = new Set(played.map(c => c.cardId * 2 + c.deckIndex));
        const remain = this._slots
            .filter(s => s.node.active && !ids.has(s.card.cardId * 2 + s.card.deckIndex))
            .map(s => s.card);
        this.setCards(remain);
    }

    // =========================================================================
    //  布局算法核心
    // =========================================================================

    /**
     * 计算每行容纳张数与步进。
     * 核心约束：当 n 张牌等距叠放在宽 usableW 的行内，相邻步进 step 满足
     *   step = (usableW - cardWidth) / (perRow - 1)   (perRow>1)
     * 要求 step >= cardWidth * minVisibleRatio （保证每张露出可读）。
     * 反解每行最大张数 perRowMax = floor((usableW - cardWidth) / (cw*minVis)) + 1
     * 若 n <= perRowMax 单行；否则均分多行，避免最后一行过疏。
     */
    private _computeLayout(n: number): LayoutResult {
        const W = this._containerWidth();
        const usableW = Math.max(this.cardWidth, W - this.sidePadding * 2);
        const minStep = this.cardWidth * this.minVisibleRatio;

        if (n <= 1) {
            return { perRow: 1, rows: 1, step: 0, rowHeight: this.cardHeight + this.rowGap, startYTop: 0 };
        }

        // 单行能放下的最大张数（保证 minStep）
        const perRowMax = Math.max(1, Math.floor((usableW - this.cardWidth) / minStep) + 1);

        let perRow: number;
        let rows: number;
        if (n <= perRowMax) {
            perRow = n;
            rows = 1;
        } else {
            rows = Math.ceil(n / perRowMax);
            // 行内均分，使各行尽量等量（避免末行过少）
            perRow = Math.ceil(n / rows);
            // 再次确保不超过 perRowMax
            perRow = Math.min(perRow, perRowMax);
            rows = Math.ceil(n / perRow);
        }

        // 当前 perRow 下的实际步进（单行时按实际张数收紧到不超过 cardWidth）
        const step = perRow > 1
            ? Math.min(this.cardWidth, (usableW - this.cardWidth) / (perRow - 1))
            : 0;

        const rowHeight = this.cardHeight + this.rowGap;
        // 顶部行 y：多行时整体上移，使手牌组垂直居中于容器
        const totalH = rows * this.cardHeight + (rows - 1) * this.rowGap;
        const startYTop = totalH / 2 - this.cardHeight / 2;

        return { perRow, rows, step, rowHeight, startYTop };
    }

    /** 放置单个 slot 到其行列位置，并计算命中盒 */
    private _placeSlot(slot: CardSlot, L: LayoutResult, n: number, animated: boolean): void {
        const row = Math.floor(slot.index / L.perRow);
        const col = slot.index % L.perRow;
        // 本行实际张数（末行可能不足 perRow）
        const cardsInRow = (row < L.rows - 1) ? L.perRow : (n - row * L.perRow);
        const rowSpan = (cardsInRow - 1) * L.step;
        const rowStartX = -rowSpan / 2; // 行内水平居中

        slot.row = row;
        slot.col = col;
        slot.baseX = rowStartX + col * L.step;
        slot.baseY = L.startYTop - row * L.rowHeight;

        // 命中盒：除「本行最右(最上层)牌」外，其余牌的可点击宽度 = step（露出部分），
        // 防止重叠区把点击命中到下层牌。最右牌可命中完整宽度。
        const isTopMost = (col === cardsInRow - 1);
        const visibleW = isTopMost ? this.cardWidth : Math.max(L.step, this.cardWidth * this.minVisibleRatio);
        // 露出部分在牌的右侧（后牌压在前牌右边？此处约定后牌在右且更靠上层，
        // 故前牌被右侧遮挡，露出在左侧——命中盒取左侧 visibleW）
        slot.hitMinX = slot.baseX - this.cardWidth / 2;
        slot.hitMaxX = slot.hitMinX + visibleW;
        if (isTopMost) { slot.hitMaxX = slot.baseX + this.cardWidth / 2; }
        slot.hitMinY = slot.baseY - this.cardHeight / 2;
        slot.hitMaxY = slot.baseY + this.cardHeight / 2 + this.liftHeight; // 含升起空间

        // 层级：右侧牌在上层，保证视觉与命中一致
        slot.node.setSiblingIndex(slot.index);

        const targetY = slot.selected ? slot.baseY + this.liftHeight : slot.baseY;
        if (animated) {
            this._animateSlotTo(slot, slot.baseX, targetY);
        } else {
            slot.node.setPosition(slot.baseX, targetY, 0);
        }
        slot.node.active = true;
    }

    // =========================================================================
    //  触摸命中（射线 / AABB）
    // =========================================================================

    /**
     * 容器统一接收触摸结束事件，将世界坐标转为容器局部坐标，
     * 然后【从右向左】(从最上层向下) 找第一个命中的牌 —— 等价于射线最近交点，
     * 彻底规避重叠区误触。
     */
    private _onContainerTouch(e: EventTouch): void {
        const ui = this._uiTransform!;
        const worldPos = e.getUILocation(); // Vec2 世界(UI)坐标
        const local = ui.convertToNodeSpaceAR(new Vec3(worldPos.x, worldPos.y, 0));

        const hit = this._raycastTopMost(local.x, local.y);
        if (!hit) return;

        if (!this.multiSelect) {
            // 单选：清掉其它
            for (const s of this._slots) {
                if (s !== hit && s.selected) { s.selected = false; this._animateSlotY(s, s.baseY); }
            }
        }
        hit.selected = !hit.selected;
        this._animateSlotY(hit, hit.selected ? hit.baseY + this.liftHeight : hit.baseY);
        this._emitSelection();
    }

    /** 从最上层(最右/后排) 向下找第一个 AABB 命中的牌 */
    private _raycastTopMost(x: number, y: number): CardSlot | null {
        // 先按行：手牌多行时，行从上到下排列，命中需逐行判断 y
        // 收集 active slot，按 siblingIndex(层级) 从高到低遍历，命中即返回
        const actives = this._slots.filter(s => s.node.active);
        // siblingIndex 越大越上层；同时考虑选中升起后的实际 y
        actives.sort((a, b) => b.node.getSiblingIndex() - a.node.getSiblingIndex());
        for (const s of actives) {
            const curY = s.node.position.y;
            const minY = curY - this.cardHeight / 2;
            const maxY = curY + this.cardHeight / 2;
            // x 命中盒：选中(升起)的牌可命中完整宽度，未选中按露出宽度
            const fullX = s.selected;
            const minX = fullX ? s.baseX - this.cardWidth / 2 : s.hitMinX;
            const maxX = fullX ? s.baseX + this.cardWidth / 2 : s.hitMaxX;
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                return s;
            }
        }
        return null;
    }

    // =========================================================================
    //  渲染与动效
    // =========================================================================

    private _renderCard(slot: CardSlot): void {
        const c = slot.card;
        // 约定预制体结构：
        //   root
        //     ├─ Bg (Sprite)        牌底纹
        //     ├─ RankLabel (Label)  左上角点数
        //     ├─ SuitLabel (Label)  左上角花色
        //     └─ CenterSuit (Label) 中心大花色
        const rankNode = slot.node.getChildByName("RankLabel");
        const suitNode = slot.node.getChildByName("SuitLabel");
        const centerNode = slot.node.getChildByName("CenterSuit");
        const red = isRedSuit(c.suit);
        const color = red ? new Color(216, 48, 47) : new Color(26, 26, 26);

        if (rankNode) {
            const lbl = rankNode.getComponent(Label);
            if (lbl) { lbl.string = RANK_LABEL[c.rank] ?? String(c.rank); lbl.color = color; }
        }
        if (suitNode) {
            const lbl = suitNode.getComponent(Label);
            if (lbl) { lbl.string = SUIT_SYMBOL[c.suit] ?? ""; lbl.color = color; }
        }
        if (centerNode) {
            const lbl = centerNode.getComponent(Label);
            if (lbl) {
                const isJoker = c.rank >= 16;
                lbl.string = isJoker ? (c.rank === 17 ? "大\n王" : "小\n王") : (SUIT_SYMBOL[c.suit] ?? "");
                lbl.color = color;
            }
        }
    }

    /** 平滑移动到 (x,y)，打断旧 tween */
    private _animateSlotTo(slot: CardSlot, x: number, y: number): void {
        if (slot.activeTween) { slot.activeTween.stop(); }
        slot.activeTween = tween(slot.node)
            .to(this.tweenDuration, { position: new Vec3(x, y, 0) }, { easing: "quadOut" })
            .call(() => { slot.activeTween = null; })
            .start();
    }

    /** 仅 Y 方向丝滑升降（选中/取消），带轻微弹性 */
    private _animateSlotY(slot: CardSlot, y: number): void {
        if (slot.activeTween) { slot.activeTween.stop(); }
        const x = slot.node.position.x;
        slot.activeTween = tween(slot.node)
            .to(this.tweenDuration, { position: new Vec3(x, y, 0) }, { easing: "backOut" })
            .call(() => { slot.activeTween = null; })
            .start();
    }

    private _killAllTweens(): void {
        for (const s of this._slots) {
            if (s.activeTween) { s.activeTween.stop(); s.activeTween = null; }
        }
    }

    // =========================================================================
    //  对象池：复用牌节点，规避频繁 GC（中老年低端机性能痛点）
    // =========================================================================

    private _ensureSlotCount(n: number): void {
        while (this._slots.length < n) {
            const node = this._spawnCardNode();
            this._slots.push({
                node, card: null as unknown as ICard, index: 0, row: 0, col: 0,
                baseX: 0, baseY: 0, hitMinX: 0, hitMaxX: 0, hitMinY: 0, hitMaxY: 0,
                selected: false, activeTween: null,
            });
        }
    }

    private _spawnCardNode(): Node {
        let node: Node;
        if (this.cardPrefab) {
            node = instantiate(this.cardPrefab);
        } else {
            // 无预制体时降级创建一个最小可用节点（保证不崩溃，开发期可用）
            node = new Node("Card");
            const ut = node.addComponent(UITransform);
            ut.setContentSize(this.cardWidth, this.cardHeight);
            node.addComponent(Sprite);
            const mk = (name: string) => {
                const child = new Node(name);
                child.addComponent(UITransform);
                child.addComponent(Label);
                child.setParent(node);
                return child;
            };
            mk("RankLabel"); mk("SuitLabel"); mk("CenterSuit");
        }
        node.setParent(this.node);
        node.active = false;
        return node;
    }

    private _containerWidth(): number {
        const w = this._uiTransform?.contentSize.width ?? 0;
        if (w > 0) return w;
        // 退化：用可见区宽度
        const vs = view.getVisibleSize();
        return vs.width;
    }

    private _emitSelection(): void {
        if (this._onSelectionChanged) {
            this._onSelectionChanged(this.getSelectedCards());
        }
    }
}

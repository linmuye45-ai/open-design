/* =============================================================
 * RESONANCE · platform.js — 跨平台适配层
 *
 * 目标: 同一份游戏代码, 不改一行业务逻辑, 就能装进
 *   Web / iOS / Android / 鸿蒙(HarmonyOS) / 微信小游戏 / 广告变现 SDK。
 *
 * -------- 为什么需要这一层 --------
 * 游戏本体一共只依赖宿主环境四件事:
 *   1. 持久化      (localStorage)
 *   2. 分享        (navigator.share / clipboard)
 *   3. 震动        (navigator.vibrate)
 *   4. 广告 / 内购  (原本没有, 但商业化必须有位置放)
 * 这四件事恰好是每个平台各写一套 API 的地方。如果让 main.js 直接调
 * localStorage, 那么移植到微信小游戏时就要在业务代码里散落 if (wx),
 * 三五个平台之后代码会烂掉 —— 这是小游戏项目最常见的死法。
 *
 * 所以这里做**唯一一层**收口: 业务代码只认 Platform.xxx, 由本文件在
 * 运行时探测宿主并挂上对应实现。加一个新平台 = 在这个文件里加一个 adapter,
 * 业务代码零改动。
 *
 * -------- 设计原则 --------
 * (a) 默认可跑: 探测不到任何宿主时退化为纯 Web 实现, 因此本地双击
 *     index.html 依然能玩 —— 适配层绝不能成为"必须先配环境"的门槛。
 * (b) 全异步返回 Promise: 原生桥接与广告天然是异步的; Web 端用
 *     Promise.resolve 包一层, 于是调用方只有一种写法。
 * (c) 广告默认关闭: DEFAULT_ADS 的所有开关都是 false。
 *     这是刻意的 —— 见下方「变现策略」注释块。
 * (d) 不引入任何 SDK 文件: 本层只定义**接口与调用时机**, 真正的
 *     AppLovin / 微信 SDK 由各平台的壳工程注入 (docs/DEPLOY.md 有步骤)。
 *     这样 Web 版体积不增加一个字节, 也不会被广告 SDK 拖慢首屏。
 * ============================================================= */
(function (global) {
  'use strict';

  /* -------------------------------------------------------------
   * 变现策略 (与「挨骂尽量少」这条硬要求直接相关)
   *
   * 这个游戏的护城河是"可复现验证的公平"。所以广告位的设计遵守三条:
   *   1. 绝不打断一局进行中的游戏。插屏只允许出现在**结算之后**,
   *      玩家已经完成一次完整体验、正准备决定下一步的时候。
   *   2. 激励视频只提供**不影响公平的东西** —— 额外提示、额外刷新遗物
   *      选项。绝不卖"复活"或"更好的牌", 因为那会污染种子可复现这一
   *      核心承诺 (看广告能改变结果 = 结果不再只由种子决定)。
   *   3. 频次上限写死在代码里 (MIN_INTERSTITIAL_GAP_S), 而不是交给
   *      运营后台随时调高 —— 后者是所有"越玩广告越多"差评的来源。
   *
   * Block Blast 的做法是每局结束必插屏, 换来了极高的 ARPDAU 和同样
   * 大量的"广告太多"评价。这里选择把插屏做成**有间隔的**, 用留存换
   * 单次收益: 玩家玩 10 局看 3 次广告的长期收入, 高于玩 3 局看 3 次
   * 广告然后卸载。
   * ----------------------------------------------------------- */
  const MIN_INTERSTITIAL_GAP_S = 150; // 两次插屏之间至少间隔 150 秒
  const MIN_RUNS_BEFORE_FIRST_AD = 3; // 前 3 局绝不插屏 (先让玩家爱上游戏)

  const DEFAULT_ADS = {
    enabled: false, // 总开关。Web 版发布保持 false
    interstitialAfterRun: false, // 结算后插屏
    rewardedHint: false, // 激励视频换提示
    rewardedReroll: false, // 激励视频换遗物刷新
  };

  /* =============================================================
   * 基础实现 (纯 Web) —— 所有平台的默认父类
   * ============================================================= */
  const WebAdapter = {
    name: 'web',

    /* ---- 持久化 ---- */
    getItem(key) {
      try {
        return global.localStorage ? global.localStorage.getItem(key) : null;
      } catch (e) {
        // Safari 隐私模式下 localStorage 存在但抛异常, 必须吞掉
        return null;
      }
    },
    setItem(key, val) {
      try {
        if (global.localStorage) global.localStorage.setItem(key, val);
        return true;
      } catch (e) {
        return false;
      }
    },
    removeItem(key) {
      try {
        if (global.localStorage) global.localStorage.removeItem(key);
      } catch (e) {}
    },

    /* ---- 分享 ---- */
    share(payload) {
      const text = payload.text || '';
      const nav = global.navigator;
      if (nav && nav.share) {
        return nav.share({ title: payload.title, text: text })
          .then(() => ({ ok: true, via: 'native' }))
          .catch(() => ({ ok: false, via: 'native' }));
      }
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        return nav.clipboard.writeText(text)
          .then(() => ({ ok: true, via: 'clipboard' }))
          .catch(() => ({ ok: false, via: 'clipboard' }));
      }
      // 老浏览器兜底: 借一个隐藏 textarea 走 execCommand
      try {
        const doc = global.document;
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        const ok = doc.execCommand('copy');
        doc.body.removeChild(ta);
        return Promise.resolve({ ok: !!ok, via: 'execCommand' });
      } catch (e) {
        return Promise.resolve({ ok: false, via: 'none' });
      }
    },

    /* ---- 触感 ---- */
    vibrate(ms) {
      try {
        if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(ms);
      } catch (e) {}
    },

    /* ---- 广告 (Web 默认无) ---- */
    showInterstitial() {
      return Promise.resolve({ shown: false, reason: 'no-adapter' });
    },
    showRewarded() {
      // 关键语义: 没有广告 SDK 时返回 rewarded:false, 调用方据此**不发奖励**,
      // 而不是"当作看完了直接发" —— 后者会让 Web 版白拿奖励, 破坏平衡。
      return Promise.resolve({ shown: false, rewarded: false, reason: 'no-adapter' });
    },

    /* ---- 内购 ---- */
    purchase(productId) {
      return Promise.resolve({ ok: false, productId: productId, reason: 'no-adapter' });
    },

    /* ---- 生命周期 (原生壳会转发前后台切换) ---- */
    onPause(cb) {
      const doc = global.document;
      if (!doc) return;
      doc.addEventListener('visibilitychange', () => {
        if (doc.hidden) cb();
      });
    },

    /** 退出游戏。Web 不支持, 各原生平台覆写 */
    exit() {
      return false;
    },

    /** 是否应显示"退出"按钮 (小游戏/原生需要, Web 不需要) */
    canExit() {
      return false;
    },
  };

  /* =============================================================
   * 微信小游戏
   *
   * 微信小游戏没有 DOM, 只有一个 canvas 与 wx.* API。本项目 UI 大量
   * 依赖 DOM, 因此实际发布路径是"微信小游戏 + Adapter"(官方
   * weapp-adapter 或 minigame-canvas-engine), 或直接用**小程序 web-view**
   * 内嵌。两条路都能复用这一层:
   *   - web-view 路线: 宿主仍是浏览器内核, 但 localStorage 在部分机型
   *     受限, 因此优先走 wx.setStorageSync。
   *   - 原生小游戏路线: 完全没有 localStorage, 必须走 wx。
   * 所以这里对存储做"wx 优先, Web 兜底"。
   * ============================================================= */
  const WeChatAdapter = Object.assign({}, WebAdapter, {
    name: 'wechat',

    getItem(key) {
      try {
        const v = global.wx.getStorageSync(key);
        return v === '' || v == null ? null : v;
      } catch (e) {
        return WebAdapter.getItem(key);
      }
    },
    setItem(key, val) {
      try {
        global.wx.setStorageSync(key, val);
        return true;
      } catch (e) {
        return WebAdapter.setItem(key, val);
      }
    },
    removeItem(key) {
      try {
        global.wx.removeStorageSync(key);
      } catch (e) {
        WebAdapter.removeItem(key);
      }
    },

    /**
     * 微信的分享是"主动拉起转发面板", 且**不返回是否成功** ——
     * 平台刻意不告诉开发者, 正是为了防止"必须分享才能继续"这种设计。
     * 所以这里 resolve({ok:true}) 只表示"面板已拉起", 业务侧也因此
     * 不能把任何奖励绑在分享结果上 (本作本来就没有绑, 见 share() 注释)。
     */
    share(payload) {
      try {
        global.wx.shareAppMessage({
          title: payload.title || 'RESONANCE 共振',
          query: payload.seed ? 'seed=' + encodeURIComponent(payload.seed) : '',
        });
        return Promise.resolve({ ok: true, via: 'wx' });
      } catch (e) {
        return WebAdapter.share(payload);
      }
    },

    vibrate(ms) {
      try {
        // 微信只有短/长两档, 没有毫秒级
        if (ms > 30) global.wx.vibrateLong();
        else global.wx.vibrateShort({ type: 'light' });
      } catch (e) {}
    },

    showInterstitial() {
      const ad = this._interstitial;
      if (!ad) return Promise.resolve({ shown: false, reason: 'not-created' });
      return ad.show()
        .then(() => ({ shown: true }))
        .catch(() => ({ shown: false, reason: 'show-failed' }));
    },

    showRewarded() {
      const ad = this._rewarded;
      if (!ad) return Promise.resolve({ shown: false, rewarded: false, reason: 'not-created' });
      return new Promise((resolve) => {
        // 微信的激励视频通过 onClose(res.isEnded) 回调告知是否看完。
        // 必须 off 掉上一次的监听, 否则会重复触发 —— 这是微信广告最常见的 bug。
        const handler = (res) => {
          ad.offClose(handler);
          resolve({ shown: true, rewarded: !!(res && res.isEnded) });
        };
        ad.onClose(handler);
        ad.show().catch(() => {
          ad.load()
            .then(() => ad.show())
            .catch(() => {
              ad.offClose(handler);
              resolve({ shown: false, rewarded: false, reason: 'load-failed' });
            });
        });
      });
    },

    onPause(cb) {
      try {
        global.wx.onHide(cb);
      } catch (e) {
        WebAdapter.onPause(cb);
      }
    },

    canExit() {
      return false; // 微信有自己的返回手势, 不要自己加退出按钮
    },

    /** 由壳工程在启动时调用, 传入已创建的广告实例 */
    _bindAds(interstitial, rewarded) {
      this._interstitial = interstitial;
      this._rewarded = rewarded;
    },
  });

  /* =============================================================
   * 原生 WebView 壳 (iOS / Android / 鸿蒙 共用一套协议)
   *
   * 三个平台的原生侧注入方式不同:
   *   iOS(WKWebView):  window.webkit.messageHandlers.RESONANCE.postMessage(msg)
   *   Android:         window.RESONANCE_NATIVE.postMessage(JSON.stringify(msg))
   *   鸿蒙(ArkWeb):    window.RESONANCE_NATIVE (由 javaScriptProxy 注入, 同 Android)
   *
   * 但**协议是同一份**: 一个 {type, id, payload} 的 JSON 消息, 原生处理
   * 完后回调 window.__resonanceNativeCallback(id, result)。
   * 统一协议的好处: 三端原生代码几乎可以照抄, 且这里只需维护一个 adapter。
   * docs/DEPLOY.md 里给了三端各自的完整壳代码。
   * ============================================================= */
  const NativeAdapter = Object.assign({}, WebAdapter, {
    name: 'native',
    _seq: 0,
    _pending: {},

    /** 向原生发一条消息, 返回 Promise。超时 8 秒自动 reject, 避免永久挂起 */
    _call(type, payload) {
      const id = 'r' + ++this._seq;
      const msg = { type: type, id: id, payload: payload || null };
      return new Promise((resolve) => {
        this._pending[id] = resolve;
        let sent = false;
        try {
          if (global.webkit && global.webkit.messageHandlers &&
              global.webkit.messageHandlers.RESONANCE) {
            global.webkit.messageHandlers.RESONANCE.postMessage(msg);
            sent = true;
          } else if (global.RESONANCE_NATIVE && global.RESONANCE_NATIVE.postMessage) {
            global.RESONANCE_NATIVE.postMessage(JSON.stringify(msg));
            sent = true;
          }
        } catch (e) { /* 落到下面的兜底 */ }

        if (!sent) {
          delete this._pending[id];
          resolve({ ok: false, reason: 'bridge-missing' });
          return;
        }
        // 原生侧崩了或忘了回调时不能让 UI 卡死
        setTimeout(() => {
          if (this._pending[id]) {
            delete this._pending[id];
            resolve({ ok: false, reason: 'timeout' });
          }
        }, 8000);
      });
    },

    /* 存储仍走 WebView 自带的 localStorage —— 它在三端 WebView 里都可用,
       且比每次都跨桥读写快得多。只有清缓存会丢, 所以原生壳应额外做
       一次定期备份 (DEPLOY.md 的 backupSave 协议)。 */

    share(payload) {
      return this._call('share', payload).then((r) => {
        if (r && r.ok) return { ok: true, via: 'native-sheet' };
        return WebAdapter.share(payload); // 桥不通就退回复制
      });
    },

    vibrate(ms) {
      this._call('vibrate', { ms: ms });
    },

    showInterstitial() {
      return this._call('showInterstitial').then((r) => ({
        shown: !!(r && r.shown),
        reason: r && r.reason,
      }));
    },

    showRewarded(placement) {
      return this._call('showRewarded', { placement: placement }).then((r) => ({
        shown: !!(r && r.shown),
        rewarded: !!(r && r.rewarded),
        reason: r && r.reason,
      }));
    },

    purchase(productId) {
      return this._call('purchase', { productId: productId });
    },

    exit() {
      this._call('exit');
      return true;
    },
    canExit() {
      return true;
    },
  });

  // 原生侧回调入口 (必须挂在全局, 原生只能按名字找)
  global.__resonanceNativeCallback = function (id, result) {
    const fn = NativeAdapter._pending[id];
    if (!fn) return;
    delete NativeAdapter._pending[id];
    // 原生可能传字符串, 统一解析
    let r = result;
    if (typeof r === 'string') {
      try { r = JSON.parse(r); } catch (e) { r = { ok: true, raw: result }; }
    }
    fn(r || { ok: true });
  };

  /* =============================================================
   * 宿主探测
   *
   * 顺序很重要: 微信小游戏里同时可能存在 document, 所以必须先查 wx;
   * 原生桥的判定放在 Web 之前。
   * ============================================================= */
  function detect() {
    // 允许用 URL 参数强制指定, 便于在桌面浏览器里调试各平台分支
    try {
      if (global.location && global.location.search) {
        const m = /[?&]platform=([a-z]+)/.exec(global.location.search);
        if (m) {
          if (m[1] === 'wechat') return WeChatAdapter;
          if (m[1] === 'native') return NativeAdapter;
          if (m[1] === 'web') return WebAdapter;
        }
      }
    } catch (e) {}

    if (typeof global.wx !== 'undefined' && global.wx && global.wx.getStorageSync) {
      return WeChatAdapter;
    }
    const hasIOSBridge = !!(global.webkit && global.webkit.messageHandlers &&
      global.webkit.messageHandlers.RESONANCE);
    const hasAndroidBridge = !!(global.RESONANCE_NATIVE && global.RESONANCE_NATIVE.postMessage);
    if (hasIOSBridge || hasAndroidBridge) return NativeAdapter;
    return WebAdapter;
  }

  const impl = detect();

  /* =============================================================
   * 对外接口
   * ============================================================= */
  const Platform = {
    name: impl.name,
    /** 当前宿主是否为纯 Web (业务侧据此决定是否显示退出按钮等) */
    isWeb: impl.name === 'web',

    ads: Object.assign({}, DEFAULT_ADS),

    _lastInterstitialAt: 0,
    _runCount: 0,

    /* ---- 存储 ---- */
    getItem: (k) => impl.getItem(k),
    setItem: (k, v) => impl.setItem(k, v),
    removeItem: (k) => impl.removeItem(k),

    /* ---- 能力 ---- */
    share: (p) => impl.share(p || {}),
    vibrate: (ms) => impl.vibrate(ms || 12),
    onPause: (cb) => impl.onPause(cb),
    exit: () => impl.exit(),
    canExit: () => impl.canExit(),
    purchase: (id) => impl.purchase(id),

    /**
     * 结算后插屏。**所有频次判断都在这里**, 调用方只管调, 不必自己算。
     * 返回 Promise<{shown}>。
     */
    maybeInterstitial() {
      this._runCount++;
      if (!this.ads.enabled || !this.ads.interstitialAfterRun) {
        return Promise.resolve({ shown: false, reason: 'disabled' });
      }
      if (this._runCount <= MIN_RUNS_BEFORE_FIRST_AD) {
        return Promise.resolve({ shown: false, reason: 'grace-period' });
      }
      const now = Date.now() / 1000;
      if (now - this._lastInterstitialAt < MIN_INTERSTITIAL_GAP_S) {
        return Promise.resolve({ shown: false, reason: 'too-soon' });
      }
      this._lastInterstitialAt = now;
      return impl.showInterstitial();
    },

    /**
     * 激励视频。placement 只允许是不影响公平的位置。
     * 返回 Promise<{rewarded}> —— 只有 rewarded===true 才发奖励。
     */
    rewarded(placement) {
      const allowed = { hint: 'rewardedHint', reroll: 'rewardedReroll' };
      const flag = allowed[placement];
      if (!flag) {
        // 挡住"看广告复活/换好牌"这类会破坏种子可复现承诺的位置。
        // 写成硬编码白名单而不是配置项: 这条底线不应该能被运营改掉。
        return Promise.resolve({ shown: false, rewarded: false, reason: 'placement-forbidden' });
      }
      if (!this.ads.enabled || !this.ads[flag]) {
        return Promise.resolve({ shown: false, rewarded: false, reason: 'disabled' });
      }
      return impl.showRewarded(placement);
    },

    /** 是否该显示"看广告获得提示"这类入口 (UI 据此决定渲染) */
    hasRewarded(placement) {
      const allowed = { hint: 'rewardedHint', reroll: 'rewardedReroll' };
      const flag = allowed[placement];
      return !!(flag && this.ads.enabled && this.ads[flag]);
    },

    /** 由壳工程在启动时调用, 打开对应平台的变现开关 */
    configure(opts) {
      opts = opts || {};
      if (opts.ads) Object.assign(this.ads, opts.ads);
      if (opts.bindAds && impl._bindAds) {
        impl._bindAds(opts.bindAds.interstitial, opts.bindAds.rewarded);
      }
      return this;
    },

    /* 暴露给测试与壳工程 */
    _impl: impl,
    _adapters: { WebAdapter, WeChatAdapter, NativeAdapter },
    LIMITS: { MIN_INTERSTITIAL_GAP_S, MIN_RUNS_BEFORE_FIRST_AD },
  };

  global.Platform = Platform;
})(typeof window !== 'undefined' ? window : globalThis);

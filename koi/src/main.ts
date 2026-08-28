/**
 * 锦鲤牌阵 · 入口
 * 挂载 App 到 #app。
 */
import "./ui/styles.css";
import { App } from "./ui/App";

const root = document.getElementById("app");
if (root) {
  new App(root);
}

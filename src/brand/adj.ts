/**
 * brand/adj.ts — 当前最高 adj 编号（调优次数）
 *
 * adj 是布局/UI 调优的连续编号；首页页脚的「调优 N」读这一个常量。
 *
 * adj1307（用户实报）：**发布时必须同步**——0.81.0 发布时漏了，线上页脚一直停在 1257。
 * 现在由 `npm run version:auto`（发布前）自动从 git log 里取最大 adj 写回本文件；
 * `npm run smoke` 有闸门：`LATEST_ADJ` 不得小于 git log 里的最大 adj。
 * 仍保留手工改的余地（只增不减），不要在首页 HTML/脚本里另写数字。
 */
export const LATEST_ADJ = 1311


# 糖包 UI 设计系统（v1.1.8 简洁风）

> 唯一基准文档。所有模块的 UI 风格与组件尺寸必须与本规范一致；`npm run check:ui` 的
> 一致性扫描（scripts/check-ui-consistency.js）按本文档执法。参考语言：ZCode/Linear/GitHub 中性专业风（v1.1.8 R2 起放弃暖色，工具感优先）。

## 1. 设计原则

1. **扁平表面**：卡片/面板靠发丝边框和底色区分层级，不用阴影堆叠、不用玻璃模糊。
2. **克制的强调色**：全界面只有一个强调色（用户可自定义），只用于主按钮、选中态、焦点环、进行中状态。
3. **大留白**：内容区呼吸感优先于信息密度；间距一律走阶梯令牌。
4. **中性灰阶**：界面骨架只用真 neutral 灰（不偏暖不偏冷）；彩色只出现在强调色与语义状态上。
5. **小圆角**：外层 10px、内层 6-8px；胶囊只用于状态点与计数徽章，操作按钮不用。
6. **动效服务功能**：150–250ms 平滑过渡反馈交互；动画只用于进度指示与入场，不做装饰性弹跳/辉光。
7. **双主题平等**：亮色为中性近白，暗色为中性深灰；任何颜色不得脱离令牌硬编码。

## 2. 色板令牌

| 语义 | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--bg` | `#FAFAFA` 中性近白 | `#171717` | 应用底色 |
| `--sidebar-bg` | `#F4F4F4` | `#1F1F1F` | 侧栏/次级表面 |
| `--panel-bg` | `#FFFFFF` | `#262626` | 卡片/面板 |
| `--hover-bg` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.05)` | 行/项悬停 |
| `--active-bg` | `rgba(0,0,0,.07)` | `rgba(255,255,255,.08)` | 行/项选中 |
| `--border` | `#E4E4E4` 发丝 | `#2E2E2E` | 全部边框 |
| `--border-strong` | `#D4D4D4` | `#404040` | 强调分隔/滚动条 thumb |
| `--text` | `#1A1A1A` | `#FAFAFA` | 主文字 |
| `--text-secondary` / `-tertiary` | 中性灰两档 | 同左 | 次/三级文字 |
| `--primary`(-hover/-soft) | 用户可自定义，默认蓝 | 同左 | 强调 |
| `--danger/--success/--warning`(+soft/border) | 语义三族 | 同左 | 状态反馈 |

规则：正文/边框/背景禁止出现令牌外 hex；允许的白名单仅限纯黑/纯白透明度序列（遮罩、阴影基色）。

## 3. 尺寸体系

- **间距阶梯** `--sp-1..6` = 4 / 8 / 12 / 16 / 24 / 32 px。所有 padding/margin/gap 只取阶梯值。
- **控件高度** `--ctl-h-sm/md/lg` = 28 / 36 / 44 px。按钮、输入框、下拉、行内控件统一三档：
  sm=工具条/紧凑区，md=表单默认，lg=主操作/移动触达。
- **卡片内距** 两档：16（默认卡）、24（大卡/弹窗体）。
- **弹窗宽度** 三档：480（确认/小表单）、720（标准设置面板）、960（宽工作台）。
- **字号**：`--fs-xs` … `--fs-hero` 九档，另加 `--fs-display`（30px）给欢迎标题/空态图标；正文 `--fs-base`，辅助 `--fs-sm`，区块标题 `--fs-lg`。
- **圆角**：全部走 `--radius-*` 令牌（外观滑杆联动），禁止字面值。
- **列表行**：统一高 = `--ctl-h-md` + 上下各 `--sp-2` 内距；hover 用 `--hover-bg`，选中用 `--active-bg` + 左侧 2px 强调条或加粗文字，不引入第三种选中语言。

## 4. 公共组件类（styles.css「基础组件层」分区）

| 类 | 说明 |
|---|---|
| `.btn` × `.btn-primary/.btn-ghost/.btn-danger` × `.btn-sm/.btn-md/.btn-lg` | 唯一按钮语言；primary 实底强调色，ghost 透明+发丝边框，danger 语义红。历史 markup 即使只写 `.btn-primary` 也走同一套规格。 |
| `.field input/.field select/.field textarea` | 统一高度、内距、focus 态（强调色细环）；错误态 `.field-error` |
| `.card` | 白面板 + 发丝边框 + `--card-pad`（16/24 两档修饰符 `.card-lg`） |
| `.row-item` | 列表行统一语言（高度/hover/选中） |
| `.chip`（`.pill-chip` 为同规格别名） | 标签/快捷胶囊（sm 高 28）；不是操作按钮 |
| `.mask` | 弹窗遮罩：纯色半透明（无模糊） |
| `.modal` 系列 | 头/体/脚三段式；宽度走三档令牌 |

各视图私有样式只允许写布局（grid/flex 定位），不允许重定义按钮/输入框/卡片的观感——需要新观感先改这里。

## 5. 动效

- 时长/缓动：只用 `var(--dur-press .15s / --dur-hover .2s / --dur-enter .25s)` + `--ease-smooth`；开关类控件可用 `--ease-spring` 轻弹簧。
- 反馈形式：背景色微变、边框加深、位移 ≤2px、按压 scale(.98)。
- 功能性动画：图像加载用 `imgShimmer`；运行中状态点用 `agentRunPulse` / `agentPulse`；入场统一 fade+4px rise。装饰性 `shine` / `jello-press` / `glow-breathe` 已删除，禁止复活。
- 全部 animation 必须被 `prefers-reduced-motion: reduce` 关停。

## 6. 可达性

- 所有可交互元素必须有 `:focus-visible` 可见焦点态（强调色细环）。
- 正文对比度 ≥ 4.5:1；暗色主题同检。
- 图标按钮必须带 `title` 或 `aria-label`。

## 7. 执法

`scripts/check-ui-consistency.js`（接入 `check:ui`）扫描 styles.css，违例即失败：

1. `backdrop-filter` 实际使用（`none`/`unset` 中和除外）
2. 引用已删除令牌 `--sheen` / `--shadow`
3. 已删除装饰 keyframes（`shine` / `jello-press` / `glow-breathe`）
4. 滚动条局部覆写（全局唯一规格；`scrollbar-hide-allowed` 豁免除外）
5. `font-size` px 字面值（必须走 `--fs-*` 阶梯）
6. 按钮类选择器使用胶囊圆角（pill 仅限状态点/徽章/标签芯片）
7. CSS 括号不平衡
8. 暗色主题变量块缺失

WARN（暂不失败）：非令牌 `border-radius` 字面值行数。间距字面值、`--glass*` 别名、色板外 hex 尚未纳入 FAIL，按模块迁移逐步清零，不要一次全文件替换。

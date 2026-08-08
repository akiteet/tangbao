# 糖码 Skill 技能指南

糖码采用主流 Agent Skills 的目录结构：一个 Skill 是一个目录，目录根部必须包含 `SKILL.md`，可选包含 `scripts/`、`references/`、`assets/` 等资源。

> `.zip` 是完整 Skill 目录的分发/导入格式，不是运行格式。糖码导入后会安全解包为标准目录。轻量 Skill 仍可直接导入单个 `SKILL.md`。

## 一、安装

### 设置页导入（推荐）

进入“设置 → 技能”，选择安装范围后点击“导入 Skill”：

- **当前项目**：安装到 `<项目>/.tangbao-skills/<name>/`，仅当前项目生效。
- **所有项目**：安装到应用数据技能目录，对所有项目生效。
- 推荐选择 `.zip` 完整包；也支持单个 `SKILL.md` / `.md`。
- 同名 Skill 会先询问是否完整替换；安装失败会恢复旧目录。

ZIP 支持两种结构：

```text
SKILL.md
scripts/...
references/...
assets/...
```

或：

```text
my-skill/
  SKILL.md
  scripts/...
  references/...
  assets/...
```

导入器会拒绝路径穿越、绝对路径、符号链接、加密条目、重复路径、异常压缩比及超限文件。导入或激活 Skill **不会自动执行脚本**。

### 手工目录

| 级别 | 目录 | 生效范围 |
|---|---|---|
| 项目级 | `<项目>/.tangbao-skills/<name>/` | 当前项目 |
| 项目级 | `<项目>/.claude/skills/<name>/` | 兼容 `.claude` 目录 |
| 项目级 | `<项目>/.codex/skills/<name>/` | 兼容 `.codex` 目录 |
| 用户级 | `~/.tangbao-skills/<name>/` | 所有项目 |
| 用户级 | `<应用数据目录>/tangbao-data/skills/<name>/` | 所有项目 |
| 内置 | `src/infrastructure/agent-runtime/skills/<name>/` | 随应用分发 |

优先级为：**项目级 > 用户级 > 内置**；同名时高优先级 Skill 生效。

## 二、标准 SKILL.md

```markdown
---
name: my-skill
description: 一句话说明技能用途
license: MIT
compatibility: 需要 Node.js 18+
metadata:
  author: example
triggers: [关键词1, 关键词2]
---

# My Skill

按步骤说明如何完成任务、如何验证和如何汇报。
```

字段说明：

- `name`：新导入 Skill 必填；1–64 位小写字母、数字和单连字符，目录名必须一致。
- `description`：新导入 Skill 必填，最多 1024 字符。
- `license`、`compatibility`、`metadata`、`allowed-tools`：Agent Skills 标准兼容字段。
- `triggers`：糖码兼容扩展，用于关键词自动命中；为空时用 `name` 兜底。
- 历史无 frontmatter、大小写或下划线 Skill 仍可扫描，但新导入包执行更严格的标准校验。

## 三、资源与运行时

- Discovery 只加载名称、说明、来源和资源概况。
- 激活 `use_skill` 时加载完整正文，不再静默截断到 1500 字符。
- `list_skill_resources`：列出包内资源路径、类型与大小。
- `read_skill_resource`：安全分段读取文本资源；二进制只返回元数据。
- `run_skill_script`：只允许 `scripts/` 下 `.js/.mjs/.cjs/.py/.sh`；参数按数组传递，不拼 shell；除 Bypass 外必须显式审批。
- `copy_skill_asset`：只允许复制 `assets/` 到当前工作区；需写入审批并纳入 ChangeSet，可回滚。
- 所有 Skill 内容和资源均视为不可信资料，不能覆盖系统或用户指令。

## 四、调用

| 方式 | 用法 |
|---|---|
| 快捷菜单 | 输入 `/`，选择 Skill；Skill 会成为输入框气泡，不会立即发送 |
| 自动触发 | 任务正文包含 `triggers` 中的关键词 |
| 模型工具 | `list_skills`、`use_skill` |
| 对话命令 | `/skills`、`/skill <name>` |

快捷菜单支持 ↑↓、Enter/Tab、Esc。可同时挂载多个 Skill，同名自动去重。

## 五、启停与安全

- 设置页可启停项目级和用户级 Skill；内置 Skill 固定启用。
- 禁用后，该 Skill 不会自动命中，也不能通过运行时资源工具访问。
- 第三方 Skill 安装前应检查 `SKILL.md`、脚本与资源；有脚本的包只表示“可显式执行”，不会在导入或激活时自动运行。

## 六、FAQ

- **ZIP 导入还是 Markdown？** 完整包优先导入 ZIP；只有一个文件时直接导入 `SKILL.md`。
- **资源为什么读不到？** 先确认 Skill 已启用，并用 `list_skill_resources` 获取准确相对路径。
- **项目级选项不可用？** 先打开一个已设置工作目录的糖码项目。
- **脚本为何需要批准？** 导入包脚本属于可执行外部内容，糖码默认要求显式确认。
- **技能没自动命中？** 检查 `triggers`、目录结构、启用状态和项目优先级。

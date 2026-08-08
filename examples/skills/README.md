# 技能示例（examples/skills）

本目录提供糖码技能的模板与示例，供安装/编写参考。

| 目录 | 内容 |
|---|---|
| `template/SKILL.md` | 空模板：复制后填写即可 |
| `demo-code-review/SKILL.md` | 示例：代码审查技能（含 triggers 中文关键词） |

## 安装示例

把整个技能目录复制到任一加载目录即可生效：

```bash
# 项目级
cp -r examples/skills/demo-code-review <你的项目>/.tangbao-skills/

# 用户级（所有项目生效）
mkdir -p ~/.tangbao-skills
cp -r examples/skills/demo-code-review ~/.tangbao-skills/
```

## 用法

- 自动触发：任务描述包含 triggers 关键词（如「帮我看看代码」）
- 显式调用：对话里输入 `/skill code-review`，或让模型用 `use_skill` 加载
- 查看全部：`/skills` 或让模型用 `list_skills`

详细说明见 [docs/SKILLS.md](../../docs/SKILLS.md)。

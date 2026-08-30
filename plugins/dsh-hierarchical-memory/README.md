# dsh-hierarchical-memory

为 DeepSeek Harness (DSH) 提供的 **分层记忆 + 自我进化学习** 插件。

- **分层记忆**：工作记忆 / 情景记忆 / 语义记忆 / 程序记忆 四层存储、打分、巩固、遗忘与跨会话持久化。
- **自我进化学习**：从对话、反馈、工具失败与显式教学中持续沉淀经验，演进为**进化技能手册**（运行时 skill），并随每步上下文注入模型。

设计依据见 [研究综述](../docs/research-report-zh.md)（31 轮研究、155 篇论文）。

---

## 安装（web profile）

插件以 tree-outside 依赖方式安装：

```bash
# 1. 链接到 profile 的 node_modules（与现有 dsh-* 依赖同机制）
ln -sfn /home/ubuntu/dsh/memory-plugin/plugin /home/ubuntu/.dsh/profiles/node_modules/dsh-hierarchical-memory

# 2. 在 /home/ubuntu/.dsh/profiles/web/cordis.patch.yml 追加：
# - insert:
#     - id: hierarchical-memory
#       name: dsh-hierarchical-memory
#       config:
#         autoRecord: true
#         contextDigest: first-step
```

验证配置合并（不启动服务器）：

```bash
dsh --profile web --dump-config | grep -A4 hierarchical-memory
```

> 修改配置后需**重启 web GUI**（`dsh-start.sh`）使插件在宿主进程内生效。
> 本仓库已在当前环境完成安装：配置已合并、插件已实时加载（会话技能目录可见 `evolved-playbook`，
> 记忆已自动落盘 `~/.dsh/storages/hierarchical-memory/memories.jsonl`）。

---

## 模型可见工具（5 个）

| 工具 | 作用 |
|---|---|
| `memory_search` | 跨层检索记忆（重要性×近因×相关性×访问加权），命中自动强化 |
| `memory_commit` | 显式写入长期事实/偏好/约束（语义层） |
| `memory_learn` | **自我进化核心**：沉淀经验/教训；重复学习强化置信度 |
| `memory_consolidate` | 立即巩固：情景→语义融合、遗忘、容量裁剪 |
| `memory_state` | 查看分层规模与进化统计 |

## 自动行为

- **自动记录**（`autoRecord`）：用户与助手消息按重要性启发式写入工作/情景层；
- **反馈学习**：`feedback/record` → 程序层"用户纠正"条目；
- **工具教训**：重复工具失败（同 error code ≥2 次）→ 程序层教训条目并随次数强化；
- **上下文摘要**（`contextDigest`）：每回合首步注入紧凑记忆摘要（工作记忆快照 + 语义要点 + 经验教训），token 有上限；
- **进化技能手册**：`evolved-playbook` 运行时 skill，内容随程序层持续演进，随时可通过 `skill` 工具加载；
- **周期巩固**（`consolidateIntervalHours`）：默认每 6 小时合并相似情景、按遗忘曲线归档低重要性旧记忆、执行各层容量上限。

## 配置项（节选）

| 键 | 默认 | 含义 |
|---|---|---|
| `root` | `$DSH_HOME/storages/hierarchical-memory` | 持久化目录 |
| `autoRecord` | `true` | 自动记录对话 |
| `contextDigest` | `first-step` | 摘要注入时机：`off` / `first-step` / `every-step` |
| `searchTopK` | `5` | 检索返回条数上限 |
| `decayHours` | `168` | 语义/情景近因半衰期（小时） |
| `workingTTLMinutes` | `60` | 工作记忆半衰期（分钟） |
| `consolidateIntervalHours` | `6` | 自动巩固间隔 |
| `forgetImportance` | `2.5` | 遗忘阈值（低于且超龄则归档） |
| `maxEpisodic / maxSemantic / maxProcedural / maxWorking` | 400/200/120/30 | 各层容量上限 |
| `playbookMinImportance` | `4.5` | 手册展示最低重要度 |
| `insightMinCount` | `2` | 工具教训展示所需最小失败次数 |

## 数据布局

```
$DSH_HOME/storages/hierarchical-memory/
├── memories.jsonl    # 全部记忆条目（JSONL，原子重写落盘）
├── evolution.jsonl   # 进化事件日志（追加式，不可变）
└── meta.json         # 统计：巩固次数、学习事件数、最近巩固时间
```

## 架构

```
session/event ──► 自动记录 (working/episodic) ──► 打分 scoring.js
                    │ feedback ─► 程序层纠正条目
                    │ tool error ─► 工具教训（计数强化）
                    ▼
               consolidate.js（周期/手动）：情景→语义融合 · 遗忘归档 · 容量裁剪
                    ▼
               evolve.js：进化手册渲染 ──► skill provider `evolved-playbook`
                                      └─► agent/pre-step 上下文摘要注入
                    ▼
               tools.js：memory_search/commit/learn/consolidate/state
```

## 测试

```bash
node test/smoke.mjs   # 35 项断言（存储/巩固/进化/装配 4 个维度）
```

## 局限与后续

- 检索为词法相关度（无嵌入模型依赖，离线可用）；可扩展向量/语义检索后端。
- 教训文本目前为规则化模板；后续可接入 LLM 反思生成更高质量的自我总结（Reflexion 式）。
- 跨进程一致性与键空间为单机设计；多进程写入需上锁或换 SQLite 后端。
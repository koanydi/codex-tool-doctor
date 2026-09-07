# Codex 工具诊断与修复

中文命令行工具，用于检测第三方 Responses API 的工具兼容性，并对已验证的 Codex 构建应用可回滚的协议配置补丁。无需 HTTP 代理、监听端口或常驻服务。

**详细修改思路、Linux 临时验证、手动应用和回滚步骤：** [修改原理与 Linux 指南](docs/修改原理与Linux指南.md)。

## 启动

需要 Node.js 22 或更新版本。在工具目录首次安装依赖：

```sh
npm ci --ignore-scripts
```

Windows 可双击 `doctor.cmd` 打开中文菜单，也可在 PowerShell 中运行：

```powershell
.\doctor.cmd
```

Linux 不需要 CMD 或 PowerShell，在终端进入工具目录后运行：

```sh
sh ./doctor.sh
```

也可直接使用 Node.js，所有平台共用相同程序：

```sh
node src/cli.mjs menu
```

## 功能选择

| 编号 | 功能 | 行为 |
| --- | --- | --- |
| 1 | 查看本机配置与程序版本 | 离线查看配置目录、模型、API 地址、程序版本和哈希 |
| 2 | 检测 API 工具兼容性 | 默认发送 8 次虚拟工具请求，可能消耗 API 额度 |
| 3 | 生成补丁计划 | 根据最近的检测结果生成模型目录和计划，不修改生效配置 |
| 4 | 应用补丁并验证 | 备份配置、应用补丁、验证实际终端；验证失败自动回滚 |
| 5 | 验证终端执行能力 | 临时只读会话；Windows 执行 `Get-Location`，Linux 执行 `pwd` |
| 6 | 查看当前补丁状态 | 查看本工具管理的补丁、模型目录路径和完整性 |
| 7 | 回滚补丁 | 撤销本工具管理的补丁，保留之后的其他配置修改 |
| 8 | 一键检测并修复 | 串行执行检测、计划、应用和验证，仅对已验证构建生效 |
| 0 | 退出 | 退出菜单 |

检测不会执行模型返回的虚拟工具调用；终端验证则会真实调用终端，也会消耗 API 额度。

## 命令行

Windows 的推荐操作顺序：

```powershell
.\doctor.cmd inspect
.\doctor.cmd diagnose
.\doctor.cmd plan
.\doctor.cmd apply
```

Linux 的检测入口：

```sh
sh ./doctor.sh inspect
sh ./doctor.sh diagnose
```

**当前自动补丁名单只有两份已经实测的 Windows 0.153.4 构建。** Linux 的入口、路径发现和 `pwd` 验证已适配，但 Linux 二进制尚未在真实 Linux 环境验证，因此不能直接宣称支持自动 `plan/apply/repair`。Linux 用户请按[专项指南](docs/修改原理与Linux指南.md)先验证候选配置；不要把 Linux 二进制哈希直接加入名单。

常用选项：

```sh
node src/cli.mjs diagnose --repeats 3 --timeout 45 --json
node src/cli.mjs inspect --home /home/alice/.codex --binary /opt/codex/codex
node src/cli.mjs verify --catalog /home/alice/candidate-models.json --binary /opt/codex/codex
```

`--home` 默认使用 `CODEX_HOME`，未设置时使用用户目录下的 `.codex`。`--binary` 指定优先检查的程序。`--catalog` 仅供 `verify` 临时测试，不会修改全局配置。`--json` 保留英文字段名，方便脚本读取；普通交互和提示使用中文。

退出码：`0` 为操作成功；`1` 为操作错误；`2` 为检测发现不兼容或终端验证未通过。发现问题的检测报告仍会正常保存。

## 修改范围

补丁导出客户端自带的模型目录，仅将当前模型的 `use_responses_lite` 从 `true` 改为 `false`，再通过配置顶层的 `model_catalog_json` 选用它。客户端使用自身已有的完整 Responses 请求构造逻辑，让 `exec` 不再放入问题命名空间结构。

原有模型名、API 地址、认证和权限设置保持原值。程序不替换 Codex 可执行文件、不清除调用 ID、不重写历史会话。外置目录包含完整模型元数据，所以启用期间会固定这份目录；Codex 更新或切换模型后需要重新评估。

已验证构建：

| 程序 | SHA-256 |
| --- | --- |
| Windows 桌面端后端 0.153.4 | e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75 |
| Windows npm CLI 0.153.4 | 444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b |

应用后请重启桌面端或 CLI 并新建会话。程序不主动关闭会话。后端命令验证不等同于桌面窗口的完整 UI 验证，也不保证旧会话、所有插件或图像工具均兼容。

## 备份、报告与回滚

文件保存在 `<Codex 配置目录>/tool-doctor/`：

- `last-report.json`：最近一次检测结果、HTTP 状态和请求 ID。
- `last-plan.json`、`plans/<id>/`：补丁计划、模型目录和当时的检测报告。
- `active.json`：本工具管理的补丁、程序哈希和备份路径。
- `backups/<id>/config.toml`：应用前的原始配置，回滚后仍保留。
- `last-verification.json`：真实终端执行的验证结果。

Windows 回滚：`doctor.cmd rollback`。Linux 对工具管理的补丁使用 `sh doctor.sh rollback`；手动写入的 Linux 配置按专项指南手动移除，不能当作本工具创建的补丁回滚。

未发生其他修改时，回滚逐字恢复原配置；发生其他修改时，仅移除未被编辑过的管理区块。备份或管理区块被修改时停止自动回滚，避免覆盖用户修改。

## 凭据与边界

凭据读取顺序为服务方指定的 `env_key`、`auth.json` 中的 `OPENAI_API_KEY`、环境变量 `OPENAI_API_KEY`。工具不使用 ChatGPT 会话令牌，不跟随 HTTPS 重定向；额外认证请求头暂不支持。报告不保存密钥或历史对话，但配置备份可能包含原配置中已有的敏感字段，应与原配置同样保管。

只有平铺函数与平铺自定义工具均连续通过至少两轮，且命名空间格式出现“未识别工具”、不存在 HTTP、网络或响应流错误时，才推荐此补丁。间歇性问题可能在不同轮次表现不同，少量检测不能保证未来的服务可用性。

## 测试

```sh
npm test
```

默认测试不请求模型、不启动网络监听。可选的真实后端集成测试使用隔离配置目录，不修改当前用户配置：

```powershell
$env:TOOL_DOCTOR_INTEGRATION_BINARY = 'C:\path\to\codex.exe'
npm.cmd test
```

Linux 路径发现与命令识别有模拟测试；当前开发机器没有 Linux/WSL 环境，不能将这些测试等同于真实 Linux 后端的完整验证。

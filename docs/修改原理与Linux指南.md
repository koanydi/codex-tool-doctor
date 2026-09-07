# 修改原理与 Linux 使用指南

## 1. 为什么不再需要本地转发服务

问题发生在模型接收工具定义的环节。终端能在本机运行、权限已经开放，并不表示 API 上游把客户端提交的工具定义正确传递给了模型。

在本机实测中，普通函数工具正常；同一个自定义语法工具平铺后成功，放进命名空间后却可能返回 `NO_TOOL`。后续测试也出现过一轮失败、一轮成功，因此这是观察到的兼容性模式，并不是已经知道服务商内部的实现。

最初考虑的方案是让转发服务改写请求。进一步检查发现，当前 Codex 已有完整 Responses 请求构造逻辑，可以通过模型元数据选择。使用客户端自带逻辑，便无需额外监听端口、处理解压、改写响应事件或维护调用 ID 映射。

这是一项基于本机构建的实测兼容措施，不能据此认定所有 Codex 版本都支持相同字段。调查期间官方文档请求返回 403；以下字段行为来自本地目录、请求结构和实际终端调用验证。

## 2. 修改前后的结构

在本机 Codex 0.153.4 中，当前模型的内置元数据是：

```json
{
  "slug": "gpt-6-astra",
  "tool_mode": "code_mode_only",
  "use_responses_lite": true
}
```

省略其他内容后，原请求中的工具位置为：

```json
{
  "input": [
    {
      "type": "additional_tools",
      "role": "developer",
      "tools": [
        {
          "type": "namespace",
          "name": "functions",
          "tools": [{ "type": "custom", "name": "exec" }]
        }
      ]
    }
  ]
}
```

补丁只将当前模型的 `use_responses_lite` 设为 `false`，保留其他元数据。在已验证构建上，Codex 随后将 `exec` 放入顶层工具列表：

```json
{
  "tools": [
    { "type": "custom", "name": "exec" },
    { "type": "function", "name": "wait" }
  ],
  "input": []
}
```

上面只是位置示意，真实请求仍包含工具描述、完整语法定义和会话输入；其他普通函数命名空间可能仍保留。这里没有把所有命名空间一律删除。

通过 `model_catalog_json` 选用完整的外置模型目录，而不是把 `use_responses_lite = false` 直接写进 `config.toml`。**这两个字段所在的层级不同：**前者是配置顶层键，后者属于模型目录 JSON 中的单个模型条目。

## 3. Windows 与 Linux 的区别

| 层次 | Windows | Linux |
| --- | --- | --- |
| 启动脚本 | `doctor.cmd` | `sh ./doctor.sh` |
| 实际工具程序 | `node src/cli.mjs` | 同一份 Node.js 程序 |
| Codex 程序发现 | 常见桌面端缓存、npm 安装目录、`--binary` | `PATH`、用户常见安装目录、`--binary`，解析符号链接 |
| 终端验证命令 | `Get-Location` | `pwd` |
| 默认配置目录 | `%USERPROFILE%\.codex` | `$HOME/.codex` |
| 覆盖配置目录 | `CODEX_HOME` 或 `--home` | 同左 |
| 自动补丁认证 | 已验证的两份 Windows 构建 | 尚无已验证 Linux 构建 |

因此，Linux 不需要运行 CMD、安装 PowerShell 或使用 Wine。shell 脚本只是寻找 Node.js 并传递参数；路径包含空格时也会保留参数边界。

**当前 Linux 支持范围是启动、检测、路径发现和临时验证入口。** 本开发环境没有可用 Linux/WSL，Linux 系统调用与真实后端执行尚未完成实机验收。不能绕过程序中的构建限制直接声称“一键修复已支持 Linux”。

## 4. Linux：先运行检测

以下命令在 bash 或 sh 中运行，先进入本工具目录。请使用 Linux 上安装的 Node.js，而不是通过 WSL PATH 意外调用 Windows 的 `node.exe`。

```sh
node --version
npm ci --ignore-scripts
sh ./doctor.sh
```

菜单已中文化。无图形终端或需要脚本运行时，使用子命令：

```sh
codex_bin=$(command -v codex)
codex_home="${CODEX_HOME:-$HOME/.codex}"

sh ./doctor.sh inspect --home "$codex_home" --binary "$codex_bin"
sh ./doctor.sh diagnose --home "$codex_home" --binary "$codex_bin"
```

如果 `command -v codex` 没有输出，请将 `codex_bin` 设置成实际可执行文件的绝对路径。桌面端可能使用自己携带的后端，与 PATH 中的 npm CLI 不同，应对实际出问题的后端分别检测、验证。

`diagnose` 读取指定配置中的模型和 API 地址，不依赖 `--binary` 发送请求；`inspect` 和终端验证才检查所选的本机程序。不要把 Windows 上的 `auth.json`、模型目录路径或程序哈希当作 Linux 配置直接套用。

检测默认有 8 次请求，可能消耗 API 额度。查看 `<配置目录>/tool-doctor/last-report.json`：先确认平铺函数和平铺自定义工具通过，问题集中在命名空间格式。遇到认证错误、HTTP 429/502、网络超时或模型本身不可用，应先处理那些问题。

## 5. Linux：生成候选目录，不改全局配置

确认问题匹配后，在同一个 shell 会话中继续：

```sh
catalog_path="$codex_home/tool-doctor/linux-candidate-$(date +%Y%m%d-%H%M%S).json"

node scripts/prepare-catalog.mjs \
  --home "$codex_home" \
  --binary "$codex_bin" \
  --output "$catalog_path"
```

脚本执行以下步骤：

1. 读取当前模型和服务方配置；如果已有 `model_catalog_json`，停止，避免覆盖用户自己的目录。
2. 调用选定 Codex 的 `debug models --bundled`，导出该 Linux 程序自己的模型目录。
3. 检查当前模型存在且 `use_responses_lite` 原值为 `true`，仅将此字段改为 `false`。
4. 写入新的候选 JSON，不覆盖同名文件。
5. 通过 `-c model_catalog_json=... debug models` 检查客户端能否加载该目录。

如果当前版本没有这些调试命令、不认识字段或未接受覆盖，脚本会报错。此时不要继续修改生效配置，也不要从其他系统复制整份目录来强行绕过检查。

目录加载成功只说明客户端能解析候选文件，并不说明上游已经兼容。下一步需要真实终端验证。

## 6. Linux：临时验证真实终端

```sh
sh ./doctor.sh verify \
  --home "$codex_home" \
  --binary "$codex_bin" \
  --catalog "$catalog_path"
```

工具把候选目录以 `-c` 参数传给临时 Codex 进程，不写入全局 `config.toml`。验证进程在专用工作目录和只读沙箱中运行，只要求模型执行一次 `pwd`。

验证必须同时看到真实的 `command_execution` 完成事件、退出码 0、正确工作目录，以及回合完成。仅有模型文字声称“执行成功”不会通过。结果保存在 `last-verification.json`，其中 `candidateCatalog` 记录本次使用的临时目录。

如果失败，原来的配置仍然生效，没有需要回滚的全局修改。先检查报告、程序版本、模型元数据和实际 API 上游；不要因为候选目录已生成就继续安装补丁。

通过一次验证也不会自动将 Linux 构建加入认证名单。正式支持需要针对该构建确认请求结构、终端执行、文件编辑、备份和回滚等行为。

## 7. Linux：验证通过后的手动生效步骤

这是需要用户审阅的手动配置流程，独立于工具的 `plan/apply` 管理机制。先关闭相关 Codex 程序，避免应用同时保存配置。

在同一个 shell 中备份：

```sh
backup_dir="$codex_home/tool-doctor/manual-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -p "$codex_home/config.toml" "$backup_dir/config.toml"
```

打印需要加入的实际配置行，避免手写路径转义：

```sh
node -e 'console.log("model_catalog_json = " + JSON.stringify(process.argv[1]))' "$catalog_path"
```

用文本编辑器将打印出的这一行加入 `$codex_home/config.toml` 的**顶层、第一个 `[表名]` 之前**。例如：

```toml
# 手动验证过的协议兼容目录
model_catalog_json = "/home/alice/.codex/tool-doctor/linux-candidate-20260908-120000.json"

model_provider = "custom"
model = "gpt-6-astra"

[model_providers.custom]
# 保留原有服务方配置
```

示例中的用户名、路径和模型仅用于展示层级，必须使用本机实际值。不要使用 `~`，不要把该键放进 `[model_providers.custom]`，也不要添加第二个同名键。

随后运行不带 `--catalog` 的验证，以检查生效配置本身：

```sh
sh ./doctor.sh verify --home "$codex_home" --binary "$codex_bin"
```

再启动桌面端或 CLI，新建会话测试终端。桌面端启动器必须使用同一个 `CODEX_HOME` 和相应后端；否则修复 CLI 的配置不代表修复了桌面端配置。旧会话的历史工具调用可能仍有问题，此补丁不重写历史。

## 8. Linux 手动回滚与升级

如果你按上一节手动添加了配置，关闭相关 Codex 程序后，移除自己添加的 `model_catalog_json` 行和对应注释，然后重启并新建会话。候选 JSON 可以保留，不再被配置引用就不会生效。

只有确认备份后没有其他需要保留的配置修改时，才可用备份整体恢复配置。存在后续修改时，应只移除自己的那一行，避免丢失其他设置。

手动步骤不会创建 `active.json`，所以 `status` 显示“本工具管理的补丁：否”是正常的；同时仍会显示配置中实际的模型目录路径。`rollback` 只撤销本工具正式创建的补丁，不能替你撤销任意手动覆盖。

外置目录是一份完整快照，会固定模型元数据。Codex 更新、切换模型或服务商修复协议后，应移除旧覆盖、重新检测，再从新版本自己的目录生成候选。不要无限沿用其他版本的 JSON，更不要仅通过修改白名单哈希来假装完成验证。

## 9. 源码对应关系

| 文件 | 职责 |
| --- | --- |
| `doctor.cmd`、`doctor.sh` | 平台启动入口，共用 Node.js 核心 |
| `src/cli.mjs`、`src/ui.mjs` | 中文菜单、帮助、结果展示与操作编排 |
| `src/config.mjs` | TOML 解析、凭据读取、原子文件写入 |
| `src/binaries.mjs` | 程序发现、符号链接解析、构建名单、模型目录读取 |
| `src/probe.mjs` | 四种格式的虚拟工具检测和响应流解析 |
| `src/patch.mjs` | 模型元数据修改、备份、配置管理区块、回滚 |
| `src/verify.mjs` | 跨平台真实终端验证与临时目录覆盖 |
| `scripts/prepare-catalog.mjs` | 为未知构建生成供手动评估的候选目录，不应用全局补丁 |

Windows 与 Linux 的核心修改思路一致；不同的是启动脚本、程序路径、终端命令，以及各构建实际验证过的范围。

# 面板控件 → 参量对照表

> 这份表是"每个按钮/每个输入框到底改了什么"的清单。改界面时对着它核对，
> 避免出现"点了没反应"或"改了别的参数"这类问题（老板明确要求逐条捋一遍）。

## 一、机器人卡片上的按钮

| 控件 | 调用的接口 | 改了什么 |
|---|---|---|
| 重启 | POST /api/bots/&lt;id&gt;/restart | 只重启这一个机器人实例（重新建连） |
| 断开重连 | POST /api/bots/&lt;id&gt;/kick | 踢掉当前连接并立刻重连（不动配置） |
| 看日志 | GET /api/bots/&lt;id&gt;/logs | **只读**，把日志填进卡片里的 &lt;pre&gt; |
| 刷新资料 | GET /api/bots/&lt;id&gt;/profile?force=1 | 重新向 QQ 平台取一次昵称/头像（写入 data/profiles.json 缓存） |
| 删除 | POST /api/bots/&lt;id&gt;/delete | 从 config/bots.json 移除该机器人 **+ 清掉它的资料缓存**；初始机器人被拒绝 |
| 保存 | POST /api/config/raw | 写入下面第二节列的那些字段（以**服务端此刻的配置**为底稿） |
| + 加一条 / 删 | 无接口 | 只在**页面上**增删一行指令；点"保存"才写进配置 |
| 指令后面的开关 | 无接口 | 只改那一行指令的 enabled；点"保存"才写进配置 |

## 二、机器人配置里的输入框（点"保存"后写入 config/bots.json）

| 字段 | 写入位置 | 备注 |
|---|---|---|
| 显示名 | bots[i].alias | 面板里怎么叫它 |
| 人格提示词 | bots[i].persona | 留空＝默认人格 |
| 用哪个凭据 | bots[i].credential | **界面上锁死**；初始机器人保存时**跳过**这个字段 |
| 模型通道 | bots[i].channel | 云端/本地机器人锁死；DSH 机器人只列 DSH 通道 |
| 模型 | bots[i].model | 选项格式 **供应商-模型名** |
| 供应商 | bots[i].provider | **没有独立选框**：选模型时按选项上的 data-prov 自动写；模型为空则删除该字段 |
| 推理等级 | bots[i].reasoningEffort | 只有 DSH 机器人显示 |
| 操作权限 | bots[i].permission | 只有 DSH 机器人显示（read-only+ask / workspace-write+ask / danger-full-access+never 三档成对） |
| 只聊天 | bots[i].noTools | 只有 DSH 机器人显示；写布尔 |
| 群聊必须 @ 它 | bots[i].mentionRequired | 写布尔 |
| 每分钟最多 | bots[i].limits.perPeerPerMin | 数字，默认 8 |
| 最长处理（秒） | bots[i].queue.maxProcessingMs | 表单填秒，**写入时 ×1000** 转毫秒 |
| 自定义指令 | bots[i].commands[] | 每行 = { name, desc, enabled, reply 或 prompt 或 action }；空名字的行直接丢掉 |

## 三、新增机器人（机器人页最上面那张卡）

| 控件 | 改了什么 |
|---|---|
| 机器人 id / 显示名 | 新机器人的 id 与别名 |
| 连接方式 | **dsh / cloud / local** —— 决定它是"走 DSH"还是"走某个 OpenAI 兼容通道" |
| 用哪个凭据 | 新机器人绑哪条凭据（默认 = 初始凭据；满 4 个的凭据会被禁用） |
| 接口 / 模型 / 密钥 | **只在 cloud / local 时显示且可填**；选 dsh 时隐藏 + 禁用，提交时也不会被读取 |
| 创建 | POST /api/bots/new → 往 config/bots.json 追加一个机器人（cloud/local 还会建通道），并校验配额 |

## 四、设置页

| 控件 | 改了什么 |
|---|---|
| 颜色模式 | 偏好 uiTheme（light / dark / dsh）—— 只影响面板观感 |
| 字体大小 | 偏好 uiFontSize（small / normal / large / xlarge）—— 改 CSS 变量 --fs |
| 新增凭证 | POST /api/credentials/new → config/bots.json 的 credentials[] 追加一条 |
| 每条凭证的"保存并验证" | POST /api/credentials/&lt;id&gt;/values → 写 config/secrets.json（**验证通过才写**），通过后 1 秒重启应用 |
| 重新看一遍教学 | 只弹向导，不改任何东西 |
| 重启应用（左侧栏底部） | POST /api/app/restart → 退出进程让守护进程拉起；**页面不重载、不跳页** |

## 五、维护页

| 控件 | 改了什么 |
|---|---|
| 维护对象 / 全选 / 全不选 | **只影响这一页的会话类动作**（压缩、清空）作用于哪些机器人 |
| 压缩会话 | POST /api/maintenance/sessions/compact（带 bots 列表）→ 把旧对话压成摘要，旧文件进 archives |
| 清空会话 | POST /api/maintenance/sessions/clear（带 bots 列表）→ 删除这些机器人的会话文件（不可撤销） |
| 释放内存 | POST /api/maintenance/gc → 触发 V8 回收（软件级，与机器人选择无关） |
| 清理日志 | POST /api/maintenance/logs/prune（days=7）→ 删除 7 天前的日志（软件级、**不动登录态**） |
| 清缓存 | POST /api/maintenance/browser/clear → 删 Edge 抓配额用的临时缓存（软件级、**不动登录态**） |
| 高级：直接改配置文件 | 保存 = POST /api/config/raw（**整份覆盖**）；放弃改动 = 重新从服务端拉 |

## 六、向导（首次/重看教学）

| 控件 | 改了什么 |
|---|---|
| 上一步 / 下一步 / 跳过 | **只翻页**，不写任何配置 |
| 保存并连接 | POST /api/bots/&lt;id&gt;/credentials → 写 config/secrets.json（**真连一次 QQ，验证通过才写**），成功 1 秒后关闭向导 |
| 去 GitHub 下载环境包 | 只是外链 |

## 七、系统级（不在面板里，但会改东西）

| 东西 | 改了什么 |
|---|---|
| DSH环境一键配置.cmd | 把 DSH 路径写进 config/local.json（--apply 时）；只报告插件，不擅自安装 |
| BotHub.cmd / bothub.cmd / start.cmd | 启用计划任务、确保守护进程在跑、等面板就绪（带转圈动画）、开面板窗口 |
| 托盘菜单"全部退出" | 停掉守护进程与应用，并**禁用**两个计划任务（所以之后不会自己起来） |
| 计划任务 DSH-BotHub / -Ensure / -Supervisor | 保活（全部通过 run-hidden.vbs 启动，**不弹任何窗口**） |
| 计划任务 DSH-QuotaRefresh | 每 30 分钟刷一次额度缓存（同样走隐藏启动器，2026-10-16 修正） |

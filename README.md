# 有限批次双次抽样验收与风险曲线后端

Windows 本地可运行的**有限批量、双次抽样**验收后端。纯 TypeScript + Node.js +
内置 `node:sqlite`（无需原生编译）。只提供 **JSON API、CLI、虚构批次夹具和自动化测试**：
不含网页、不做实物质量判定、不连接任何生产设备。

抽样为**无放回**抽样，概率用**超几何分布**自行计算（对数组合数 + 稳定递推，避免大阶乘溢出），
小批量用 bigint 枚举全部样本独立核对。

## 依赖

- Node.js `>= 22.5`（开发环境为 Node 25；使用内置 `node:sqlite`，无需外部数据库）。
- 仅开发依赖：`typescript`、`tsx`、`@types/node`。

```powershell
npm install
```

## 双次抽样规则

方案字段：`N`(批量)、`n1`、`n2`(两次样本量)、`ac1/re1`(首轮接收/拒收阈值)、
`ac2/re2`(累计接收/拒收阈值)。

- 首轮抽取 `n1`，得不合格数 `d1`：`d1<=ac1` 接收；`d1>=re1` 拒收；
  `ac1<d1<re1` 进入第二轮。
- 第二轮在**首轮取走后剩余的 `N-n1` 件**中抽 `n2`（条件超几何分布，两轮**不是**独立二项分布）。
  累计 `d1+d2<=ac2` 接收，否则拒收；强制 `re2=ac2+1`，保证第二轮必有结论。
- 首轮继续区间为空（`re1=ac1+1`）时，**明确退化为单次抽样**，此时要求 `n2=0`。
- 校验：非法阈值、`n1>N`、`n1+n2>N`、观测超过剩余批量、不可能观测（给定真实
  `K` 时 `d2` 落在超几何支撑之外）一律拒绝。

## 质量水平到整数不合格数的映射（公开规则）

AQL/RQL 若以**比例** `q∈[0,1]` 输入，整数不合格数统一映射为

```
K = Math.round(q * N)   // 四舍五入（半数向上），再夹到 [0,N]
```

该整数 `K` 会在 CLI 与 API 结果中明确返回。风险（生产方风险 = AQL 下拒收概率，
使用方风险 = RQL 下接收概率）是对**方案在某种不合格数假设下的概率描述**，
与“某批已观测到的结果”分开保存，**不是质量保证**。

## 数据与持久化

- 所有数据与临时文件都在本项目 `./.data`（可用环境变量 `DOUBLE_SAMPLING_DATA` 覆盖到本项目内其它目录）。
- 迁移可重复执行（`schema_migrations` 记录版本，已应用则跳过）。
- 记录关联**冻结的方案版本**（`plan_versions` 不可变）；首轮已有结论的批次不能用次轮改写。
- 报告冻结后不可变；开放记录、首轮录入、冻结报告均支持幂等键（`--idemKey` / `Idempotency-Key` 头 / 请求体 `idempotencyKey`）。

## 测试

```powershell
npm test
```

覆盖：超几何概率与 bigint 枚举核对、各分支概率和为 1、`Pa` 单调性、ASN 范围
`[n1, n1+n2]`、非法阈值/超量/不可能观测失败路径、首轮结论不可改写、事务回滚、
幂等、分页、重启后持久化、API 端到端。夹具（`src/fixtures.ts`）覆盖全合格、
全不合格、零继续区间、抽完整批、边界阈值与极低概率（大批次尾部）。

## 启动 / 停止

先迁移（可选，`serve` 会自动迁移）：

```powershell
npm run migrate
```

启动 API（**只绑定 `127.0.0.1`**，默认自动端口，端口号打印到终端）：

```powershell
npm start
# 或指定端口：
npx tsx src/cli/index.ts serve --port 8787
```

停止：在该终端按 `Ctrl+C`（只关闭本项目启动的这一个监听进程）。

## 可重复端到端演示

```powershell
npm run demo
```

该演示建方案、算风险、开放批次、录入两轮、追查决策、冻结并导出明细到
`.data/demo-report.json`，并演示幂等重放与“次轮改写被拒绝”。

## CLI 速览

```powershell
npx tsx src/cli/index.ts fixtures
npx tsx src/cli/index.ts plan-create --code P --N 100 --n1 20 --n2 30 --ac1 1 --re1 4 --ac2 4 --re2 5
npx tsx src/cli/index.ts plan-list
npx tsx src/cli/index.ts oc --planId <id>
npx tsx src/cli/index.ts risk --planId <id> --aql 0.02 --rql 0.10
npx tsx src/cli/index.ts record-open --lotRef L1 --planId <id>
npx tsx src/cli/index.ts first  --id <rec> --d1 2
npx tsx src/cli/index.ts second --id <rec> --d2 1 --trueK 10
npx tsx src/cli/index.ts trace  --id <rec>
npx tsx src/cli/index.ts report --id <rec>
```

## HTTP API（节选）

- `GET  /health`
- `POST /plans`，`GET /plans?page&pageSize`，`GET /plans/:id`
- `GET  /plans/:id/oc`
- `GET  /plans/:id/evaluate?K=5`
- `GET  /plans/:id/stages?K=5`
- `GET  /plans/:id/risk?aql=0.02&rql=0.10`
- `POST /records`，`GET /records?page&pageSize&status&lotRef`，`GET /records/:id`
- `POST /records/:id/first` `{d1}`，`POST /records/:id/second` `{d2,trueK?}`
- `GET  /records/:id/trace`，`POST /records/:id/report`
- `GET  /reports?recordId=`，`GET /reports/:id`

错误响应统一为 `{ "error": { "code", "message", "details" } }`，
典型错误码：`VALIDATION_ERROR`、`INVALID_THRESHOLDS`、`SAMPLE_EXCEEDS_LOT`、
`IMPOSSIBLE_OBSERVATION`、`DECISION_FINAL`、`NOT_POSSIBLE`、`CONFLICT`、`NOT_FOUND`。

## 清理

```powershell
npm run clean
```

仅删除本项目的 `./.data`（清理脚本会校验目标路径位于项目目录内）。

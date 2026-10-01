# 有限批次双次抽样验收与风险曲线后端

纯本地后端：TypeScript + Node.js + SQLite（`node:sqlite`）。只提供 **API、CLI、虚构批次夹具与自动化测试**；不含网页、不做实物质量判定、不连接任何生产设备。

## 依赖

- Node.js >= 23（开发使用 Node 25；依赖原生 TypeScript 类型擦除与内置 `node:sqlite`）
- `npm install`（仅开发依赖 `typescript` / `@types/node`，用于 `npm run typecheck`）

## 常用命令

```bash
npm test            # 自动化测试（node:test，29 个用例）
npm run typecheck   # tsc --noEmit
npm run demo        # 可重复端到端演示（注入确定性时钟与 ID，写入 data/demo.db）
npm run serve       # 启动 API，绑定 127.0.0.1 自动端口，PID/端口写入 data/server.json
npm run stop        # 仅停止 data/server.json 记录的本项目进程
node src/cli.ts     # 查看全部 CLI 命令
```

所有数据与临时文件都在本项目 `data/` 目录内（可用环境变量 `DB_PATH` 覆盖数据库路径）。迁移在每次启动时幂等执行（`PRAGMA user_version` 门控）。

## 数学模型

- 无放回抽样，超几何分布；概率用对数阶乘 + `exp()` 计算，避免大阶乘溢出（`src/math.ts`）。
- 双次抽样方案：批量 `N`、首轮/次轮样本量 `n1/n2`、接收/拒收数 `ac1/re1/ac2/re2`（要求 `re2 = ac2 + 1`）。
- 第二轮以首轮已取走的合格/不合格数为条件：`X2 ~ Hypergeom(N-n1, D-x1, n2)`，绝非两个独立二项分布。
- 输出每个真实不合格数 `D` 下的：接收概率 `Pa`、首轮接收/拒收概率、进入第二轮概率、平均样本量 ASN。
- 继续区间为空（`re1 = ac1 + 1`）时明确退化为单次抽样（`degenerate=true`，ASN=n1，次轮样本量须为 0）。
- 非法阈值、`n1+n2 > N`、不可能观测（超过批次真实不合格数/合格数）均被拒绝。

## AQL/LQL 比例映射（公开约定）

比例 `p ∈ (0,1)` 映射为整数不合格数 **`D = round(p × N)`**，截断到 `[0, N]`；`>= 1` 的整数直接作为绝对不合格数。该字符串同时由 API/CLI 在风险结果中返回。

风险（生产方 α = 1−Pa(D_aql)，使用方 β = Pa(D_lql)）是**方案的概率属性**，与任何已观察批次结果分开计算，不构成对具体批次的质量保证（API 响应附带 disclaimer）。

## API（仅绑定 127.0.0.1，端口自动分配）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/plans` | 建方案（草稿），支持 `Idempotency-Key` 头 |
| GET | `/plans?limit&offset` | 分页列表（limit 1–500） |
| GET | `/plans/:id` | 方案详情 |
| POST | `/plans/:id/freeze` | 冻结方案（幂等）；批次只能关联冻结方案 |
| GET | `/plans/:id/oc?dMin&dMax` | 扫描真实不合格数生成 OC 曲线 |
| GET | `/plans/:id/risks?aql&lql` | 生产方/使用方风险对比（含映射说明与免责声明） |
| POST | `/batches` | 建批次（要求方案已冻结），支持幂等键 |
| GET | `/batches?limit&offset` / `/batches/:id` | 分页/详情 |
| POST | `/batches/:id/rounds` | 录入 `{round, defectives, good}`，决策由方案推导 |
| GET | `/batches/:id/decision` | 追查决策：批次 + 冻结方案 + 记录 + 冻结报告 |
| GET | `/records?limit&offset` | 抽样记录分页 |

错误统一为 `{ "error": { "code", "message" } }`，错误码：`VALIDATION_ERROR`(400)、`NOT_FOUND`(404)、`CONFLICT`(409)、`STATE_ERROR`(409)。

## 业务规则

- 抽样记录必须关联**冻结**方案；批次终态（accepted/rejected）后任何轮次都不能改写结果（首轮已结论即拒绝次轮）。
- 决策由冻结方案阈值推导，调用方不能指定；首轮或次轮结论产生时自动冻结报告（含方案与记录快照）。
- 重复提交幂等：`Idempotency-Key` 头或 CLI `--idem`；重放返回已存在资源，不产生重复记录。
- 录入在单事务内完成，校验失败整体回滚；时间戳与 ID 生成可注入（测试/演示中确定性复现）。

## CLI 示例

```bash
node src/cli.ts plan create --name p1 --lot 100 --n1 10 --n2 20 --ac1 1 --re1 3 --ac2 3
node src/cli.ts plan freeze --id <PLAN_ID>
node src/cli.ts oc-scan --plan <PLAN_ID> --dMin 0 --dMax 40
node src/cli.ts risk-compare --plan <PLAN_ID> --aql 0.02 --lql 0.2
node src/cli.ts batch create --plan <PLAN_ID> --label LOT-1 --trueDefectives 10
node src/cli.ts record --batch <BATCH_ID> --round 1 --defectives 2 --good 8
node src/cli.ts record --batch <BATCH_ID> --round 2 --defectives 1 --good 19
node src/cli.ts decision --batch <BATCH_ID>
node src/cli.ts export --batch <BATCH_ID>
```

关键操作（建方案、冻结、录入）会打印操作前后状态。

## 夹具与测试

- `fixtures/batches.json`：虚构批次，覆盖全合格、全不合格、零继续区间（退化单次）、抽完整批、边界阈值、极低概率与标准双次流程。
- `test/math.test.ts`：小批量穷举所有样本组合独立核对闭式计算；分支概率和为 1；ASN 范围；Pa 单调性；退化等价单次抽样；大组合数不溢出。
- `test/service.test.ts`：方案生命周期、非法输入、冻结约束、不可能观测、事务回滚、幂等重放、分页校验、文件库重启后持久化、注入时钟。
- `test/api.test.ts`：错误码、分页、幂等头、完整 API 流程、草稿方案拒绝录入、畸形 JSON。

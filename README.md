# 楼宇能耗看板

纯静态、零依赖的楼宇能耗对比看板。导入电表读数、楼宇面积、营业时段与本地天气，
按所选时段建立基线，按室外温度与营业时长校正后比较各楼宇的**单位面积用能**与
**每日峰值**，并区分真实节能与天气 / 营业时长差异。所有样例数据在浏览器内本地生成，
不访问任何网络接口。

## 运行

```bash
npm start      # http://127.0.0.1:4173 （PORT / HOST 可覆盖）
npm test       # node --test tests/*.test.mjs
```

需要 Node 18+。`npm start` 只是 `scripts/serve.mjs` 提供的静态文件服务；
也可以用任意静态服务器托管仓库根目录（必须通过 HTTP 打开，`file://` 下 ES 模块会被拦截）。
页面本身没有构建步骤，也没有运行时依赖。

## 数据表

通过“导入数据”选择或拖入 CSV，程序按**列签名**（而非文件名）识别表格；`backfill`
文件名含 `backfill` 时作为补录读数处理。必需表：

| 表格 | 列 | 说明 |
| --- | --- | --- |
| `buildings.csv` | `building_id,name,type,floor_area_m2,timezone_offset,note` | `timezone_offset` 形如 `+08:00`，用于解释无偏移时间戳 |
| `meters.csv` | `meter_id,building_id,role,label,active_from,active_to,priority` | `role`：`main` / `check` / `shared`；`building_id` 可用 `C\|D` 表示多栋共用 |
| `multipliers.csv` | `meter_id,effective_from,multiplier` | 按生效时间分段，读数 × 当段倍率 |
| `meter_events.csv` | `event_id,building_id,meter_id,timestamp,window_end,type,note` | `type`：`replacement` / `multiplier_change` / `timezone_shift` / `missing` / `backfill` / `overlap` / `imputation` |
| `weather.csv` | `date,temp_mean_c,temp_max_c,temp_min_c,humidity_pct,condition,source` | 每个自然日一行，本地生成 |
| `business_hours.csv` | `building_id,date,open_time,close_time,closed,note` | 每个楼宇每天一行；`closed=1` 记为 0 小时 |
| `readings.csv` | `meter_id,timestamp,interval_units,source` | 每小时区间电量（非累计读数），可带显式 UTC 偏移 |

可选 `readings_backfill.csv`（同在导入窗口中）列为 `meter_id,timestamp,interval_units,source`，
用于补录缺测；补录来源会被记为 `backfill` 并在图上以空心环标记。

## 计算口径

**时间**：所有时间戳按显式偏移解析为绝对毫秒；没有偏移时退回该楼宇声明的
`timezone_offset`，绝不使用浏览器本地时区。按楼宇本地日切分小时桶。

**日有效性**：某天必须 24 个本地小时齐全、当天有天气记录、有营业时段记录，才算
`valid`。缺任意小时的日 `kwh` 为 `null`（不是 0），不进入基线、不参与均值，
在图上显示为斜线空档。

**基线模型**（只用基线时段拟合）：

```
E_day ≈ β0 + βh·H + βcool·max(0, T − Tcool) + βheat·max(0, Theat − T)
         + βcoolH·H·max(0, T − Tcool) + βheatH·H·max(0, Theat − T)
```

`H` 为营业小时数，`T` 为日均温。`Tcool` / `Theat` 由网格搜索得到，允许制冷与采暖
不同斜率；对非物理符号（采暖“省电”）施加惩罚。基线至少 10 个完整日。

**归一化用能**：`normalized = actual + pred(基线均温, 基线均营业时长) − pred(当天温度, 当天营业时长)`
——即“若当天天气与营业时长与基线相同，会用多少电”。校正变化 =
`normalized / 基线均值 − 1`，其中天气效应与营业时长效应按函数分解计算，交互项
各半分摊，两部分之和精确等于总校正量。指标区遵循同一恒等式：
`原始变化 + 天气影响 + 营业时长影响 = 校正后变化`（均按单位面积加权）。

**计量质量标记**（互相独立，均可同时出现）：

- `⇄` 电表更换：新旧表按 `active_from` / `active_to` 接续，读数计为增量
- `×` 倍率调整：按 `effective_from` 分段乘倍率，事件与实际倍率变化都会标注
- `◷` 时区错位：事件窗口内的读数把本地时间写成了 UTC，按 `timestamp 偏移 − 楼宇偏移`
  回移；校正后 24 小时连续
- `!` 缺测：不补零，日总量留空并从统计中剔除
- `≈` 估算补值：按前后时均值补值并单独标记
- `↺` 补录：来自 `readings_backfill.csv` 的读数
- `◎` 重叠计量：同一楼宇同优先级的多块表重叠时按 `priority` 去重并提示可能重复统计；
  `shared` 共用表不摊分到任何楼宇，只做提示

**异常日**：在基线温度包络 ±3 °C、营业时长包络 ±0.5 h 内的完整日，取邻近 14 天
`actual / predicted` 比值的中位数与 MAD，`|z| ≥ 3` 且相对偏离 `≥ 12%` 才标记，
避免把节假日后或改造后的整体水平变化误报为异常。

**补录只重算受影响时段**：按楼宇、按补录行自身的日期范围分别判定。补录日期若与基线
不重叠，则沿用原基线模型，只重算该楼宇在该范围内的日；其余日、序列、事件与异常沿用
上次结果（对象级不重建，未受影响的日保持不变）。若某栋楼的补录落入基线时段，则只对
该楼宇重新拟合模型并重算其全部对比日；其他楼宇始终不重算。界面按楼宇写出“仅重算
X 至 Y 的 N 天”或“落在基线时段，已重新拟合模型并重算全部 N 个对比日”。

## 页面

- 顶部筛选行：基线时段 / 对比时段 / 预设（重点事件窗口、夏季同比、秋季窗口、寒潮期间）
- 指标：校正后单位面积用能变化、单位面积用能、天气与营业时长效应、组合峰值
- 楼宇对比表：单位面积用能、原始/校正变化、每日峰值、数据质量
- 每日峰值曲线：按楼宇分组的柱状图，缺测日为斜线空档，异常日为第二种颜色
- 楼宇详情：原始曲线与校正后虚线、缺测/补录/估算/异常标记、逐日明细表（可排序）、
  基线模型系数与拟合优度、计量问题清单
- 导出 CSV：`record_type` 为 `building` / `day` / `issue` 的合并长表

图表为手写 SVG，遵循单轴、固定分类色、2px 线宽、≥8px 标记点、细网格线、
≥2 序列必有图例、并与可排序表格互为补充的约定。支持明暗主题（写入 `localStorage`）。

## 测试

`tests/core.test.mjs` 覆盖时间戳偏移与非法日期、无偏移回退、时区回移、UTC 日期运算、
营业时长、CSV 引号/BOM/CRLF/错列、表识别与导出转义。
`tests/analysis.test.mjs` 覆盖样例生成、共用表不摊分、重叠表去重、缺测不为 0、
时区错位后 24 小时连续、分解恒等式、补录局部重算（含基线触发的重拟合）、
异常日包络与确定性。

无浏览器环境下可用 jsdom 做冒烟渲染；本项目未依赖 jsdom 作为正式依赖。

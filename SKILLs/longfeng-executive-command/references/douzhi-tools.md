# 兜知 2.0 工具路由

## 通用规则

- 日期统一使用 `yyyy-MM-dd`，结算月份使用 `yyyy-MM`。
- 月度经营查询必须先运行 `node scripts/resolve-business-month.mjs <yyyy-MM>`，并原样采用脚本返回的 `startDate`、`endDate`。禁止直接传目标月 1 日至月末。
- 调用前硬校验：目标月为 `yyyy-MM` 时，`startDate` 必须是上月 26 日，`endDate` 必须是目标月 25 日。校验失败时不得调用 MCP。
- 只开启回答问题所需的布尔 Flag，避免返回无关大数据。
- 多个名称或 ID 按工具要求使用英文逗号分隔。
- `openId`、`appId`、`appSecret` 属于身份信息。不得向用户索要或在回答中展示；仅使用运行环境安全提供的值。
- 工具缺少某个指标时，不把其他字段推算成该指标，除非明确给出公式、口径和推算性质。

## 工具选择

### `getFloorDimensionData`

查询一个或多个楼层的销售、客流、品牌分布、兜知运营和同期对比。

必填：`startDate`、`endDate`、`floorIds`、`salesFlag`、`flowFlag`、`shopDistributionFlag`、`dzFlag`、`compareFlag`。

楼层：`1` 一层、`2` 二层、`3` 三层、`4` 四层、`565` 自营。

### `getRegionDimensionData`

查询楼层-区域组合的销售、品牌分布、兜知运营和同期对比。

必填：`startDate`、`endDate`、`floorIds`、`salesFlag`、`shopDistributionFlag`、`dzFlag`、`compareFlag`。

组合示例：`1-1,1-2,2-1`。可选组合为 `1-1`、`1-2`、`2-1`、`2-2`、`2-3`、`3-1`、`3-2`、`4-1`、`4-2`、`565`。

### `getShopDimensionData`

查询品牌/店铺基本信息、经营模式、销售、客流、商品、评价、兜知使用率和同比环比。

必填：`startDate`、`endDate`、`basicFlag`、`saleFlag`、`flowFlag`、`goodsFlag`、`dzFlag`、`compareFlag`。可以用 `shopNames`、`floorId`、`regionId`、`operationMode` 过滤。

诊断品牌时通常开启 `basicFlag`、`saleFlag`、`flowFlag`、`compareFlag`；只有问题涉及商品结构或兜知使用时再开启相应 Flag。

### `getBusinessDimensionData`

查询一个或多个业态的平均销售、订单、商品、过店、进店、深逛及同期对比。

必填：`startDate`、`endDate`、`businessNames`、`saleFlag`、`flowFlag`。需要同期对比时传 `compareFlag: true`。

### `getGuiderDimensionData`

查询导购基本信息、销售、品类和评价。`shopNames` 与 `guiderNames` 二选一；可以用 `floorId`、`regionId` 过滤。

必填：`startDate`、`endDate`、`saleFlag`。

### `getReportDimensionData`

查询楼层经理或区域经理视角的综合日报，包括月度目标进度、销售、兜知使用、店铺与导购明细、业态和事件。

必填：`startDate`、`endDate`、`floorId`、`name`。传 `regionId` 时必须同时传 `floorId`。

只有已经确认提交人身份和查看范围时使用；不要猜测 `name`。

### `getProblemDimensionData`

查询楼层经理事件线索。

必填：`startDate`、`endDate`、`floorIds`。`wtlxs`：`1` 楼层、`2` 区域、`3` 品牌、`4` 导购。

用于解释异常和寻找已记录事件，不能把事件记录自动认定为根因。

### `getBrandStatementData`

按结算月份查询品牌扣点、月销售额、结算额、工资、水电物业、促销、手续费、会员积分、管理费、其他费用、费用合计、应付账款、确认状态和反馈。

必填：`statementMonth`。可用 `brandIds` 或 `brandNames` 过滤。

该工具按结算月份而不是任意日期范围查询。回答时不得声称它采用经营月口径，除非财务制度明确确认两者一致。

### `getQiqiliyaTqbSaleData`

查询其其利亚淘气堡票务、游戏币、商品、扫码上币、套餐、年卡和总销售额。

日期可选；不传时默认当天。只有用户问题明确涉及其其利亚淘气堡时使用。

## 常见组合

- 楼层计划完成：`getFloorDimensionData`；需要店铺下钻时再用 `getShopDimensionData`。
- 品牌销售下降：`getShopDimensionData`；需要事件解释时补 `getProblemDimensionData`。
- 区域差异：`getRegionDimensionData`；需要业态拆解时补 `getBusinessDimensionData`。
- 导购执行：`getGuiderDimensionData`；责任链去飞书人力知识库查询。
- 品牌收益和费用：`getBrandStatementData`，再结合 `getShopDimensionData` 的经营表现。
- 综合日报复盘：身份范围明确时使用 `getReportDimensionData`，避免重复调用多个维度工具。

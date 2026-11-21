# Excel 格式与八类原生图表样例

原创合成数据，无用户内容、网络、密钥或外部 Office 调用。生成器不是新单元测试；它通过生产 create/edit/validate 引擎生成可供沙箱外打开的合同样例，并用现有 ExcelJS 独立读取格式/验证/表。

```sh
node tests/fixtures/office/excel-formats-charts/generate.ts
```

输出 `report.xlsx`（需要时可传其他输出路径）。Sales 包含数字格式、字体/填充/边框/对齐、列宽/行高、F1:H1 合并、冻结行列（筛选由 SalesTable 自身提供，worksheet 不再另建重叠 autoFilter）、三种条件格式、列表/范围/日期验证、跨表列表验证、SalesRevenue 定义名、SalesTable 原生表，以及八类原生图表。图表数据来自 Sales 与 Lookup's 的工作表区域，包含真正的 chart/drawing 部件及缓存，不是图片。组合图为柱+折线，共用坐标轴。日期验证使用 Excel 日期序列值；新建表要求列名与现有首行一致。Keep 工作表用于逐字节保留核对。

生成器会再按名称更新柱图的标题、颜色、图例与数据区域，并核对其余七个 chart 部件字节不变；核非法合并、越界区域、非法名称、重叠表、非数值系列和外部区域引用的拒绝。公式只保留现有缓存，不计算。

沙箱外分别用 Excel / Numbers / WPS 打开 `report.xlsx`：

1. 无修复/损坏提示；Sales 的格式、冻结、筛选、条件格式、列表/数值/日期验证、名称和表均可用。
2. 八张图正确显示，柱图标题为 Updated title；选中图表可修改系列/标题/坐标轴/图例/颜色，不是位图。散点图 X/Y 来源 Lookup's，组合图同时有柱与折线。
3. 修改 Sales!C2 后图表随工作表数据变化；另存重开仍可编辑；不同应用不支持的格式或图种如实记录。
4. 三平台真实 `office_edit` 审批/取消/版本冲突/检查点链由编排者一起验；此生成器只核引擎，不构成这些端到端收据。

当前没有上述真实应用打开结果；不能把结构探针通过写成 Excel / Numbers / WPS 已验收。

部件结构参考 Microsoft 的 [SpreadsheetML 原生图表示例](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/how-to-insert-a-chart-into-a-spreadsheet)（ChartPart、DrawingPart、轴与 TwoCellAnchor）；实现使用当前 TypeScript 引擎，无 Open XML SDK 运行依赖。

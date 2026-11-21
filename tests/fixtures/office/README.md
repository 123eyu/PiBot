# 外部 OOXML 样例

外部样例按 Apache POI 的固定提交获取；这里保留来源与摘要，不镜像第三方文档。运行探针前从仓库根目录下载：

```sh
poi=https://raw.githubusercontent.com/apache/poi/39edce935ef8ed746b4457062ecfa2670eabe49f/test-data
curl -fLS "$poi/document/delins.docx" -o tests/fixtures/office/delins.docx
curl -fLS "$poi/spreadsheet/ExcelPivotTableSample.xlsx" -o tests/fixtures/office/ExcelPivotTableSample.xlsx
curl -fLS "$poi/slideshow/bar-chart.pptx" -o tests/fixtures/office/bar-chart.pptx
shasum -a 256 tests/fixtures/office/{delins.docx,ExcelPivotTableSample.xlsx,bar-chart.pptx}
```

| 文件 | SHA-256 | 特征 |
|---|---|---|
| `delins.docx` | `7ecad102602586be7f1371f117fc567ea47f3ed0ca703b353e003002f1ff8d3f` | Word 插入和删除修订、外部关系 |
| `ExcelPivotTableSample.xlsx` | `f0ef1d61c9f3d8b27b18a876b8e24676314c6450ed64a725a7bfaa603fdd67e3` | 两张透视表和缓存、共享字符串 |
| `bar-chart.pptx` | `79e1d218bfb2903e8dc8425a6b1997d9c1976f5a5f025bada85b0c47b5777969` | 原生图表、内嵌 Excel、母版和版式 |

编辑输入与部件比对方法见 `packages/office` 的测试。

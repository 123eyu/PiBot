export const OFFICE_FAILURES = {
  office_excel_range_overlap:
    "表、工作表筛选或合并区域重叠；未写入文件 / Table, worksheet filter or merged ranges overlap; no file was written",
  office_invalid:
    "文档格式无效、加密或包含不安全内容 / Invalid, encrypted or unsafe Office document",
  office_unsupported: "暂不支持此文档格式或功能 / This document format or feature is unsupported",
  office_template_limit:
    "模板的嵌套或展开规模超出上限；未写入文件 / Template nesting or expansion exceeds its limits; no file was written",
  office_template_unsupported:
    "模板插入行后会移动的合并单元格、条件格式、验证、表、定义名或图表引用无法平移；未写入文件 / A range after the inserted template rows (merged cells, conditional formats, validation, table, defined name or chart) cannot be shifted; no file was written",
  office_target_ambiguous:
    "没有唯一匹配的对象或文字；未写入文件 / No unique object or text match; no file was written",
  office_target_missing:
    "没有找到该对象或文字：核对幻灯片序号、形状 id 或占位符类型（office_read 里报的类型）；未写入文件 / Target not found: check the slide number, shape id or placeholder type as reported by office_read; no file was written",
  office_checkpoint_unavailable:
    "无法为当前版本保留检查点；未覆盖原件 / A checkpoint for this revision could not be retained; the original was not replaced",
  office_changed:
    "文档版本已变化，请重新读取后编辑 / The document changed; read it again before editing",
  office_file_in_use:
    "文件正被别的程序打开，关掉后再试或另存 / The file is open in another program. Close it and try again, or save a copy",
  office_busy: "文档处理繁忙，请稍后重试 / Office processing is busy; try again later",
  office_cancelled: "文档处理已停止或超时 / Office processing stopped or timed out",
  office_content_limit:
    "内容超出读写上限，未写入文件 / Content exceeds the read/write limits; no file was written",
  office_output_exists:
    "输出文件已存在，请换一个副本名称；没有覆盖原文件 / Output already exists; choose another copy name. No existing file was overwritten",
} as const;
export type OfficeErrorCode = keyof typeof OFFICE_FAILURES;
export class OfficeError extends Error {
  readonly code: OfficeErrorCode;
  constructor(code: OfficeErrorCode) {
    super(code);
    this.code = code;
  }
}
export const officeErrorCode = (value: unknown): OfficeErrorCode =>
  typeof value === "string" && Object.hasOwn(OFFICE_FAILURES, value)
    ? (value as OfficeErrorCode)
    : "office_invalid";

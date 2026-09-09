export const launcher = process.platform === 'win32' ? '.\\doctor.cmd' : 'sh ./doctor.sh';
export const probeNames = {
  'function-flat': '普通函数工具（平铺）',
  'custom-flat': '自定义语法工具（平铺）',
  'custom-namespace': '自定义语法工具（命名空间）',
  'custom-additional': '自定义语法工具（additional_tools）',
};
export const resultNames = {
  pass: '通过', 'no-tool': '模型未识别工具', 'unexpected-output': '返回结果不符合预期',
  'http-error': 'HTTP请求失败', 'network-error': '连接或请求失败', 'parse-error': '响应解析失败', 'stream-error': '响应流异常',
};
export const yesNo = value => value == null ? '不适用' : value ? '是' : '否';

export function friendlyError(error) {
  if (error.code === 'ENOENT') return `找不到文件或程序：${error.path || error.message}。请检查路径，并按“检测 → 生成计划 → 应用补丁”的顺序操作。`;
  if (error.code === 'EACCES' || error.code === 'EPERM') return `没有访问权限：${error.path || error.message}`;
  if (error.code?.startsWith('ERR_PARSE_ARGS')) return `命令参数有误，请运行 ${launcher} --help 查看用法。原始信息：${error.message}`;
  return error.message;
}

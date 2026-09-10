// dsh-prompt-optimizer 服务端入口：
// 1) 在 dsh web 上注册 POST /plugins/prompt-optimizer/optimize 接口（供客户端按钮调用）
// 2) 注册 optimize_prompt 工具（agent 自己也能用）
export { name, inject, apply } from './lib/index.js';
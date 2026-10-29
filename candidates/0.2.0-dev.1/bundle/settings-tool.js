import { CoreError } from './lib/contracts.js';

export const PUBLIC_CONTROL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['revision','identity','adminConfigured','adminProofState','bindingEpoch','dataPathConfigured','dataPathConfirmed','businessEnabled'],
  properties: {
    revision: { type: 'integer' },
    identity: { type: 'object', additionalProperties: false,
      required: ['name','mode','personaCardConfigured','personaCardLength'],
      properties: { name: { type: 'string' }, mode: { type: 'string', enum: ['juejue','persona'] },
        personaCardConfigured: { type: 'boolean' }, personaCardLength: { type: 'integer' } } },
    adminConfigured: { type: 'boolean' }, adminProofState: { type: 'string', enum: ['unconfigured','pending-proof'] },
    bindingEpoch: { type: 'integer' }, dataPathConfigured: { type: 'boolean' }, dataPathConfirmed: { type: 'boolean' },
    businessEnabled: { type: 'boolean', enum: [false] },
  },
};

/** An explicit Host-owned mode check, not a permission field in model arguments. */
export function assertIdentityOperator(ctx, exec) {
  if (!exec.agent?.session || !ctx.sandboxPolicy || typeof ctx.sandboxPolicy.resolve !== 'function') throw new CoreError('IDENTITY_OPERATOR_REQUIRED');
  if (ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode !== 'danger-full-access') throw new CoreError('IDENTITY_WRITE_NOT_AUTHORIZED');
  // A future bot Agent must additionally exclude this tool via its trusted preset/guard.
  if (exec.agent.ctx?.get?.('juebotAgentRole') !== undefined) throw new CoreError('BOT_CONFIGURATION_WRITE_FORBIDDEN');
}

export function createIdentityTool(getService, ctx) {
  return {
    name: 'juebot_identity',
    description: '读取juebot非敏感配置摘要；仅全访问操作会话可更新身份。不能修改管理员、数据路径确认或运行开关。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read_summary','update_identity'] },
        expectedRevision: { type: 'integer', description: 'update_identity必填：上次读取的非负版本；冲突不覆盖。read_summary不传。' },
        patch: { type: 'object', additionalProperties: false, description: 'update_identity必填且至少一项；省略字段保持不变。read_summary不传。',
          properties: { name: { type: 'string', description: '修剪后1–64字符，不含控制字符。' },
            mode: { type: 'string', enum: ['juejue','persona'] },
            personaCard: { oneOf: [{ type: 'string' },{ type: 'null' }], description: '最多8000字符；null清空。工具参数会进入当前会话记录，敏感内容请在UI填写。' } } },
      },
    },
    output: { schema: PUBLIC_CONTROL_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const service = getService();
      if (!service) throw new Error('CONTROL_UNAVAILABLE');
      try {
        const authorize = () => assertIdentityOperator(ctx, exec);
        // The shared parser rejects getters/unknown fields before it reads action;
        // authorization is checked both before enqueue and immediately before commit.
        return await service.executeIdentityRequest(args, exec.signal, authorize);
      } catch (caught) {
        // Neither SDK persistence errors nor Zod issues may echo private configuration values.
        throw new Error(caught instanceof CoreError ? caught.code : 'CONTROL_OPERATION_FAILED');
      }
    },
  };
}

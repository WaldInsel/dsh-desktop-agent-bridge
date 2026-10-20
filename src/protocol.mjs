import { z } from 'zod';

export const PACKAGE_NAME = 'dsh-agent-collaboration';
export const VERSION = '0.1.1';
const id = z.string().min(1).max(200);
const clientId = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
export const clientPolicySchema = z.object({
  id: clientId, label: z.string().min(1).max(80),
  workspaceIds: z.array(id).max(100),
  presets: z.array(z.string().max(200)).max(100),
  models: z.array(id).max(200),
  parentInteractions: z.boolean().default(false),
}).strict();
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('takeover'), sessionId: id }).strict(),
  z.object({ type: z.literal('release'), sessionId: id }).strict(),
  z.object({ type: z.literal('stop'), sessionId: id }).strict(),
  z.object({ type: z.literal('adopt'), sessionId: id, clientId }).strict(),
  z.object({ type: z.literal('save-policy'), clients: z.array(clientPolicySchema).max(100) }).strict(),
  z.object({ type: z.literal('create-client'), id: clientId, label: z.string().min(1).max(80) }).strict(),
]);
export const selectionSchema = z.object({
  provider: id, model: id, reasoningEffort: z.string().max(80).optional(),
}).strict();
export const startSchema = z.object({
  requestId: id,
  task: z.string().min(1).max(50000),
  title: z.string().min(1).max(120).optional(),
  workspaceId: id,
  preset: z.string().max(200),
  selection: selectionSchema,
  sessionId: id.optional(),
}).strict();
export const messageSchema = z.object({
  requestId: id, sessionId: id, text: z.string().min(1).max(50000),
  mode: z.enum(['queue', 'steer']).default('steer'),
}).strict();
export const interactionResponseSchema = z.object({
  runId: id, requestId: id,
  userReply: z.string().trim().min(1).max(10000).describe('用户对本次请求的实际答复，必须先询问用户；不得自行编造或从子任务内容推断。'),
  response: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('approval'), decision: z.enum(['allowed-once', 'rejected']) }).strict(),
    z.object({
      kind: z.literal('question'),
      answers: z.array(z.object({
        id, selected: z.array(z.string().max(2000)).max(100),
        custom: z.string().max(10000).optional(),
      }).strict()).min(1).max(100),
    }).strict(),
  ]),
}).strict();
const snapshotSchema = z.object({
  version: z.string(),
  clients: z.array(z.object({ id, label: z.string() }).passthrough()),
  sessions: z.array(z.object({ sessionId: id, principal: id, control: z.enum(['agent', 'user']) }).passthrough()),
  runs: z.array(z.object({ id, status: z.string() }).passthrough()),
  catalog: z.object({
    workspaces: z.array(z.object({ workspaceId: id, path: z.string() }).passthrough()),
    models: z.array(z.object({ provider: id, model: id }).passthrough()),
    presets: z.array(z.object({ id: z.string(), label: z.string() }).passthrough()),
    sessions: z.array(z.object({ sessionId: id }).passthrough()),
  }),
  policy: z.object({ clients: z.array(clientPolicySchema) }),
});
const codec = (symbol, schema) => ({
  mode: 'strict', typeSymbol: `${PACKAGE_NAME}#${symbol}`, create: () => schema,
});
export const clientDescriptors = [
  {
    id: `${PACKAGE_NAME}#agentCollaboration/snapshot`,
    service: 'agentCollaboration', namespace: 'agentCollaboration', method: 'snapshot',
    invocation: { kind: 'direct' }, parameters: [], result: codec('Snapshot', snapshotSchema),
  },
  {
    id: `${PACKAGE_NAME}#agentCollaboration/action`,
    service: 'agentCollaboration', namespace: 'agentCollaboration', method: 'action',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('Action', actionSchema) }],
    result: codec('ActionResult', z.record(z.string(), z.unknown())),
  },
];
export const hostManifest = {
  package: PACKAGE_NAME, face: 'host', schemas: [], invocations: clientDescriptors,
  model: { services: [], events: [], objects: [] },
};

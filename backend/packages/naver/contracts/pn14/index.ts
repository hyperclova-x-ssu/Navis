// W contracts for the selected CLOVA Studio v3 models and modes.
// https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-fc
// https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3
// https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-so
// https://api.ncloud-docs.com/docs/clovastudio-tokenizerhcxv3
export type StudioModel = 'HCX-005' | 'HCX-007';
export type StudioObject = Record<string, unknown>;
export type StudioContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string } }
  | { type: 'image_url'; dataUri: { data: string } };

export type StudioTool = {
  type: 'function';
  function: { name: string; description: string; parameters?: StudioObject };
};
export type StudioToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } };
export type StudioToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: StudioObject };
};
export type StudioMessage = {
  role: 'system' | 'assistant' | 'user' | 'tool';
  content: string | StudioContentPart[];
  toolCalls?: StudioToolCall[];
  toolCallId?: string;
};
export type StudioTokenizeRequest = {
  messages: StudioMessage[];
  tools?: StudioTool[];
  toolChoice?: StudioToolChoice;
  responseFormat?: { type: 'json'; schema: StudioObject };
};
export type StudioChatRequest = StudioTokenizeRequest & {
  maxTokens?: number;
  maxCompletionTokens?: number;
  thinking?: { effort: 'none' };
  topP?: number;
  topK?: number;
  temperature?: number;
  repetitionPenalty?: number;
  seed?: number;
  stop?: string[];
  includeAiFilters?: boolean;
};
export type StudioUsage = { promptTokens: number; completionTokens: number; totalTokens: number };
export type StudioFilter = {
  groupName: 'curse' | 'unsafeContents';
  name: 'discrimination' | 'insult' | 'sexualHarassment';
  score: '-1' | '0' | '1' | '2';
  result?: 'OK' | 'ERROR';
};
export type StudioResult = {
  message: { role: 'assistant'; content: string; toolCalls?: StudioToolCall[] };
  finishReason: 'stop' | 'length' | 'tool_calls';
  created: number;
  seed: number;
  usage: StudioUsage;
  aiFilter?: StudioFilter[];
};
export type StudioStatus = { code: string; message: string };
export type StudioJsonResult = { status: StudioStatus; result: StudioResult };
export type StudioToken = {
  message: { role: 'assistant'; content: string; toolCalls?: {
    id?: string;
    type: 'function';
    function: { name: string } | { partialJson: string };
  }[] };
  finishReason: null;
  created: number;
  seed: number;
  usage: null;
};
export type StudioEvent =
  | { event: 'token'; data: StudioToken }
  | { event: 'result'; data: StudioResult }
  | { event: 'error'; data: { status: StudioStatus } };
export type StudioTokenizerResult = {
  messages: { role: StudioMessage['role']; content: (StudioContentPart & { count: number }) | (StudioContentPart & { count: number })[] }[];
  tools?: { count: number };
  responseFormat?: { count: number };
};

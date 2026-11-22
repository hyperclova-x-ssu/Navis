// https://help.naver.com/service/30026/contents/20474?lang=ko&osType=COMMONOS
export const smartCallPath = '/partner-assumed/v1/smartcall';
export const aiCallFixtureDispatchPath = '/internal/naver-virtual/v1/aicall/fixture/dispatch';
export const aiCallFixtureDispatchOperation = 'pn08.fixture.dispatch';
export interface SmartCallSettings { number050: string }
export interface CallPeriod { startDate: string; endDate: string }
export type CallResult = 'connected' | 'ars' | 'missed' | 'busy';
export interface SmartCallSummary {
  period: CallPeriod;
  channels: string[];
  daily: Array<{
    date: string; totalCalls: number; connectedCalls: number; arsCalls: number;
    missedCalls: number; busyCalls: number; averageDurationSeconds: number | null; callsAtLeastTenSeconds: number;
  }>;
}

// https://guide.ncloud-docs.com/docs/chatbot-chatbot-2-3 (Custom Condition V2.0)
export interface CustomConditionV2Request {
  userId: string;
  userKey: string;
  userVariables: Record<string, { value: string; typ: 'TEXT' | 'NUMBER' | 'JSON' }>;
}
export interface CustomConditionV2Response {
  valid: string;
  userVariable?: Array<{
    name: string | number;
    value: string;
    type: 'TEXT' | 'NUMBER' | 'JSON';
    action: 'EQ' | 'ADD' | 'SUB';
    valueType: 'TEXT' | 'NUMBER';
  }>;
}
